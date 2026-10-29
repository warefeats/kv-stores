import type { RawResult, RawResults, RunMetadata } from "../src/import-run.js";

export function makeResult(engine: string, workload: string, overrides?: Partial<RawResult>): RawResult {
  return {
    label: `${engine}/${workload}`,
    engine,
    workload,
    opsPerSec: 120000,
    p50Ms: 0.2,
    p99Ms: 0.8,
    p999Ms: 1.5,
    samplesOpsPerSec: [118000, 122000],
    samplesP99Ms: [0.75, 0.85],
    engineStats: { rssMb: 12, usedMemoryMb: 8, usedMemoryRssMb: 12, keyCount: 100000, hitRatio: 0.999 },
    metrics: { throughput: { value: 120000, unit: "ops/s", label: "Throughput" } },
    config: { engineImage: "redis:8.8.2", maxmemoryBytes: 1073741824, threads: 1, memtierVersion: "2.5.1", cloudMode: false },
    ...overrides,
  };
}

export function makeMemoryResult(engine: string, overrides?: Partial<RawResult>): RawResult {
  return makeResult(engine, "memory-load", {
    opsPerSec: 0,
    p50Ms: 0,
    p99Ms: 0,
    p999Ms: 0,
    samplesOpsPerSec: [0],
    samplesP99Ms: [0],
    engineStats: { rssMb: 25, usedMemoryMb: 18, usedMemoryRssMb: 25, keyCount: 1000000, hitRatio: 0 },
    metrics: {
      rssDeltaMb: { value: 23.5, unit: "MB", label: "RSS (delta)" },
      usedMemoryDeltaMb: { value: 16.5, unit: "MB", label: "Used memory (delta)" },
      baselineRssMb: { value: 1.5, unit: "MB", label: "Baseline RSS" },
      baselineUsedMb: { value: 1.5, unit: "MB", label: "Baseline used memory" },
      keyCount: { value: 1000000, unit: "keys", label: "Key count" },
      bytesPerKeyRss: { value: 24.7, unit: "B/key", label: "Memory per key (RSS)" },
      bytesPerKeyUsed: { value: 17.3, unit: "B/key", label: "Memory per key (used_memory)" },
    },
    ...overrides,
  });
}

export const SAMPLE_RESULTS: RawResults = {
  generatedAt: "2026-08-30T12:00:00.000Z",
  smoke: true,
  sessionCount: 16,
  resultCount: 16,
  failureCount: 0,
  results: [
    makeResult("redis", "set-get-small"),
    makeResult("valkey", "set-get-small", { opsPerSec: 115000, samplesOpsPerSec: [113000, 117000], samplesP99Ms: [0.88, 0.92] }),
    makeResult("dragonfly", "set-get-small", { opsPerSec: 350000, samplesOpsPerSec: [340000, 360000], samplesP99Ms: [0.28, 0.32] }),
    makeResult("kividb", "set-get-small", { opsPerSec: 380000, samplesOpsPerSec: [370000, 390000], samplesP99Ms: [0.24, 0.26] }),
    makeResult("redis", "set-get-large", { opsPerSec: 60000 }),
    makeResult("valkey", "set-get-large", { opsPerSec: 58000 }),
    makeResult("dragonfly", "set-get-large", { opsPerSec: 90000 }),
    makeResult("kividb", "set-get-large", { opsPerSec: 95000 }),
    makeResult("redis", "pipeline-30", { opsPerSec: 900000, samplesOpsPerSec: [880000, 920000] }),
    makeResult("valkey", "pipeline-30", { opsPerSec: 850000, samplesOpsPerSec: [830000, 870000] }),
    makeResult("dragonfly", "pipeline-30", { opsPerSec: 2500000, samplesOpsPerSec: [2400000, 2600000] }),
    makeResult("kividb", "pipeline-30", { opsPerSec: 2700000, samplesOpsPerSec: [2650000, 2750000] }),
    makeMemoryResult("redis"),
    makeMemoryResult("valkey", { metrics: { ...makeMemoryResult("valkey").metrics, rssDeltaMb: { value: 24.0, unit: "MB", label: "RSS (delta)" } } }),
    makeMemoryResult("dragonfly", { metrics: { ...makeMemoryResult("dragonfly").metrics, rssDeltaMb: { value: 58.5, unit: "MB", label: "RSS (delta)" } } }),
    makeMemoryResult("kividb", { metrics: { ...makeMemoryResult("kividb").metrics, rssDeltaMb: { value: 31.0, unit: "MB", label: "RSS (delta)" } } }),
  ],
  failures: [],
};

export const SAMPLE_META: RunMetadata = {
  id: "",
  label: "M2 Max (local)",
  publishedAt: "2026-08-30",
  environment: {
    machine: "Apple Mac Studio",
    chip: "Apple M2 Max",
    cores: "12 CPU cores",
    memory: "96 GB",
    os: "macOS (Docker via OrbStack)",
    arch: "arm64",
    runtime: "Docker Compose",
  },
  protocol: {
    warmups: 1,
    runs: 2,
    processModel: "container-per-engine",
    cacheState: "n/a",
    output: "memtier_benchmark JSON (RESP2, no TLS)",
  },
};
