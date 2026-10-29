export interface RunMetadata {
  id: string;
  label: string;
  publishedAt: string;
  environment: {
    machine: string;
    chip: string;
    cores: string;
    memory: string;
    os: string;
    arch: string;
    runtime: string;
  };
  protocol: {
    warmups: number;
    runs: number;
    processModel: string;
    cacheState: string;
    output: string;
    clientSizing?: string;
  };
}

export interface RawResult {
  label: string;
  engine: string;
  workload: string;
  opsPerSec: number;
  p50Ms: number;
  p99Ms: number;
  p999Ms: number;
  samplesOpsPerSec: number[];
  samplesP99Ms: number[];
  samplesClientCpuPct?: (number | null)[];
  engineStats: {
    rssMb: number;
    usedMemoryMb: number;
    usedMemoryRssMb: number;
    keyCount: number;
    hitRatio?: number;
  };
  metrics: Record<string, { value: number; unit: string; label?: string }>;
  config?: {
    engineImage: string;
    serverVersion?: string;
    maxmemoryBytes: number;
    threads: number;
    memtierThreads?: number;
    memtierClients?: number;
    totalConnections?: number;
    memtierVersion: string;
    cloudMode: boolean;
  };
}

export interface RawResults {
  generatedAt: string;
  smoke: boolean;
  sessionCount: number;
  resultCount: number;
  failureCount: number;
  results: RawResult[];
  failures: { label: string; error: string }[];
}

export interface Statistics {
  medianMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
}

export interface Candidate {
  id: string;
  name: string;
  version: string;
  logo?: string;
  color?: string;
  homepage?: string;
  statistics: Statistics;
  samplesMs: number[];
  metrics?: Record<string, { value: number; unit: string; label?: string }>;
}

export interface BenchmarkTest {
  id: string;
  title: string;
  description: string;
  unit: string;
  lowerIsBetter: boolean;
  results: { candidateId: string; value: number }[];
}

export interface BenchmarkSection {
  id: string;
  title: string;
  deck: string;
  unit: string;
  lowerIsBetter: boolean;
  verdict: {
    winnerId: string;
    headline: string;
    summary: string;
  };
  candidates: Candidate[];
  tests?: BenchmarkTest[];
}

export interface BenchmarkRun {
  schemaVersion: 1;
  id: string;
  label: string;
  publishedAt: string;
  environment: RunMetadata["environment"];
  protocol: RunMetadata["protocol"];
  sections: BenchmarkSection[];
}

const ENGINE_META: Record<
  string,
  {
    name: string;
    version: string;
    logo?: string;
    color: string;
    homepage: string;
  }
> = {
  redis: {
    name: "Redis",
    version: "8.10.3",
    logo: "/logos/redis.svg",
    color: "#DC382D",
    homepage: "https://redis.io",
  },
  valkey: {
    name: "Valkey",
    version: "9.1.3",
    color: "#5D6DBF",
    homepage: "https://valkey.io",
  },
  dragonfly: {
    name: "Dragonfly",
    version: "2.0.2",
    color: "#00C7B7",
    homepage: "https://www.dragonflydb.io",
  },
  kividb: {
    name: "KiviDB",
    version: "1.1.2",
    color: "#7CB342",
    homepage: "https://kividb.io",
  },
};

const SECTION_DEFS = [
  {
    id: "small-value-throughput",
    title: "Small value throughput",
    deck: "SET/GET mix (1:10 ratio) with 100-byte values, pipeline depth 1. RESP2, no TLS.",
    workload: "set-get-small",
    unit: "ms",
    lowerIsBetter: true,
    metricForChart: "p99Ms",
  },
  {
    id: "large-value-throughput",
    title: "Large value throughput",
    deck: "SET/GET mix (1:10 ratio) with 10 KB values, pipeline depth 1. RESP2, no TLS.",
    workload: "set-get-large",
    unit: "ms",
    lowerIsBetter: true,
    metricForChart: "p99Ms",
  },
  {
    id: "pipeline-effect",
    title: "Pipeline effect",
    deck: "SET/GET mix (1:10 ratio) with 100-byte values, comparing pipeline depth 1 vs 30. Candidate statistic: pipeline-30 throughput.",
    candidateWorkload: "pipeline-30",
    testWorkloads: [
      { id: "pipeline-1", workload: "set-get-small", label: "Pipeline depth 1", desc: "SET/GET mix at pipeline depth 1 (reuses small-value throughput data)" },
      { id: "pipeline-30", workload: "pipeline-30", label: "Pipeline depth 30", desc: "SET/GET mix at pipeline depth 30" },
    ],
    unit: "ops/s",
    lowerIsBetter: false,
    metricForChart: "opsPerSec",
  },
  {
    id: "memory-efficiency",
    title: "Memory efficiency",
    deck: "Baseline-corrected memory after loading 1M keys with 100-byte values into a fresh engine. RSS delta is the primary metric (allocator-neutral). Candidate statistic: memtier's default values, 100 ASCII bytes; a second load of random bytes shows what packing them is worth. Two more views of the ASCII cell: the next million keys' own RSS, which no startup allocation absorbs, and the absolute RSS after the first million.",
    candidateWorkload: "memory-load",
    testWorkloads: [
      { id: "ascii-values", workload: "memory-load", label: "ASCII values", desc: "1M keys with memtier's default 100-byte values, all ASCII, into a fresh engine" },
      { id: "random-bytes", workload: "memory-load-random", label: "Random bytes", desc: "1M keys with 100-byte values of random bytes, which no engine packs, into a fresh engine" },
      { id: "ascii-values-second-million", workload: "memory-load", metric: "rssDeltaSecondMb", label: "ASCII values, next million", desc: "The same load again on the next 1M keys: RSS over the first million's, which the segments and pages an engine allocates at startup can no longer absorb" },
      { id: "ascii-values-absolute", workload: "memory-load", metric: "absoluteRssMb", label: "ASCII values, RSS after 1M keys", desc: "The engine's whole RSS after the first million keys, idle overhead included: what a container limit sees" },
    ],
    unit: "MB",
    lowerIsBetter: true,
    metricForChart: "rssDeltaMb",
  },
] as const;

export function validateResults(raw: unknown): RawResults {
  if (!raw || typeof raw !== "object") throw new Error("Invalid results: not an object");
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r["results"]) || (r["results"] as unknown[]).length === 0)
    throw new Error("Invalid results: empty or missing results array");
  return raw as RawResults;
}

export function validateMetadata(raw: unknown): RunMetadata {
  if (!raw || typeof raw !== "object") throw new Error("Invalid metadata: not an object");
  const r = raw as Record<string, unknown>;
  if (!r["environment"] || !r["protocol"])
    throw new Error("Invalid metadata: missing environment or protocol");
  return raw as RunMetadata;
}

export function rigSlug(meta: RunMetadata): string {
  const date = meta.publishedAt.split("T")[0]!;
  const machine = meta.environment.chip
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+$/, "");
  return `${date}-${machine}`;
}

function statsFromSamples(samples: number[]): Statistics {
  if (samples.length === 0) return { medianMs: 0, meanMs: 0, minMs: 0, maxMs: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 0
      ? (sorted[mid - 1]! + sorted[mid]!) / 2
      : sorted[mid]!;
  const meanMs = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    medianMs: round(medianMs, 3),
    meanMs: round(meanMs, 3),
    minMs: round(sorted[0]!, 3),
    maxMs: round(sorted[sorted.length - 1]!, 3),
  };
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function buildCandidate(
  engine: string,
  results: RawResult[],
  metricKey: string,
): Candidate {
  const meta = ENGINE_META[engine];
  if (!meta) throw new Error(`Unknown engine: ${engine}`);

  let samples: number[];
  let metrics: Record<string, { value: number; unit: string; label?: string }> | undefined;

  if (metricKey === "rssDeltaMb") {
    const result = results[0]!;
    samples = [result.metrics["rssDeltaMb"]?.value ?? result.engineStats.usedMemoryRssMb];
    metrics = result.metrics;
  } else if (metricKey === "opsPerSec") {
    samples = results.flatMap((r) => r.samplesOpsPerSec);
    metrics = results[0]?.metrics;
  } else {
    samples = results.flatMap((r) => r.samplesP99Ms);
    metrics = {
      throughput: {
        value: median(results.flatMap((r) => r.samplesOpsPerSec)),
        unit: "ops/s",
        label: "Throughput",
      },
    };
  }

  const serverVersion = results[0]?.config?.serverVersion;
  return {
    id: engine,
    name: meta.name,
    version: serverVersion || meta.version,
    logo: meta.logo,
    color: meta.color,
    homepage: meta.homepage,
    statistics: statsFromSamples(samples),
    samplesMs: samples.map((s) => round(s, 3)),
    metrics,
  };
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function buildSections(results: RawResult[]): BenchmarkSection[] {
  const sections: BenchmarkSection[] = [];

  for (const def of SECTION_DEFS) {
    if ("testWorkloads" in def) {
      const candidateResults = results.filter((r) => r.workload === def.candidateWorkload);
      if (candidateResults.length === 0) continue;
      const engines = [...new Set(candidateResults.map((r) => r.engine))];
      if (engines.length < 2) continue;

      const candidates = engines.map((e) => {
        const engineResults = candidateResults.filter((r) => r.engine === e);
        return buildCandidate(e, engineResults, def.metricForChart);
      });

      const sorted = [...candidates].sort((a, b) =>
        def.lowerIsBetter
          ? a.statistics.medianMs - b.statistics.medianMs
          : b.statistics.medianMs - a.statistics.medianMs,
      );
      const winner = sorted[0]!;

      // A test no result covers, such as a memory cell a run didn't load, is left out rather than charted empty.
      // A test may chart a metric other than the section's (the memory section's second-load and absolute views);
      // a run from before that metric existed leaves the test out rather than charting the fallback.
      const tests: BenchmarkTest[] = def.testWorkloads
        .map((tw) => ({ ...tw, metric: ("metric" in tw ? tw.metric : undefined) ?? def.metricForChart }))
        .filter((tw) =>
          results.some(
            (r) => r.workload === tw.workload && (tw.metric === def.metricForChart || r.metrics[tw.metric] !== undefined),
          ),
        )
        .map((tw) => {
          const wlResults = results.filter((r) => r.workload === tw.workload);
          return {
            id: tw.id,
            title: tw.label,
            description: tw.desc,
            unit: def.unit,
            lowerIsBetter: def.lowerIsBetter,
            results: engines
              .filter((e) => wlResults.some((r) => r.engine === e))
              .map((e) => {
                const er = wlResults.filter((r) => r.engine === e);
                const value =
                  def.metricForChart === "opsPerSec"
                    ? median(er.flatMap((r) => r.samplesOpsPerSec))
                    : def.metricForChart === "rssDeltaMb"
                      ? median(er.map((r) => r.metrics[tw.metric]?.value ?? r.engineStats.usedMemoryRssMb))
                      : median(er.flatMap((r) => r.samplesP99Ms));
                return { candidateId: e, value: round(value, 3) };
              }),
          };
        });

      sections.push({
        id: def.id,
        title: def.title,
        deck: def.deck,
        unit: def.unit,
        lowerIsBetter: def.lowerIsBetter,
        verdict: { winnerId: winner.id, headline: "TODO", summary: "TODO" },
        candidates,
        tests,
      });
    } else {
      const workloads: string[] = [def.workload];
      const sectionResults = results.filter((r) =>
        workloads.includes(r.workload),
      );
      if (sectionResults.length === 0) continue;
      const engines = [...new Set(sectionResults.map((r) => r.engine))];
      if (engines.length < 2) continue;

      const candidates = engines.map((e) => {
        const engineResults = sectionResults.filter((r) => r.engine === e);
        return buildCandidate(e, engineResults, def.metricForChart);
      });

      const sorted = [...candidates].sort((a, b) =>
        def.lowerIsBetter
          ? a.statistics.medianMs - b.statistics.medianMs
          : b.statistics.medianMs - a.statistics.medianMs,
      );
      const winner = sorted[0]!;

      sections.push({
        id: def.id,
        title: def.title,
        deck: def.deck,
        unit: def.unit,
        lowerIsBetter: def.lowerIsBetter,
        verdict: { winnerId: winner.id, headline: "TODO", summary: "TODO" },
        candidates,
      });
    }
  }

  return sections;
}

export async function importRun(
  raw: RawResults,
  meta: RunMetadata,
): Promise<{ runFile: string; benchmarkFile: string }> {
  const slug = rigSlug(meta);
  const id = meta.id || slug;
  const runFile = `runs/${slug}.json`;

  const sections = buildSections(raw.results);
  if (sections.length === 0) {
    throw new Error("Import produced 0 sections — need results for at least 2 engines per workload");
  }

  const throughputResult = raw.results.find((r) => r.workload !== "memory-load") ?? raw.results[0];
  const throughputConfig = throughputResult?.config;
  const clientSizing = throughputConfig?.memtierThreads != null
    ? `memtier: ${throughputConfig.memtierThreads} threads × ${throughputConfig.memtierClients} clients = ${throughputConfig.totalConnections} connections`
    : undefined;

  const run: BenchmarkRun = {
    schemaVersion: 1,
    id,
    label: meta.label,
    publishedAt: meta.publishedAt,
    environment: meta.environment,
    protocol: { ...meta.protocol, ...(clientSizing ? { clientSizing } : {}) },
    sections,
  };

  await Bun.write(runFile, JSON.stringify(run, null, 2) + "\n");

  const benchmarkFile = "benchmark.json";
  const benchmark = await Bun.file(benchmarkFile).json();
  const runs: string[] = benchmark.runs ?? [];
  if (!runs.includes(runFile)) {
    runs.push(runFile);
    benchmark.runs = runs;
    await Bun.write(benchmarkFile, JSON.stringify(benchmark, null, 2) + "\n");
  }

  return { runFile, benchmarkFile };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const resultsPath =
    args.find((a) => a.startsWith("--results="))?.split("=")[1];
  const metadataPath =
    args.find((a) => a.startsWith("--metadata="))?.split("=")[1];

  if (!resultsPath || !metadataPath) {
    console.error("Usage: import-run.ts --results=<path> --metadata=<path>");
    process.exit(1);
  }

  const rawResults = validateResults(await Bun.file(resultsPath).json());
  const rawMeta = validateMetadata(await Bun.file(metadataPath).json());
  const { runFile, benchmarkFile } = await importRun(rawResults, rawMeta);
  console.log(`wrote ${runFile}`);
  console.log(`updated ${benchmarkFile}`);
}
