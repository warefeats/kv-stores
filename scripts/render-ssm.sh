#!/usr/bin/env bash
#
# Render and syntax-check every SSM command the cloud workflow sends.
# Run inside a container matching the instance image (ubuntu:24.04 arm64)
# or directly on macOS — the dash -n check works either way; the compose
# config step needs docker compose.
#
set -euo pipefail

OUT=${1:-/tmp/ssm-scripts}
mkdir -p "$OUT"

# Stub values matching workflow defaults
ENGINE_IP="10.0.0.9"
ENGINE_THREADS="64"
BUCKET="test-bucket"
GHCR_TOKEN="ghs_stub"
RUN_ID="kv-bench-20260101-000000-1"
ENGINES="redis valkey dragonfly kividb"
SMOKE_FLAG="--smoke"
SSM_PATH="export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# --- Readiness gate (runs on both engine + client) ---
cat > "$OUT/01-readiness-gate.sh" <<SCRIPT
${SSM_PATH}
set -e
for i in \$(seq 1 90); do if [ -x /usr/bin/docker ] && [ -x /usr/local/bin/bun ] && [ -d /opt/bench/node_modules ]; then exit 0; fi; sleep 10; done; echo user data not finished >&2; tail -n 40 /var/log/cloud-init-output.log >&2; exit 1
SCRIPT

# --- GHCR login (client) ---
cat > "$OUT/02-ghcr-login.sh" <<SCRIPT
${SSM_PATH}
set -e
echo ${GHCR_TOKEN} | docker login ghcr.io -u x --password-stdin && docker pull ghcr.io/warefeats/memtier-benchmark:2.5.1
SCRIPT

for ENGINE in $ENGINES; do
  CF="-f compose/docker-compose.${ENGINE}.yml -f compose/cloud-overlay.yml -f compose/cloud-${ENGINE}.yml"

  # --- Engine up ---
  cat > "$OUT/03-engine-up-${ENGINE}.sh" <<SCRIPT
${SSM_PATH}
set -e
cd /opt/bench && ENGINE_THREADS=${ENGINE_THREADS} docker compose ${CF} -p kv-${ENGINE} up -d engine --wait --wait-timeout 120
SCRIPT

  # --- Engine startup log ---
  cat > "$OUT/03b-engine-log-${ENGINE}.sh" <<SCRIPT
${SSM_PATH}
set -e
cd /opt/bench && for i in \$(seq 1 60); do redis-cli -p 6379 ping 2>/dev/null | grep -q PONG && break; sleep 1; done; docker compose ${CF} -p kv-${ENGINE} logs --no-color engine | head -n 80
SCRIPT

  # --- Client run ---
  cat > "$OUT/04-client-run-${ENGINE}.sh" <<SCRIPT
${SSM_PATH}
set -e
cd /opt/bench && ENGINE_HOST=${ENGINE_IP} CLOUD_MODE=1 MEMTIER_IMAGE=ghcr.io/warefeats/memtier-benchmark:2.5.1 bun run src/run.ts --engine=${ENGINE} ${SMOKE_FLAG} --resume --output=/tmp/results.json
SCRIPT

  # --- Engine down ---
  cat > "$OUT/05-engine-down-${ENGINE}.sh" <<SCRIPT
${SSM_PATH}
set -e
cd /opt/bench && docker compose ${CF} -p kv-${ENGINE} down -v --remove-orphans
SCRIPT
done

# --- Results upload (client) ---
cat > "$OUT/06-results-upload.sh" <<SCRIPT
${SSM_PATH}
set -e
aws s3 cp /tmp/results.json s3://${BUCKET}/bench-runs/${RUN_ID}/results.json
SCRIPT

echo "rendered $(ls "$OUT"/*.sh | wc -l | tr -d ' ') scripts to $OUT"

FAIL=0
for f in "$OUT"/*.sh; do
  if dash -n "$f" 2>&1; then
    echo "  PASS  $(basename "$f")"
  else
    echo "  FAIL  $(basename "$f")"
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo "dash syntax errors found" >&2
  exit 1
fi
