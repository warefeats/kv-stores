# Redis vs Valkey vs Dragonfly — KV store benchmark

In-memory key-value store comparison using [memtier_benchmark](https://github.com/RedisLabs/memtier_benchmark). Part of the [warefeats](https://warefeats.com) benchmark suite.

## Status

Scaffold complete. No published run yet — first cloud run is TODO.

## Engines

| Engine | Version | Image | Threading |
|--------|---------|-------|-----------|
| Redis | 8.8.2 | `redis:8.8.2` | Single-threaded (default `io-threads 1`) |
| Valkey | 9.1.1 | `valkey/valkey:9.1.1` | Single-threaded (default `io-threads 1`) |
| Dragonfly | 1.40.1 | `docker.dragonflydb.io/dragonflydb/dragonfly:v1.40.1` | Multi-threaded (4 threads local, explicit `--proactor_threads` on cloud) |

## Fairness configuration

All engines run with identical maxmemory and no persistence. Protocol is RESP2 (memtier default `redis` protocol, no HELLO), no TLS. Threading is left at defaults for Redis/Valkey — that IS the comparison (single-threaded Redis/Valkey I/O vs multi-threaded Dragonfly).

| Setting | Redis | Valkey | Dragonfly |
|---------|-------|--------|-----------|
| maxmemory | 1 GB local / 16 GB cloud | 1 GB local / 16 GB cloud | 1 GB local / 16 GB cloud |
| eviction | `--maxmemory-policy allkeys-lru` | `--maxmemory-policy allkeys-lru` | `--cache_mode` (DASH-based eviction) |
| persistence | `--save "" --appendonly no` | `--save "" --appendonly no` | `--dbfilename ""` (snapshots disabled) |
| threading | single-threaded (default `io-threads 1`) | single-threaded (default `io-threads 1`) | 4 threads local (`--proactor_threads 4`), explicit thread count on cloud |
| TLS | off | off | off |
| protocol | RESP2 | RESP2 | RESP2 |
| bind | `0.0.0.0` | `0.0.0.0` | `0.0.0.0` (default) |

**Why `--proactor_threads 4` locally**: Dragonfly derives its thread count from the cgroup CPU quota. At 4 allocated cores it would correctly use 4 threads, but we set it explicitly for clarity. Cloud runs set `--proactor_threads` to the engine instance's full vCPU count (default 64 for c7g.metal).

**Why 16 GB cloud maxmemory**: Dragonfly requires at least 256 MiB per proactor thread. At 64 threads that's 16 GiB minimum. All three engines use the same 16 GiB maxmemory on cloud for fairness (per-engine cloud overlays override the command). Local maxmemory stays 1 GiB (sufficient for 4 threads).

**Why `--cache_mode` instead of `allkeys-lru`**: Dragonfly does not expose `maxmemory-policy` as a CLI flag. `--cache_mode` enables eviction when nearing the maxmemory limit using Dragonfly's DASH-based algorithm, the closest equivalent to Redis/Valkey's sampled LRU.

**Eviction flags are set for parity of intent and never trigger**: Working sets are sized to stay below 50% of maxmemory in both local and cloud configurations, so no engine reaches its eviction threshold during a run. The eviction policies differ between engines (sampled LRU vs DASH-based) and the thresholds differ (Dragonfly's `eviction_memory_budget_threshold` defaults to 0.1, meaning eviction starts at ~90% capacity). By keeping well under the limit, the comparison measures throughput and memory efficiency without eviction behavior as a variable.

## Methodology

**Preload**: Before each GET-bearing workload's warmup passes, the runner fills the entire keyspace with a deterministic sequential load (`--ratio=1:0 --key-pattern=P:P`). This ensures every GET is a hit. The measured hit ratio is published per workload and asserted >= 99% in CI.

**Client sizing**: Memtier threads and clients auto-scale to the runner host in cloud mode (`max(2, nproc − 2)` threads, clients adjusted to hold ~200 total connections in full / ~20 in smoke). The `MEMTIER_THREADS` env overrides auto-detection. Client CPU utilization is sampled per pass via `/proc/stat` and published in the results — if client CPU exceeds ~80%, the client is the bottleneck and the connection count should be increased. Local runs keep the default 4 threads x 50 clients (full) to fit within Docker resource limits.

| Mode | Threads | Clients | Total connections |
|------|---------|---------|-------------------|
| Local smoke | 2 | 10 | 20 |
| Local full | 4 | 50 | 200 |
| Cloud smoke (c7g.4xlarge, 16 vCPU) | 14 | 1 | 14 |
| Cloud full (c7g.4xlarge, 16 vCPU) | 14 | 14 | 196 |

**Distinct client seed**: Every memtier invocation uses `--distinct-client-seed` so parallel clients access different keys, avoiding artificial hot-key contention.

**Memory measurement**: The memory-per-key workload runs FIRST on a fresh engine. An empty-engine baseline of both `used_memory` and cgroup RSS is recorded before loading keys. Results report the delta; RSS delta is the primary metric (allocator-neutral).

## Workloads

- **W1 — Small value throughput**: SET/GET mix (1:10 ratio), 100-byte values, pipeline depth 1. Measures raw request throughput and tail latency.
- **W2 — Large value throughput**: SET/GET mix (1:10 ratio), 10 KB values, pipeline depth 1. Working set sized at 40K keys (~480 MB) to stay below 50% of local maxmemory.
- **W3 — Pipeline effect**: Same as W1 at pipeline depth 30. The section candidate statistic uses pipeline-30 throughput; pipeline-1 numbers come from W1 for comparison.
- **W4 — Memory efficiency**: Loads 1M keys (100-byte values) into a fresh engine, measures baseline-corrected used_memory and RSS, reports bytes-per-key with RSS delta as primary.

## Requirements

- [Bun](https://bun.sh) 1.4+
- Docker with Compose v2 (arm64 or amd64)
- `just` (optional, for recipes)

## Running locally

```bash
bun install

# Smoke test (1 warmup + 2 measured passes, short durations)
bun run src/run.ts --smoke

# Full benchmark (2 warmup + 10 measured passes)
bun run src/run.ts

# Single engine
bun run src/run.ts --smoke --engine=redis

# Single workload
bun run src/run.ts --smoke --workload=set-get-small

# Resume a partial run
bun run src/run.ts --smoke --resume
```

Results are written to `results.json` (gitignored). Use `--output=<path>` to write elsewhere.

## Publishing flow

1. Run the benchmark (local or cloud). The runner writes `results.json`.
2. Import the run: `bun run src/import.ts --results=results.json` writes a file under `runs/` and appends it to `benchmark.json`.
3. Commit and merge the run file + updated `benchmark.json`.
4. In the site repo (`warefeats/warefeats.com`): bump this benchmark's `ref` in `web/data/registry.json` to the merge commit SHA, run `bun run sync`, commit registry + cache, merge, deploy.

**Do NOT pin this repo in the site registry until a run file exists.** The site's `sync` throws on `runs.length === 0`, which would break the build for all benchmarks.

## Cloud rig

Two arm64 EC2 instances in a cluster placement group:

| Role | Instance | Purpose |
|------|----------|---------|
| Engine | c7g.metal | Runs the KV store container with `network_mode: host`, no resource limits |
| Client | c7g.4xlarge (configurable) | Runs memtier_benchmark via `docker run --network host` against engine IP |

Engine is started via compose on the engine instance (with per-engine cloud overlays for 16 GiB maxmemory). Client runs memtier directly — no compose on the client in cloud mode.

**Cost estimate**: c7g.metal ~$2.30/hr + c7g.4xlarge ~$0.58/hr = ~$2.88/hr. Smoke run ~20 min = ~$1.00, full run ~1 hr = ~$2.90. Double-check current on-demand pricing before dispatch.

**Guardrails**: 2-hour auto-shutdown via user data, `if: always()` terminate step, reaper job (runs after every bench, terminates instances older than 3 hours), concurrency group prevents stacking.

### Setup

```bash
just setup-oidc        # one-time OIDC role + GH secret
just rig-deploy        # CDK deploy
just rig-cloud         # trigger cloud run (defaults to smoke)
just rig-watch         # tail the run
just rig-results       # list S3 results
just rig-destroy       # tear down (optional)
```

### Cloud results import

```bash
# Download from S3 or GH artifact, then:
bun run src/import-run.ts --results=results.json --metadata=metadata.json
```

## Tests

```bash
bun run check   # type-check
bun test        # unit tests
```

## License

MIT
