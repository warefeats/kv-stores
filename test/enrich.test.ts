import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { enrichFile, enrichRun, parseRun, recompute, tolerance, type EnrichableRun } from "../src/enrich.js";
import { buildSections, type BenchmarkRun, type RawResults } from "../src/import-run.js";
import { SAMPLE_META, SAMPLE_RESULTS } from "./fixtures.js";

/** The run the importer writes for the fixture, without touching `runs/` or `benchmark.json`. */
function buildRun(raw: RawResults): BenchmarkRun {
  return {
    schemaVersion: 1,
    id: "2026-08-30-apple-m2-max",
    label: SAMPLE_META.label,
    publishedAt: SAMPLE_META.publishedAt,
    environment: SAMPLE_META.environment,
    protocol: SAMPLE_META.protocol,
    sections: buildSections(raw.results),
  };
}

/** The same run as the importer wrote it before it carried samples: every key but the two, in the same order. */
function strip(run: EnrichableRun): EnrichableRun {
  return {
    ...run,
    sections: run.sections.map((section) =>
      section.tests
        ? {
            ...section,
            tests: section.tests.map(({ statistic: _statistic, ...test }) => ({
              ...test,
              results: test.results.map(({ samples: _samples, ...result }) => result),
            })),
          }
        : section,
    ),
  };
}

function serialize(run: EnrichableRun): string {
  return JSON.stringify(run, null, 2) + "\n";
}

describe("tolerance", () => {
  test("is half a unit of the last printed digit, plus float slack", () => {
    expect(tolerance(158)).toBe(0.5 + 1e-9);
    expect(tolerance(1483688.86)).toBe(0.005 + 1e-9);
    expect(tolerance(0.447)).toBe(0.0005 + 1e-9);
  });
});

describe("recompute", () => {
  test("takes the statistics the site recomputes", () => {
    expect(recompute("mean", [1, 2, 3, 6])).toBe(3);
    expect(recompute("median", [3, 1, 2])).toBe(2);
    expect(recompute("median", [4, 1, 3, 2])).toBe(2.5);
    expect(recompute("min", [4, 1, 3, 2])).toBe(1);
    expect(recompute("max", [4, 1, 3, 2])).toBe(4);
  });

  test("cannot recompute another statistic or an empty array", () => {
    expect(recompute("other", [1, 2])).toBeUndefined();
    expect(recompute("median", [])).toBeUndefined();
  });

  test("agrees with the importer's median within rounding on every fixture test", () => {
    for (const section of buildSections(SAMPLE_RESULTS.results)) {
      for (const test of section.tests ?? []) {
        for (const result of test.results) {
          const computed = recompute(test.statistic!, result.samples!);
          expect(Math.abs(computed! - result.value)).toBeLessThanOrEqual(tolerance(result.value));
        }
      }
    }
  });
});

describe("enrichRun", () => {
  const fresh = buildRun(SAMPLE_RESULTS);
  const freshText = serialize(fresh);
  const strippedText = serialize(strip(fresh));

  test("the fixture's stripped run really lacks the two keys", () => {
    expect(freshText).toContain('"samples"');
    expect(freshText).toContain('"statistic"');
    expect(strippedText).not.toContain('"samples"');
    expect(strippedText).not.toContain('"statistic"');
  });

  test("appends the statistic and samples and nothing else", () => {
    const enriched = enrichRun(strippedText, fresh.sections);
    expect(enriched).toBe(freshText);
    expect(serialize(strip(parseRun(enriched)))).toBe(strippedText);
  });

  test("is a no-op on a run that already carries them", () => {
    expect(enrichRun(freshText, fresh.sections)).toBe(freshText);
  });

  test("the run file drives: tests the rebuild adds are ignored", () => {
    const withoutMemoryTests: EnrichableRun = {
      ...strip(fresh),
      sections: strip(fresh).sections.map((s) => (s.id === "memory-efficiency" ? { ...s, tests: undefined } : s)),
    };
    const expected: EnrichableRun = {
      ...fresh,
      sections: fresh.sections.map((s) => (s.id === "memory-efficiency" ? { ...s, tests: undefined } : s)),
    };
    expect(enrichRun(serialize(withoutMemoryTests), fresh.sections)).toBe(serialize(expected));
  });

  test("refuses a run file in any other formatting", () => {
    expect(() => enrichRun(JSON.stringify(strip(fresh), null, 4) + "\n", fresh.sections)).toThrow("importer's format");
    expect(() => enrichRun(strippedText.trimEnd(), fresh.sections)).toThrow("importer's format");
  });

  test("aborts, naming the test, when the run file holds a test the rebuild lacks", () => {
    const renamed = strippedText.replace('"id": "pipeline-30"', '"id": "pipeline-60"');
    expect(() => enrichRun(renamed, fresh.sections)).toThrow("pipeline-effect/pipeline-60: the raw results build no such test");
  });

  test("aborts, naming the result, when a rebuilt value differs", () => {
    const perturbed: RawResults = {
      ...SAMPLE_RESULTS,
      results: SAMPLE_RESULTS.results.map((r) =>
        r.engine === "redis" && r.workload === "pipeline-30" ? { ...r, samplesOpsPerSec: [880000, 921000] } : r,
      ),
    };
    expect(() => enrichRun(strippedText, buildSections(perturbed.results))).toThrow(
      "pipeline-effect/pipeline-30/redis: the raw results give 900500, the run file holds 900000",
    );
  });

  test("aborts when the run file already carries different samples", () => {
    const altered = parseRun(freshText);
    const redis = altered.sections
      .find((s) => s.id === "pipeline-effect")!
      .tests!.find((t) => t.id === "pipeline-30")!
      .results.find((r) => r.candidateId === "redis")!;
    redis.samples = [880000, 920001];
    expect(() => enrichRun(serialize(altered), fresh.sections)).toThrow("pipeline-effect/pipeline-30/redis: the run file already carries different samples");
  });
});

describe("enrichFile", () => {
  let dir: string;
  let runPath: string;
  let resultsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kv-stores-enrich-"));
    runPath = join(dir, "run.json");
    resultsPath = join(dir, "results.json");
    writeFileSync(resultsPath, JSON.stringify(SAMPLE_RESULTS, null, 2) + "\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("round trip: a run stripped of its samples comes back as the fresh build", async () => {
    const fresh = buildRun(SAMPLE_RESULTS);
    const strippedText = serialize(strip(fresh));
    writeFileSync(runPath, strippedText);

    await enrichFile(runPath, resultsPath);

    const enriched = readFileSync(runPath, "utf-8");
    expect(enriched).toBe(serialize(fresh));
    expect(serialize(strip(parseRun(enriched)))).toBe(strippedText);
  });

  test("leaves the run file untouched when a raw value no longer reproduces it", async () => {
    const strippedText = serialize(strip(buildRun(SAMPLE_RESULTS)));
    writeFileSync(runPath, strippedText);
    const perturbed: RawResults = {
      ...SAMPLE_RESULTS,
      results: SAMPLE_RESULTS.results.map((r) =>
        r.engine === "valkey" && r.workload === "set-get-small" ? { ...r, samplesOpsPerSec: [113000, 118000] } : r,
      ),
    };
    writeFileSync(resultsPath, JSON.stringify(perturbed));

    await expect(enrichFile(runPath, resultsPath)).rejects.toThrow("pipeline-effect/pipeline-1/valkey");
    expect(readFileSync(runPath, "utf-8")).toBe(strippedText);
  });
});
