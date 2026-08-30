import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  importRun,
  validateResults,
  validateMetadata,
  rigSlug,
  type RawResults,
  type RunMetadata,
} from "../src/import-run.js";
import { existsSync, unlinkSync, readFileSync, writeFileSync } from "fs";

const SAMPLE_RESULTS: RawResults = {
  generatedAt: "2026-08-30T12:00:00.000Z",
  smoke: true,
  sessionCount: 15,
  resultCount: 15,
  failureCount: 0,
  results: [
    {
      label: "redis/set-get-small",
      engine: "redis",
      workload: "set-get-small",
      opsPerSec: 120000,
      p50Ms: 0.2,
      p99Ms: 0.8,
      p999Ms: 1.5,
      samplesOpsPerSec: [118000, 122000],
      samplesP99Ms: [0.75, 0.85],
      engineStats: { rssMb: 12, usedMemoryMb: 8, usedMemoryRssMb: 12, keyCount: 100000 },
      metrics: { throughput: { value: 120000, unit: "ops/s", label: "Throughput" } },
    },
    {
      label: "valkey/set-get-small",
      engine: "valkey",
      workload: "set-get-small",
      opsPerSec: 115000,
      p50Ms: 0.22,
      p99Ms: 0.9,
      p999Ms: 1.6,
      samplesOpsPerSec: [113000, 117000],
      samplesP99Ms: [0.88, 0.92],
      engineStats: { rssMb: 13, usedMemoryMb: 8.5, usedMemoryRssMb: 13, keyCount: 100000 },
      metrics: { throughput: { value: 115000, unit: "ops/s", label: "Throughput" } },
    },
    {
      label: "dragonfly/set-get-small",
      engine: "dragonfly",
      workload: "set-get-small",
      opsPerSec: 350000,
      p50Ms: 0.08,
      p99Ms: 0.3,
      p999Ms: 0.6,
      samplesOpsPerSec: [340000, 360000],
      samplesP99Ms: [0.28, 0.32],
      engineStats: { rssMb: 45, usedMemoryMb: 20, usedMemoryRssMb: 45, keyCount: 100000 },
      metrics: { throughput: { value: 350000, unit: "ops/s", label: "Throughput" } },
    },
    {
      label: "redis/memory-load",
      engine: "redis",
      workload: "memory-load",
      opsPerSec: 80000,
      p50Ms: 0.15,
      p99Ms: 0.5,
      p999Ms: 1.0,
      samplesOpsPerSec: [80000],
      samplesP99Ms: [0.5],
      engineStats: { rssMb: 25, usedMemoryMb: 18, usedMemoryRssMb: 25, keyCount: 100000 },
      metrics: {
        usedMemoryMb: { value: 18, unit: "MB", label: "Used memory" },
        rssMb: { value: 25, unit: "MB", label: "RSS" },
        keyCount: { value: 100000, unit: "keys", label: "Key count" },
        bytesPerKey: { value: 188.7, unit: "B/key", label: "Memory per key" },
      },
    },
    {
      label: "valkey/memory-load",
      engine: "valkey",
      workload: "memory-load",
      opsPerSec: 78000,
      p50Ms: 0.16,
      p99Ms: 0.52,
      p999Ms: 1.1,
      samplesOpsPerSec: [78000],
      samplesP99Ms: [0.52],
      engineStats: { rssMb: 26, usedMemoryMb: 18.5, usedMemoryRssMb: 26, keyCount: 100000 },
      metrics: {
        usedMemoryMb: { value: 18.5, unit: "MB", label: "Used memory" },
        rssMb: { value: 26, unit: "MB", label: "RSS" },
        keyCount: { value: 100000, unit: "keys", label: "Key count" },
        bytesPerKey: { value: 193.9, unit: "B/key", label: "Memory per key" },
      },
    },
    {
      label: "dragonfly/memory-load",
      engine: "dragonfly",
      workload: "memory-load",
      opsPerSec: 200000,
      p50Ms: 0.05,
      p99Ms: 0.2,
      p999Ms: 0.4,
      samplesOpsPerSec: [200000],
      samplesP99Ms: [0.2],
      engineStats: { rssMb: 60, usedMemoryMb: 35, usedMemoryRssMb: 60, keyCount: 100000 },
      metrics: {
        usedMemoryMb: { value: 35, unit: "MB", label: "Used memory" },
        rssMb: { value: 60, unit: "MB", label: "RSS" },
        keyCount: { value: 100000, unit: "keys", label: "Key count" },
        bytesPerKey: { value: 367.0, unit: "B/key", label: "Memory per key" },
      },
    },
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
    output: "memtier_benchmark JSON",
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
    expect(run.sections.length).toBeGreaterThanOrEqual(2);
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

  test("memory section uses MB values", async () => {
    await importRun(SAMPLE_RESULTS, SAMPLE_META);

    const run = await Bun.file(runFile).json();
    const s4 = run.sections.find(
      (s: { id: string }) => s.id === "memory-efficiency",
    );
    expect(s4).toBeDefined();
    expect(s4.unit).toBe("MB");
    expect(s4.lowerIsBetter).toBe(true);
  });

  test("idempotent benchmark.json update", async () => {
    await importRun(SAMPLE_RESULTS, SAMPLE_META);
    await importRun(SAMPLE_RESULTS, SAMPLE_META);

    const benchmark = await Bun.file("benchmark.json").json();
    const count = benchmark.runs.filter((r: string) => r === runFile).length;
    expect(count).toBe(1);
  });
});
