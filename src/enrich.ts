import {
  buildSections,
  validateResults,
  type BenchmarkSection,
  type TestStatistic,
} from "./import-run.js";

/** What the enrich reads and extends in a run file; every other key is carried through untouched. */
export interface EnrichableResult {
  candidateId: string;
  value: number;
  samples?: number[];
}

export interface EnrichableTest {
  id: string;
  results: EnrichableResult[];
  statistic?: TestStatistic;
}

export interface EnrichableSection {
  id: string;
  tests?: EnrichableTest[];
}

export interface EnrichableRun {
  sections: EnrichableSection[];
}

const STATISTICS: readonly TestStatistic[] = ["mean", "median", "min", "max", "other"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === "number");
}

function isStatistic(value: unknown): value is TestStatistic {
  return STATISTICS.some((s) => s === value);
}

function isResult(value: unknown): value is EnrichableResult {
  if (!isRecord(value)) return false;
  const samples = value["samples"];
  return (
    typeof value["candidateId"] === "string" &&
    typeof value["value"] === "number" &&
    (samples === undefined || isNumberArray(samples))
  );
}

function isTest(value: unknown): value is EnrichableTest {
  if (!isRecord(value)) return false;
  const results = value["results"];
  const statistic = value["statistic"];
  return (
    typeof value["id"] === "string" &&
    Array.isArray(results) &&
    results.every(isResult) &&
    (statistic === undefined || isStatistic(statistic))
  );
}

function isSection(value: unknown): value is EnrichableSection {
  if (!isRecord(value)) return false;
  const tests = value["tests"];
  return typeof value["id"] === "string" && (tests === undefined || (Array.isArray(tests) && tests.every(isTest)));
}

function isRun(value: unknown): value is EnrichableRun {
  if (!isRecord(value)) return false;
  const sections = value["sections"];
  return Array.isArray(sections) && sections.every(isSection);
}

/** The site's rule for a statistic recomputed from the samples: within half a unit of the value's last printed digit, plus float slack. */
export function tolerance(value: number): number {
  const text = String(value);
  const dot = text.indexOf(".");
  const digits = dot === -1 ? 0 : text.length - dot - 1;
  return 0.5 * 10 ** -digits + 1e-9;
}

/** Recomputes a statistic over the samples the way the site does: the median interpolates at (n − 1) / 2, so an even count averages the two middle values. "other" cannot be recomputed. */
export function recompute(statistic: TestStatistic, samples: number[]): number | undefined {
  if (statistic === "other" || samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  switch (statistic) {
    case "mean":
      return sorted.reduce((a, b) => a + b, 0) / sorted.length;
    case "median": {
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
    }
    case "min":
      return sorted[0];
    case "max":
      return sorted[sorted.length - 1];
  }
}

function sameNumbers(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Parses a run file's text as the importer wrote it. Any other formatting is refused, so that the rewrite changes nothing but the keys it adds. */
export function parseRun(text: string): EnrichableRun {
  const parsed: unknown = JSON.parse(text);
  if (JSON.stringify(parsed, null, 2) + "\n" !== text) {
    throw new Error("the run file is not in the importer's format (two-space JSON with a final newline); refusing to rewrite it");
  }
  if (!isRun(parsed)) throw new Error("the run file has no sections array, or one of its tests or results is malformed");
  return parsed;
}

/**
 * Appends each test's `statistic` and each result's per-pass `samples`, taken from sections rebuilt from the raw results, and changes nothing else.
 * The run file drives: every test it holds must be rebuilt with exactly the same value, and tests the rebuild adds are ignored.
 */
export function enrichRun(text: string, fresh: BenchmarkSection[]): string {
  const run = parseRun(text);
  for (const section of run.sections) {
    for (const test of section.tests ?? []) {
      const where = `${section.id}/${test.id}`;
      const freshTest = fresh.find((s) => s.id === section.id)?.tests?.find((t) => t.id === test.id);
      if (!freshTest) throw new Error(`${where}: the raw results build no such test`);
      for (const result of test.results) {
        const at = `${where}/${result.candidateId}`;
        const freshResult = freshTest.results.find((r) => r.candidateId === result.candidateId);
        if (!freshResult) throw new Error(`${at}: the raw results build no such result`);
        if (freshResult.value !== result.value) {
          throw new Error(`${at}: the raw results give ${freshResult.value}, the run file holds ${result.value}`);
        }
        if (freshResult.samples === undefined) continue;
        const computed = freshTest.statistic === undefined ? undefined : recompute(freshTest.statistic, freshResult.samples);
        if (computed !== undefined && Math.abs(computed - result.value) > tolerance(result.value)) {
          throw new Error(`${at}: the ${freshTest.statistic} of the samples is ${computed}, which the site would reject against ${result.value}`);
        }
        if (result.samples === undefined) result.samples = freshResult.samples;
        else if (!sameNumbers(result.samples, freshResult.samples)) {
          throw new Error(`${at}: the run file already carries different samples`);
        }
      }
      if (freshTest.statistic === undefined) continue;
      if (test.statistic === undefined) test.statistic = freshTest.statistic;
      else if (test.statistic !== freshTest.statistic) {
        throw new Error(`${where}: the run file declares ${test.statistic}, the raw results build ${freshTest.statistic}`);
      }
    }
  }
  return JSON.stringify(run, null, 2) + "\n";
}

/** Rewrites the run file at `runPath` with the samples and statistics its raw results give; `benchmark.json` is never touched. */
export async function enrichFile(runPath: string, resultsPath: string): Promise<void> {
  const raw = validateResults(await Bun.file(resultsPath).json());
  const text = await Bun.file(runPath).text();
  await Bun.write(runPath, enrichRun(text, buildSections(raw.results)));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const runPath = args.find((a) => a.startsWith("--run="))?.split("=")[1];
  const resultsPath = args.find((a) => a.startsWith("--results="))?.split("=")[1];

  if (!runPath || !resultsPath) {
    console.error("Usage: enrich.ts --run=<runs/file.json> --results=<raw results.json>");
    process.exit(1);
  }

  await enrichFile(runPath, resultsPath);
  console.log(`enriched ${runPath}`);
}
