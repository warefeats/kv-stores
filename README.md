# KV store benchmark: Redis vs Valkey vs Dragonfly vs KiviDB

In-memory key-value store comparison using [memtier_benchmark](https://github.com/RedisLabs/memtier_benchmark). Part of the [warefeats](https://warefeats.com) benchmark suite.

## Published runs

- 2026-08-31: AWS Graviton3 cloud rig (c7g.metal engine + c7g.4xlarge client, cluster placement group) with Redis, Valkey and Dragonfly. Full run: 2 warmups, 10 measured passes per engine per workload. See [`runs/2026-08-31-aws-graviton3.json`](runs/2026-08-31-aws-graviton3.json) and [the post](https://warefeats.com/posts/2026-08-31-kv-stores-redis-vs-valkey-vs-dragonfly/).
- 2026-10-29: AWS Graviton3 cloud rig (c7g.metal engine + c7g.16xlarge client, cluster placement group) with KiviDB as a fourth engine. Two full runs, each 2 warmups and 10 measured passes per engine per workload: [`runs/2026-10-29-aws-graviton3.json`](runs/2026-10-29-aws-graviton3.json) allows io_uring through seccomp and is the run [the post](https://warefeats.com/posts/2026-10-29-kv-stores-redis-vs-valkey-vs-dragonfly-vs-kividb/) draws, and [`runs/2026-10-29-aws-graviton3-docker-seccomp.json`](runs/2026-10-29-aws-graviton3-docker-seccomp.json) keeps Docker's default seccomp profile, which blocks it.

## Engines

| Engine | Version | Image | Threading |
|--------|---------|-------|-----------|
| Redis | 8.10.3 | `redis:8.10.3` | Single-threaded (default `io-threads 1`) |
| Valkey | 9.1.3 | `valkey/valkey:9.1.3` | Single-threaded (default `io-threads 1`) |
| Dragonfly | 2.0.2 | `docker.dragonflydb.io/dragonflydb/dragonfly:v2.0.2` | Multi-threaded (4 threads local, 64 on cloud via `--proactor_threads 64`) |
| KiviDB | 1.1.2 | `kividb/kividb:v1.1.2` | Multi-threaded (4 threads local, its default of cores − 2 on cloud: 62 on the c7g.metal) |

## Fairness configuration

All engines run with identical maxmemory and no persistence. Protocol is RESP2 (memtier default `redis` protocol, no HELLO), no TLS. Threading is left at defaults for Redis/Valkey — that IS the comparison (single-threaded Redis/Valkey I/O vs multi-threaded Dragonfly and KiviDB).

| Setting | Redis | Valkey | Dragonfly | KiviDB |
|---------|-------|--------|-----------|--------|
| maxmemory | 1 GB local / 16 GB cloud | 1 GB local / 16 GB cloud | 1 GB local / 16 GB cloud | 1 GB local / 16 GB cloud |
| eviction | `--maxmemory-policy allkeys-lru` | `--maxmemory-policy allkeys-lru` | `--cache_mode` (DASH-based eviction) | `--maxmemory-policy allkeys-lru` |
| persistence | `--save "" --appendonly no` | `--save "" --appendonly no` | `--dbfilename ""` (snapshots disabled) | off by default (no AOF, no scheduled snapshots) |
| threading | single-threaded (default `io-threads 1`) | single-threaded (default `io-threads 1`) | 4 threads local (`--proactor_threads 4`), 64 on cloud (`--proactor_threads 64`, its default on 64 cores) | 4 threads local (`--threads 4`), 62 on cloud (default `--threads 0`, cores − 2) |
| TLS | off | off | off | off |
| protocol | RESP2 | RESP2 | RESP2 | RESP2 |
| bind | `0.0.0.0` | `0.0.0.0` | `0.0.0.0` (default) | `0.0.0.0` with `--protected-mode no` |
| seccomp | Docker default local / default plus io_uring cloud | Docker default local / default plus io_uring cloud | Docker default local / default plus io_uring cloud | Docker default local / default plus io_uring cloud |

**Why `--proactor_threads 4` locally**: Dragonfly derives its thread count from the cgroup CPU quota. At 4 allocated cores it would correctly use 4 threads, but we set it explicitly for clarity. Cloud runs set `--proactor_threads` to the engine instance's full vCPU count (default 64 for c7g.metal).

**Why KiviDB runs its default thread count**: KiviDB's default, `--threads 0`, resolves to the core count minus two, which is 62 on the c7g.metal's 64 cores. Each engine runs its shipped default thread count on the same box: Dragonfly's explicit 64 equals its own default, and Redis and Valkey ship single-threaded I/O. So the cloud overlay sets no `--threads`, and the cloud workflow prints each engine's startup log, which puts the count KiviDB resolved (`Worker threads : N`) in the run's Actions log. Locally it gets `--threads 4`, the same explicit 4 as Dragonfly.

**Why the cloud rig allows io_uring through seccomp**: Docker 25 and later deny the io_uring system calls in their default seccomp profile. Under it, Dragonfly falls back to epoll and KiviDB to tokio, with only a log line to say so, so neither runs the I/O path it ships for. The cloud overlay runs every engine with Docker's default profile plus `io_uring_setup`, `io_uring_enter` and `io_uring_register` ([`compose/seccomp-io-uring.json`](compose/seccomp-io-uring.json): the profile Docker 29.1.3 ships, from moby/profiles seccomp v0.1.0 under Apache-2.0, with that one rule added), and with `memlock` unlimited as Dragonfly's Docker docs recommend. Redis and Valkey have no io_uring code path, so it changes nothing for them. The 2026-10-29 run under Docker's default profile is published beside the io_uring run, so readers who keep the default can see what it costs each engine. Local runs keep Docker's default profile.

**Why 16 GB cloud maxmemory**: Dragonfly requires at least 256 MiB per proactor thread. At 64 threads that's 16 GiB minimum. All four engines use the same 16 GiB maxmemory on cloud for fairness (per-engine cloud overlays override the command). Local maxmemory stays 1 GiB (sufficient for 4 threads).

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
| Cloud smoke, 2026-10-29 (c7g.16xlarge, 64 vCPU, `MEMTIER_THREADS=50`) | 50 | 1 | 50 |
| Cloud full, 2026-10-29 (c7g.16xlarge, 64 vCPU, `MEMTIER_THREADS=50`) | 50 | 4 | 200 |

**Distinct client seed**: Every memtier invocation uses `--distinct-client-seed` so parallel clients access different keys, avoiding artificial hot-key contention.

**Memory measurement**: The memory-per-key workload runs FIRST on a fresh engine. An empty-engine baseline of INFO `used_memory` and `used_memory_rss` (the engine's process RSS) is recorded before loading keys. Results report the delta; RSS delta is the primary metric (allocator-neutral). The load then runs a second time, on the next million keys, and that load's own delta is reported beside the first's: an engine that sizes its tables or touches its arenas at startup has used them up by then, so the second million is what a key costs once the engine is running (Dragonfly at 64 threads measured 118 B/key on its first million and 147 on its second). The absolute RSS after the first million is reported too. The random-bytes cell repeats the load on a fresh engine, since RSS doesn't return to its baseline after FLUSHALL.

## Workloads

- **W1 — Small value throughput**: SET/GET mix (1:10 ratio), 100-byte values, pipeline depth 1. Measures raw request throughput and tail latency.
- **W2 — Large value throughput**: SET/GET mix (1:10 ratio), 10 KB values, pipeline depth 1. Working set sized at 40K keys (~480 MB) to stay below 50% of local maxmemory.
- **W3 — Pipeline effect**: Same as W1 at pipeline depth 30. The section candidate statistic uses pipeline-30 throughput; pipeline-1 numbers come from W1 for comparison.
- **W4 — Memory efficiency**: Loads 1M keys (100-byte values, memtier's default fill of ASCII `x` bytes) into a fresh engine, measures baseline-corrected used_memory and RSS, reports bytes-per-key with RSS delta as primary, then loads the next 1M keys and reports that load's own bytes-per-key and the absolute RSS after the first million beside it. The section ranks on the first million's RSS delta. Dragonfly packs an all-ASCII value into 7 bits per byte, so this cell stores its values in 88 bytes where the others store 100.
- **W5 — Memory efficiency, random bytes**: W4 again with memtier's `--random-data`, values no engine packs, on a fresh engine of its own: the runner restarts the engine for it locally, and the cloud workflow starts the engine a second time. Shown beside W4 in the memory section, which ranks on W4.

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
| Client | c7g.4xlarge by default (configurable; the 2026-10-29 runs used c7g.16xlarge) | Runs memtier_benchmark via `docker run --network host` against engine IP |

Engine is started via compose on the engine instance (with per-engine cloud overlays for 16 GiB maxmemory). Client runs memtier directly — no compose on the client in cloud mode. Each engine starts twice: once for the matrix, and once more for the random-bytes memory cell, which needs a fresh engine; the client defers that cell when the engine has already served a workload, and the workflow runs it alone after the restart.

**Cost estimate** (us-east-1 on-demand, checked 2026-10-29): c7g.metal $2.32/hr, plus the client at $0.58/hr as a c7g.4xlarge or $2.32/hr as the c7g.16xlarge the 2026-10-29 runs used, so the rig costs $2.90/hr or $4.64/hr. With the c7g.16xlarge client a smoke took about 7.5 minutes ($0.57) and a four-engine full run about 32 minutes ($2.51), before the second engine start per engine that the random-bytes memory cell adds, and the second load each memory cell makes. Double-check current on-demand pricing before dispatch.

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
