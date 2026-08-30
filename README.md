# Redis vs Valkey vs Dragonfly — KV store benchmark

In-memory key-value store comparison using [memtier_benchmark](https://github.com/RedisLabs/memtier_benchmark). Part of the [warefeats](https://warefeats.com) benchmark suite.

## Status

Scaffold complete. No published run yet — first cloud run is TODO.

## Engines

| Engine | Version | Image | Threading |
|--------|---------|-------|-----------|
| Redis | 8.8.2 | `redis:8.8.2` | Single-threaded (default) |
| Valkey | 9.1.1 | `valkey/valkey:9.1.1` | Single-threaded (default) |
| Dragonfly | 1.40.1 | `docker.dragonflydb.io/dragonflydb/dragonfly:v1.40.1` | Multi-threaded (default, all cores) |

## Fairness configuration

All engines run with identical maxmemory and no persistence. Threading is left at defaults — that IS the comparison (single-threaded Redis/Valkey I/O vs multi-threaded Dragonfly).

| Setting | Redis | Valkey | Dragonfly |
|---------|-------|--------|-----------|
| maxmemory | 1 GB (`--maxmemory 1gb`) | 1 GB (`--maxmemory 1gb`) | 1 GB (`--maxmemory 1073741824`) |
| eviction | `--maxmemory-policy allkeys-lru` | `--maxmemory-policy allkeys-lru` | `--cache_mode` (DASH-based eviction) |
| persistence | `--save "" --appendonly no` | `--save "" --appendonly no` | no `--dbfilename` (snapshots disabled) |
| threading | single-threaded (default `io-threads 1`) | single-threaded (default `io-threads 1`) | multi-threaded (4 threads local, all cores on cloud) |
| TLS | off | off | off |
| bind | `0.0.0.0` | `0.0.0.0` | `0.0.0.0` (default) |

**Why 1 GB maxmemory**: Dragonfly requires ~256 MiB per proactor thread as minimum memory. At 4 threads (local) that's 1 GiB minimum. All engines use the same value for fairness.

**Why `--proactor_threads 4` locally**: Dragonfly defaults to one thread per core. Docker CPU limits throttle but don't hide cores, so Dragonfly would spawn 12 threads on an M2 Max while only getting 4 cores of CPU time. Clamping to 4 matches the resource limit. Cloud runs omit this flag — Dragonfly uses all 64 cores on c7g.metal.

**Why `--cache_mode` instead of `allkeys-lru`**: Dragonfly does not expose `maxmemory-policy` as a CLI flag. `--cache_mode` enables eviction when nearing the maxmemory limit using Dragonfly's DASH-based algorithm, the closest equivalent to Redis/Valkey's sampled LRU.

## Workloads

- **W1 — Small value throughput**: SET/GET mix (1:10 ratio), 100-byte values, pipeline depth 1. Measures raw request throughput and tail latency.
- **W2 — Large value throughput**: SET/GET mix (1:10 ratio), 10 KB values, pipeline depth 1. Tests how engines handle larger payloads.
- **W3 — Pipeline effect**: Same as W1 but compares pipeline depth 1 vs 30. Measures how much each engine benefits from client-side pipelining.
- **W4 — Memory efficiency**: Loads N keys (100-byte values), then measures used_memory, RSS, and bytes-per-key. No sustained load — measures memory overhead per key.

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
4. In the site repo (`warefeats/warefeats.com`): bump this benchmark's `ref` in `web/data/registry.json` to the merge commit SHA, run `bun run sync`, commit registry + cache, merge → deploy.

## Cloud rig

Two arm64 EC2 instances in a cluster placement group:

| Role | Instance | Purpose |
|------|----------|---------|
| Engine | c7g.metal | Runs the KV store container with no resource limits |
| Client | c7g.xlarge | Runs memtier_benchmark, connects to engine over private network |

No origin instance needed (unlike the HTTP proxy benchmark) — the client talks directly to the engine.

The account's vCPU quota is already 1920 — no quota request needed.

**Cost estimate**: ~$0.50/hr smoke, ~$1.50/hr full (2 instances vs proxy bench's 3).

**Guardrails**: 2-hour auto-shutdown via user data, if:always terminate step, stale-instance reaper (>3h), concurrency group prevents stacking.

### Setup

```bash
just setup-oidc        # one-time OIDC role + GH secret
just rig-deploy        # CDK deploy
just rig-cloud         # trigger cloud run (or use workflow_dispatch in GH UI)
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
