import { $ } from "bun";
import {
  type Engine,
  type Session,
  type WorkloadConfig,
  composeFiles,
  projectName,
  workloadConfig,
} from "./matrix.js";
import { type EngineStats, collectStats } from "./engine-stats.js";

export interface MemtierResult {
  opsPerSec: number;
  p50Ms: number;
  p99Ms: number;
  p999Ms: number;
  kbPerSec: number;
}

export interface CellResult {
  label: string;
  engine: Engine;
  workload: string;
  opsPerSec: number;
  p50Ms: number;
  p99Ms: number;
  p999Ms: number;
  samplesOpsPerSec: number[];
  samplesP99Ms: number[];
  engineStats: EngineStats;
  metrics: Record<string, { value: number; unit: string; label?: string }>;
}

function fFlags(session: Session): string[] {
  return composeFiles(session)
    .map((f) => ["-f", f])
    .flat();
}

function proj(session: Session): string {
  return projectName(session);
}

export async function composeUp(session: Session): Promise<void> {
  const flags = fFlags(session);
  const p = proj(session);
  console.log(`  compose up: ${p}`);
  await $`docker compose ${flags} -p ${p} up -d --build --wait --wait-timeout 120`;

  for (let i = 0; i < 30; i++) {
    const result =
      await $`docker compose ${flags} -p ${p} exec -T client redis-cli -h engine PING`
        .text()
        .catch(() => "");
    if (result.includes("PONG")) return;
    await Bun.sleep(1000);
  }
  throw new Error(`Engine ${session.engine} did not respond to PING after 30s`);
}

export async function composeDown(session: Session): Promise<void> {
  const flags = fFlags(session);
  const p = proj(session);
  console.log(`  compose down: ${p}`);
  await $`docker compose ${flags} -p ${p} down -v --remove-orphans`.quiet();
}

export async function flushDb(session: Session): Promise<void> {
  const flags = fFlags(session);
  const p = proj(session);
  await $`docker compose ${flags} -p ${p} exec -T client redis-cli -h engine FLUSHALL`.quiet();
}

export async function runMemtierPass(
  session: Session,
  config: WorkloadConfig,
): Promise<MemtierResult> {
  const flags = fFlags(session);
  const p = proj(session);

  const memtierArgs: string[] = [
    "-s",
    "engine",
    "-p",
    "6379",
    `--ratio=${config.ratio}`,
    `--data-size=${config.dataSize}`,
    `--threads=${config.threads}`,
    `--clients=${config.clients}`,
    `--pipeline=${config.pipeline}`,
    `--key-pattern=${config.keyPattern}`,
    `--key-minimum=1`,
    `--key-maximum=${config.keyMax}`,
    "--json-out-file=/tmp/memtier-result.json",
    "--hide-histogram",
  ];

  if (config.testTime > 0) {
    memtierArgs.push(`--test-time=${config.testTime}`);
  } else if (config.requests > 0) {
    memtierArgs.push(`-n`, `${config.requests}`);
  }

  await $`docker compose ${flags} -p ${p} exec -T client memtier_benchmark ${memtierArgs}`;

  const raw =
    await $`docker compose ${flags} -p ${p} exec -T client cat /tmp/memtier-result.json`.text();
  return parseMemtierJson(raw);
}

export function parseMemtierJson(raw: string): MemtierResult {
  const data = JSON.parse(raw);

  const allStats = data["ALL STATS"];
  if (!allStats) {
    console.error(
      "Unexpected memtier JSON structure. Top-level keys:",
      Object.keys(data),
    );
    throw new Error("Missing 'ALL STATS' in memtier JSON output");
  }

  const totals = allStats["Totals"];
  if (!totals) {
    console.error(
      "Missing Totals in ALL STATS. Keys:",
      Object.keys(allStats),
    );
    throw new Error("Missing 'Totals' in memtier ALL STATS");
  }

  const opsPerSec = findNumericField(totals, "Ops/sec", "ops/sec") ?? 0;
  const kbPerSec = findNumericField(totals, "KB/sec", "kb/sec") ?? 0;

  const percentiles =
    totals["Percentile Latencies"] ?? totals["percentile_latencies"] ?? {};
  const p50Ms =
    findNumericField(percentiles, "p50.00", "p50", "p50 Latency") ?? 0;
  const p99Ms =
    findNumericField(percentiles, "p99.00", "p99", "p99 Latency") ?? 0;
  const p999Ms =
    findNumericField(
      percentiles,
      "p99.90",
      "p99.9",
      "p999",
      "p99.9 Latency",
    ) ?? 0;

  if (opsPerSec === 0 && p50Ms === 0) {
    console.error("Could not extract metrics. Totals keys:", Object.keys(totals));
    if (Object.keys(percentiles).length > 0) {
      console.error("Percentile keys:", Object.keys(percentiles));
    }
    throw new Error("Failed to parse memtier results — zero ops/sec and zero latency");
  }

  return { opsPerSec, p50Ms, p99Ms, p999Ms, kbPerSec };
}

function findNumericField(
  obj: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "number") return val;
  }
  return undefined;
}

export async function runThroughputWorkload(
  session: Session,
): Promise<CellResult> {
  const config = workloadConfig(session.workload);
  console.log(
    `  workload: ${session.workload} (${config.warmupPasses} warmup + ${config.measuredPasses} measured)`,
  );

  await flushDb(session);

  for (let i = 0; i < config.warmupPasses; i++) {
    console.log(`    warmup ${i + 1}/${config.warmupPasses}`);
    await runMemtierPass(session, config);
  }

  const samplesOpsPerSec: number[] = [];
  const samplesP99Ms: number[] = [];
  const allResults: MemtierResult[] = [];

  for (let i = 0; i < config.measuredPasses; i++) {
    console.log(`    measured ${i + 1}/${config.measuredPasses}`);
    const result = await runMemtierPass(session, config);
    allResults.push(result);
    samplesOpsPerSec.push(result.opsPerSec);
    samplesP99Ms.push(result.p99Ms);
  }

  const cFiles = composeFiles(session);
  const stats = await collectStats(session.engine, proj(session), cFiles);

  const medianOps = median(samplesOpsPerSec);
  const medianP99 = median(samplesP99Ms);
  const medianP50 = median(allResults.map((r) => r.p50Ms));
  const medianP999 = median(allResults.map((r) => r.p999Ms));

  console.log(
    `    → ${r(medianOps)} ops/s, p50=${r(medianP50, 3)}ms, p99=${r(medianP99, 3)}ms`,
  );

  return {
    label: session.label,
    engine: session.engine,
    workload: session.workload,
    opsPerSec: medianOps,
    p50Ms: medianP50,
    p99Ms: medianP99,
    p999Ms: medianP999,
    samplesOpsPerSec,
    samplesP99Ms,
    engineStats: stats,
    metrics: {
      throughput: {
        value: medianOps,
        unit: "ops/s",
        label: "Throughput",
      },
      kbPerSec: {
        value: median(allResults.map((r) => r.kbPerSec)),
        unit: "KB/s",
        label: "Bandwidth",
      },
    },
  };
}

export async function runMemoryWorkload(
  session: Session,
): Promise<CellResult> {
  const config = workloadConfig("memory-load");
  console.log(`  workload: memory-load (${config.requests} keys × ${config.dataSize}B)`);

  await flushDb(session);

  const result = await runMemtierPass(session, config);

  const cFiles = composeFiles(session);
  const stats = await collectStats(session.engine, proj(session), cFiles);

  const bytesPerKey =
    stats.keyCount > 0
      ? (stats.usedMemoryMb * 1024 * 1024) / stats.keyCount
      : 0;

  console.log(
    `    → ${stats.keyCount} keys, ${r(stats.usedMemoryMb, 1)}MB used, ${r(stats.usedMemoryRssMb, 1)}MB RSS, ${r(bytesPerKey, 1)} bytes/key`,
  );

  return {
    label: session.label,
    engine: session.engine,
    workload: "memory-load",
    opsPerSec: result.opsPerSec,
    p50Ms: result.p50Ms,
    p99Ms: result.p99Ms,
    p999Ms: result.p999Ms,
    samplesOpsPerSec: [result.opsPerSec],
    samplesP99Ms: [result.p99Ms],
    engineStats: stats,
    metrics: {
      usedMemoryMb: {
        value: stats.usedMemoryMb,
        unit: "MB",
        label: "Used memory",
      },
      rssMb: {
        value: stats.usedMemoryRssMb,
        unit: "MB",
        label: "RSS",
      },
      keyCount: {
        value: stats.keyCount,
        unit: "keys",
        label: "Key count",
      },
      bytesPerKey: {
        value: bytesPerKey,
        unit: "B/key",
        label: "Memory per key",
      },
    },
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

function r(n: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
