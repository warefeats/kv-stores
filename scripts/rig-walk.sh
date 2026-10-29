#!/usr/bin/env bash
#
# Offline end-to-end validation of the cloud benchmark rig.
# Runs the user-data script and SSM command checks inside
# docker run --platform linux/arm64 ubuntu:24.04.
#
# Requires: docker (arm64 capable), dash (for syntax checks)
#
set -euo pipefail

CONTAINER="kv-bench-walk-$$"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "=== Step 1: User data ==="
echo "Starting ubuntu:24.04 arm64 container..."
docker run -d --name "$CONTAINER" --platform linux/arm64 ubuntu:24.04 sleep infinity >/dev/null

docker exec "$CONTAINER" bash -c '
cat > /usr/local/bin/shutdown <<STUB
#!/bin/sh
echo "STUB: shutdown \$*"
STUB
chmod +x /usr/local/bin/shutdown

cat > /usr/local/bin/systemctl <<STUB
#!/bin/sh
echo "STUB: systemctl \$*"
STUB
chmod +x /usr/local/bin/systemctl
'

START=$(date +%s)
docker exec "$CONTAINER" bash -c '
set -euxo pipefail
shutdown -h +120
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io docker-compose-v2 docker-buildx jq curl git unzip redis-tools
systemctl enable docker && systemctl start docker
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install
rm -rf /tmp/awscliv2.zip /tmp/aws
curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
git clone --depth 1 https://github.com/warefeats/kv-stores.git /opt/bench
cd /opt/bench && /usr/local/bin/bun install --frozen-lockfile
'
END=$(date +%s)
ELAPSED=$((END - START))
echo ""
echo "user-data completed in ${ELAPSED}s"

echo ""
echo "verifying binaries..."
docker exec "$CONTAINER" bash -c '
OK=0; FAIL=0
check() { if [ -x "$1" ]; then echo "  OK  $1"; OK=$((OK+1)); else echo "  MISS $1"; FAIL=$((FAIL+1)); fi; }
check /usr/bin/docker
check /usr/bin/git
check /usr/bin/jq
check /usr/bin/redis-cli
check /usr/local/bin/bun
check /usr/local/bin/aws
test -d /opt/bench/node_modules && echo "  OK  /opt/bench/node_modules" || { echo "  MISS /opt/bench/node_modules"; FAIL=$((FAIL+1)); }
docker compose version >/dev/null 2>&1 && echo "  OK  docker compose plugin" || { echo "  MISS docker compose plugin"; FAIL=$((FAIL+1)); }
if [ "$FAIL" -gt 0 ]; then echo "FAIL: $FAIL checks failed"; exit 1; fi
echo "all binaries verified"
'

echo ""
echo "=== Step 2: SSM command syntax ==="
bash "$SCRIPT_DIR/render-ssm.sh" /tmp/ssm-walk

echo ""
echo "=== Step 2b: readiness gate under dash ==="
docker exec "$CONTAINER" dash /tmp/ssm-walk/01-readiness-gate.sh 2>/dev/null || true
docker cp /tmp/ssm-walk/01-readiness-gate.sh "$CONTAINER:/tmp/gate.sh"
docker exec "$CONTAINER" dash /tmp/gate.sh && echo "  readiness gate: PASS" || echo "  readiness gate: FAIL"

echo ""
echo "=== Step 3: Compose config (cloud mode) ==="
for ENGINE in redis valkey dragonfly kividb; do
  echo -n "  $ENGINE: "
  docker exec -w /opt/bench "$CONTAINER" bash -c "
    ENGINE_THREADS=64 docker compose \
      -f compose/docker-compose.${ENGINE}.yml \
      -f compose/cloud-overlay.yml \
      -f compose/cloud-${ENGINE}.yml \
      config >/dev/null 2>&1
  " && echo "OK" || echo "FAIL"
done

echo ""
echo "=== Summary ==="
echo "readiness floor: ${ELAPSED}s"
echo "all checks passed"
