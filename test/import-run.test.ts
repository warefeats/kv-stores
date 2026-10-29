import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  importRun,
  validateResults,
  validateMetadata,
  rigSlug,
  type RawResults,
} from "../src/import-run.js";
import { existsSync, unlinkSync, readFileSync, writeFileSync } from "fs";
import { SAMPLE_META, SAMPLE_RESULTS } from "./fixtures.js";

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

  test("small-value section has 4 candidates", async () => {
    await importRun(SAMPLE_RESULTS, SAMPLE_META);

    const run = await Bun.file(runFile).json();
    const s1 = run.sections.find(
      (s: { id: string }) => s.id === "small-value-throughput",
    );
    expect(s1).toBeDefined();
    expect(s1.candidates).toHaveLength(4);
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

    // One load per engine: a single reading, declared as its own mean. The fixture has no random-bytes cell.
    expect(s4.tests.map((t: { id: string }) => t.id)).toEqual(["ascii-values"]);
    const ascii = s4.tests[0];
    expect(ascii.statistic).toBe("mean");
    expect(ascii.results.find((r: { candidateId: string }) => r.candidateId === "redis")).toEqual({
      candidateId: "redis",
      value: 23.5,
      samples: [23.5],
    });
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

  test("pipeline tests carry the per-pass throughput their median is taken over", async () => {
    await importRun(SAMPLE_RESULTS, SAMPLE_META);

    const run = await Bun.file(runFile).json();
    const section = run.sections.find(
      (s: { id: string }) => s.id === "pipeline-effect",
    );
    const [depth1, depth30] = section.tests;

    // pipeline-1 reuses the set-get-small rows; pipeline-30 reads its own cell.
    expect(depth1.statistic).toBe("median");
    expect(depth1.results).toEqual([
      { candidateId: "redis", value: 120000, samples: [118000, 122000] },
      { candidateId: "valkey", value: 115000, samples: [113000, 117000] },
      { candidateId: "dragonfly", value: 350000, samples: [340000, 360000] },
      { candidateId: "kividb", value: 380000, samples: [370000, 390000] },
    ]);
    expect(depth30.statistic).toBe("median");
    expect(depth30.results).toEqual([
      { candidateId: "redis", value: 900000, samples: [880000, 920000] },
      { candidateId: "valkey", value: 850000, samples: [830000, 870000] },
      { candidateId: "dragonfly", value: 2500000, samples: [2400000, 2600000] },
      { candidateId: "kividb", value: 2700000, samples: [2650000, 2750000] },
    ]);

    // The serialization order the site reads: statistic after results, samples after value.
    expect(Object.keys(depth30)).toEqual(["id", "title", "description", "unit", "lowerIsBetter", "results", "statistic"]);
    expect(Object.keys(depth30.results[0])).toEqual(["candidateId", "value", "samples"]);
  });

  test("KiviDB candidate carries its detected version and no logo", async () => {
    const results: RawResults = {
      ...SAMPLE_RESULTS,
      results: SAMPLE_RESULTS.results.map((r) =>
        r.engine === "kividb" && r.config
          ? { ...r, config: { ...r.config, engineImage: "kividb/kividb:v1.1.2", serverVersion: "1.1.2", threads: 4 } }
          : r,
      ),
    };
    await importRun(results, SAMPLE_META);

    const run = await Bun.file(runFile).json();
    const s1 = run.sections.find(
      (s: { id: string }) => s.id === "small-value-throughput",
    );
    const kividb = s1.candidates.find((c: { id: string }) => c.id === "kividb");
    expect(kividb.name).toBe("KiviDB");
    expect(kividb.version).toBe("1.1.2");
    expect(kividb.homepage).toBe("https://kividb.io");
    expect(kividb.logo).toBeUndefined();
    expect(kividb.samplesMs).toEqual([0.24, 0.26]);
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
