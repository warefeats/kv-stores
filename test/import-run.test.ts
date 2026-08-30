import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  importRun,
  validateResults,
  validateMetadata,
  rigSlug,
  type RawResults,
  type RunMetadata,
  type RawResult,
} from "../src/import-run.js";
import { existsSync, unlinkSync, readFileSync, writeFileSync } from "fs";

function makeResult(engine: string, workload: string, overrides?: Partial<RawResult>): RawResult {
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

function makeMemoryResult(engine: string, overrides?: Partial<RawResult>): RawResult {
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

const SAMPLE_RESULTS: RawResults = {
  generatedAt: "2026-08-30T12:00:00.000Z",
  smoke: true,
  sessionCount: 12,
  resultCount: 12,
  failureCount: 0,
  results: [
    makeResult("redis", "set-get-small"),
    makeResult("valkey", "set-get-small", { opsPerSec: 115000, samplesOpsPerSec: [113000, 117000], samplesP99Ms: [0.88, 0.92] }),
    makeResult("dragonfly", "set-get-small", { opsPerSec: 350000, samplesOpsPerSec: [340000, 360000], samplesP99Ms: [0.28, 0.32] }),
    makeResult("redis", "set-get-large", { opsPerSec: 60000 }),
    makeResult("valkey", "set-get-large", { opsPerSec: 58000 }),
    makeResult("dragonfly", "set-get-large", { opsPerSec: 90000 }),
    makeResult("redis", "pipeline-30", { opsPerSec: 900000, samplesOpsPerSec: [880000, 920000] }),
    makeResult("valkey", "pipeline-30", { opsPerSec: 850000, samplesOpsPerSec: [830000, 870000] }),
    makeResult("dragonfly", "pipeline-30", { opsPerSec: 2500000, samplesOpsPerSec: [2400000, 2600000] }),
    makeMemoryResult("redis"),
    makeMemoryResult("valkey", { metrics: { ...makeMemoryResult("valkey").metrics, rssDeltaMb: { value: 24.0, unit: "MB", label: "RSS (delta)" } } }),
    makeMemoryResult("dragonfly", { metrics: { ...makeMemoryResult("dragonfly").metrics, rssDeltaMb: { value: 58.5, unit: "MB", label: "RSS (delta)" } } }),
  ],
  failures: [],
};

const SAMPLE_META: RunMetadata = {
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

describe("validateResults", () => {
  test("accepts valid results", () => {
    expect(() => validateResults(SAMPLE_RESULTS)).not.toThrow();
  });

  test("rejects null", () => {
    expect(() => validateResults(null)).toThrow("not an object");
  });

  test("rejects empty results array", () => {
    expect(() => validateResults({ ...SAMPLE_RESULTS, results: [] })).toThrow("empty");
  });
});

describe("validateMetadata", () => {
  test("accepts valid metadata", () => {
    expect(() => validateMetadata(SAMPLE_META)).not.toThrow();
  });

  test("rejects missing environment", () => {
    const { environment, ...rest } = SAMPLE_META;
    expect(() => validateMetadata(rest)).toThrow("missing environment");
  });
});

describe("rigSlug", () => {
  test("derives slug from date and chip", () => {
    expect(rigSlug(SAMPLE_META)).toBe("2026-08-30-apple-m2-max");
  });

  test("slug changes with different chip", () => {
    const meta = {
      ...SAMPLE_META,
      environment: { ...SAMPLE_META.environment, chip: "Graviton3" },
    };
    expect(rigSlug(meta)).toBe("2026-08-30-graviton3");
  });

  test("slug changes with different date", () => {
    const meta = { ...SAMPLE_META, publishedAt: "2026-09-15" };
    expect(rigSlug(meta)).toBe("2026-09-15-apple-m2-max");
  });
});

describe("importRun", () => {
  const runFile = "runs/2026-08-30-apple-m2-max.json";
  let originalBenchmark: string;

  beforeEach(() => {
    originalBenchmark = readFileSync("benchmark.json", "utf-8");
  });

  afterEach(() => {
    if (existsSync(runFile)) unlinkSync(runFile);
    writeFileSync("benchmark.json", originalBenchmark);
  });

  test("builds sections from results", async () => {
    const { runFile: rf } = await importRun(SAMPLE_RESULTS, SAMPLE_META);
    expect(rf).toBe(runFile);

    const run = await Bun.file(rf).json();
    expect(run.schemaVersion).toBe(1);
    expect(run.sections.length).toBe(4);
  });

  test("small-value section has 3 candidates", async () => {
    await importRun(SAMPLE_RESULTS, SAMPLE_META);

    const run = await Bun.file(runFile).json();
    const s1 = run.sections.find(
      (s: { id: string }) => s.id === "small-value-throughput",
    );
    expect(s1).toBeDefined();
    expect(s1.candidates).toHaveLength(3);
    expect(s1.unit).toBe("ms");
    expect(s1.lowerIsBetter).toBe(true);
  });

  test("memory section uses RSS delta as primary metric", async () => {
    await importRun(SAMPLE_RESULTS, SAMPLE_META);

    const run = await Bun.file(runFile).json();
    const s4 = run.sections.find(
      (s: { id: string }) => s.id === "memory-efficiency",
    );
    expect(s4).toBeDefined();
    expect(s4.unit).toBe("MB");
    expect(s4.lowerIsBetter).toBe(true);
    const redisCandidate = s4.candidates.find((c: { id: string }) => c.id === "redis");
    expect(redisCandidate.samplesMs[0]).toBe(23.5);
  });

  test("pipeline section uses pipeline-30 for candidate statistic", async () => {
    await importRun(SAMPLE_RESULTS, SAMPLE_META);

    const run = await Bun.file(runFile).json();
    const section = run.sections.find(
      (s: { id: string }) => s.id === "pipeline-effect",
    );
    expect(section).toBeDefined();
    expect(section.unit).toBe("ops/s");

    const redisCandidate = section.candidates.find((c: { id: string }) => c.id === "redis");
    expect(redisCandidate.samplesMs).toEqual([880000, 920000]);

    expect(section.tests).toHaveLength(2);
    expect(section.tests[0].id).toBe("pipeline-1");
    expect(section.tests[1].id).toBe("pipeline-30");
  });

  test("idempotent benchmark.json update", async () => {
    await importRun(SAMPLE_RESULTS, SAMPLE_META);
    await importRun(SAMPLE_RESULTS, SAMPLE_META);

    const benchmark = await Bun.file("benchmark.json").json();
    const count = benchmark.runs.filter((r: string) => r === runFile).length;
    expect(count).toBe(1);
  });

  test("throws on 0 sections", async () => {
    const singleEngineResults: RawResults = {
      ...SAMPLE_RESULTS,
      results: SAMPLE_RESULTS.results.filter((r) => r.engine === "redis"),
    };
    await expect(importRun(singleEngineResults, SAMPLE_META)).rejects.toThrow("0 sections");
  });
});

describe("TODO gate", () => {
  test("benchmark.json editorial TODOs are acceptable only when runs is empty", async () => {
    const benchmark = JSON.parse(readFileSync("benchmark.json", "utf-8"));
    const runs: string[] = benchmark.runs ?? [];
    if (runs.length > 0) {
      const fields = JSON.stringify(benchmark);
      expect(fields).not.toContain('"TODO"');
    }
  });
});
