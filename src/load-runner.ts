import { $ } from "bun";
import {
  type Engine,
  type Session,
  type WorkloadConfig,
  composeFiles,
  projectName,
  workloadConfig,
} from "./matrix.js";
import { type EngineStats, collectStats, resetStats } from "./engine-stats.js";

export interface MemtierResult {
  opsPerSec: number;
  p50Ms: number;
  p99Ms: number;
  p999Ms: number;
  kbPerSec: number;
  hitRatio: number;
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
  config: EngineConfig;
}

export interface EngineConfig {
  engineImage: string;
  maxmemoryBytes: number;
  threads: number;
  memtierVersion: string;
  cloudMode: boolean;
}

const isCloud = process.env.CLOUD_MODE === "1";
const engineHost = process.env.ENGINE_HOST || "engine";
const memtierImage = process.env.MEMTIER_IMAGE || "ghcr.io/warefeats/memtier-benchmark:2.5.1";

function fFlags(session: Session): string[] {
  return composeFiles(session)
    .map((f) => ["-f", f])
    .flat();
}

function proj(session: Session): string {
  return projectName(session);
}

export async function composeUp(session: Session): Promise<void> {
  if (isCloud) {
    console.log(`  cloud mode: skipping compose up`);
    for (let i = 0; i < 60; i++) {
      const result = await $`redis-cli -h ${engineHost} -p 6379 PING`.text().catch(() => "");
      if (result.includes("PONG")) return;
      await Bun.sleep(1000);
    }
    throw new Error(`Engine ${session.engine} did not respond to PING after 60s`);
  }
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
  if (isCloud) {
    console.log(`  cloud mode: skipping compose down`);
    return;
  }
  const flags = fFlags(session);
  const p = proj(session);
  console.log(`  compose down: ${p}`);
  await $`docker compose ${flags} -p ${p} down -v --remove-orphans`.quiet();
}

export async function flushDb(session: Session): Promise<void> {
  if (isCloud) {
    await $`redis-cli -h ${engineHost} -p 6379 FLUSHALL`.quiet();
    return;
  }
  const flags = fFlags(session);
  const p = proj(session);
  await $`docker compose ${flags} -p ${p} exec -T client redis-cli -h engine FLUSHALL`.quiet();
}

async function preloadKeys(session: Session, config: WorkloadConfig): Promise<void> {
  console.log(`    preloading ${config.keyMax} keys (${config.dataSize}B each)...`);
  const host = isCloud ? engineHost : "engine";

  const preloadArgs: string[] = [
    "-s", host,
    "-p", "6379",
    "--ratio=1:0",
    `--data-size=${config.dataSize}`,
    "--threads=1",
    "--clients=1",
    "--pipeline=100",
    "--key-pattern=P:P",
    "--key-minimum=1",
    `--key-maximum=${config.keyMax}`,
    `-n`, `${config.keyMax}`,
    "--distinct-client-seed",
    "--hide-histogram",
  ];

  if (isCloud) {
    await $`docker run --rm --network host ${memtierImage} memtier_benchmark ${preloadArgs}`;
  } else {
    const flags = fFlags(session);
    const p = proj(session);
    await $`docker compose ${flags} -p ${p} exec -T client memtier_benchmark ${preloadArgs}`;
  }
}

export async function runMemtierPass(
  session: Session,
  config: WorkloadConfig,
): Promise<MemtierResult> {
  const host = isCloud ? engineHost : "engine";

  const memtierArgs: string[] = [
    "-s", host,
    "-p", "6379",
    `--ratio=${config.ratio}`,
    `--data-size=${config.dataSize}`,
    `--threads=${config.threads}`,
    `--clients=${config.clients}`,
    `--pipeline=${config.pipeline}`,
    `--key-pattern=${config.keyPattern}`,
    `--key-minimum=1`,
    `--key-maximum=${config.keyMax}`,
    "--distinct-client-seed",
    "--hide-histogram",
  ];

  if (config.testTime > 0) {
    memtierArgs.push(`--test-time=${config.testTime}`);
  } else if (config.requests > 0) {
    memtierArgs.push(`-n`, `${config.requests}`);
  }

  if (isCloud) {
    const tmpDir = `/tmp/memtier-${Date.now()}`;
    await $`mkdir -p ${tmpDir}`;
    memtierArgs.push(`--json-out-file=${tmpDir}/result.json`);

    await $`docker run --rm --network host -v ${tmpDir}:${tmpDir} ${memtierImage} memtier_benchmark ${memtierArgs}`;
    const raw = await Bun.file(`${tmpDir}/result.json`).text();
    await $`rm -rf ${tmpDir}`;
    return parseMemtierJson(raw);
  }

  memtierArgs.push("--json-out-file=/tmp/memtier-result.json");
  const flags = fFlags(session);
  const p = proj(session);
  await $`docker compose ${flags} -p ${p} exec -T client memtier_benchmark ${memtierArgs}`;
  const raw = await $`docker compose ${flags} -p ${p} exec -T client cat /tmp/memtier-result.json`.text();
  return parseMemtierJson(raw);
}

export function parseMemtierJson(raw: string): MemtierResult {
  const data = JSON.parse(raw);

  const allStats = data["ALL STATS"];
  if (!allStats) {
    console.error("Unexpected memtier JSON structure. Top-level keys:", Object.keys(data));
    throw new Error("Missing 'ALL STATS' in memtier JSON output");
  }

  const totals = allStats["Totals"];
  if (!totals) {
    console.error("Missing Totals in ALL STATS. Keys:", Object.keys(allStats));
    throw new Error("Missing 'Totals' in memtier ALL STATS");
  }

  const opsPerSec = findNumericField(totals, "Ops/sec", "ops/sec") ?? 0;
  const kbPerSec = findNumericField(totals, "KB/sec", "kb/sec") ?? 0;

  const percentiles =
    totals["Percentile Latencies"] ?? totals["percentile_latencies"] ?? {};
  const p50Ms = findNumericField(percentiles, "p50.00", "p50", "p50 Latency") ?? 0;
  const p99Ms = findNumericField(percentiles, "p99.00", "p99", "p99 Latency") ?? 0;
  const p999Ms = findNumericField(percentiles, "p99.90", "p99.9", "p999", "p99.9 Latency") ?? 0;

  const gets = allStats["Gets"];
  const hitsPerSec = gets ? (findNumericField(gets, "Hits/sec", "hits/sec") ?? 0) : 0;
  const missesPerSec = gets ? (findNumericField(gets, "Misses/sec", "misses/sec") ?? 0) : 0;
  const hitRatio = (hitsPerSec + missesPerSec) > 0 ? hitsPerSec / (hitsPerSec + missesPerSec) : 0;

  if (opsPerSec === 0 && p50Ms === 0) {
    console.error("Could not extract metrics. Totals keys:", Object.keys(totals));
    if (Object.keys(percentiles).length > 0) {
      console.error("Percentile keys:", Object.keys(percentiles));
    }
    throw new Error("Failed to parse memtier results — zero ops/sec and zero latency");
  }

  return { opsPerSec, p50Ms, p99Ms, p999Ms, kbPerSec, hitRatio };
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

export async function detectEngineConfig(session: Session): Promise<EngineConfig> {
  const cFiles = composeFiles(session);
  let maxmemoryBytes = 0;
  let threads = 1;
  let engineImage = "";

  if (isCloud) {
    const infoMem = await $`redis-cli -h ${engineHost} -p 6379 INFO memory`.text().catch(() => "");
    const maxMem = infoMem.match(/^maxmemory:(\d+)/m);
    maxmemoryBytes = maxMem ? parseInt(maxMem[1]!, 10) : 0;

    const infoServer = await $`redis-cli -h ${engineHost} -p 6379 INFO server`.text().catch(() => "");
    const verMatch = infoServer.match(/^(?:redis|valkey|dragonfly)_version:(.+)/m);
    engineImage = verMatch ? verMatch[1]!.trim() : "unknown";

    if (session.engine === "dragonfly") {
      const threadsMatch = infoServer.match(/^used_threads:(\d+)/m) ??
        infoServer.match(/^thread_count:(\d+)/m);
      threads = threadsMatch ? parseInt(threadsMatch[1]!, 10) : 1;
    }
  } else {
    const flags = fFlags(session);
    const p = proj(session);
    const infoMem = await $`docker compose ${flags} -p ${p} exec -T client redis-cli -h engine INFO memory`.text().catch(() => "");
    const maxMem = infoMem.match(/^maxmemory:(\d+)/m);
    maxmemoryBytes = maxMem ? parseInt(maxMem[1]!, 10) : 0;

    const inspectRaw = await $`docker inspect ${p}-engine-1 --format {{.Config.Image}}`.text().catch(() => "unknown");
    engineImage = inspectRaw.trim();

    if (session.engine === "dragonfly") {
      const logs = await $`docker logs ${p}-engine-1 2>&1`.text().catch(() => "");
      const ioMatch = logs.match(/Running (\d+) io threads/);
      threads = ioMatch ? parseInt(ioMatch[1]!, 10) : 4;
    }
  }

  return {
    engineImage,
    maxmemoryBytes,
    threads,
    memtierVersion: "2.5.1",
    cloudMode: isCloud,
  };
}

export async function runThroughputWorkload(
  session: Session,
): Promise<CellResult> {
  const config = workloadConfig(session.workload);
  const cFiles = composeFiles(session);
  console.log(
    `  workload: ${session.workload} (${config.warmupPasses} warmup + ${config.measuredPasses} measured)`,
  );

  await flushDb(session);
  await preloadKeys(session, config);
  await resetStats(proj(session), cFiles);

  for (let i = 0; i < config.warmupPasses; i++) {
    console.log(`    warmup ${i + 1}/${config.warmupPasses}`);
    await runMemtierPass(session, config);
  }

  await resetStats(proj(session), cFiles);

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

  const stats = await collectStats(session.engine, proj(session), cFiles);
  const engineConfig = await detectEngineConfig(session);

  const medianOps = median(samplesOpsPerSec);
  const medianP99 = median(samplesP99Ms);
  const medianP50 = median(allResults.map((r) => r.p50Ms));
  const medianP999 = median(allResults.map((r) => r.p999Ms));

  console.log(
    `    → ${r(medianOps)} ops/s, p50=${r(medianP50, 3)}ms, p99=${r(medianP99, 3)}ms, hit ratio=${r(stats.hitRatio * 100, 1)}%`,
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
    config: engineConfig,
    metrics: {
      throughput: { value: medianOps, unit: "ops/s", label: "Throughput" },
      kbPerSec: { value: median(allResults.map((r) => r.kbPerSec)), unit: "KB/s", label: "Bandwidth" },
      hitRatio: { value: r(stats.hitRatio * 100, 1), unit: "%", label: "Hit ratio" },
    },
  };
}

export async function runMemoryWorkload(
  session: Session,
): Promise<CellResult> {
  const config = workloadConfig("memory-load");
  const cFiles = composeFiles(session);
  console.log(`  workload: memory-load (${config.keyMax} keys × ${config.dataSize}B)`);

  await flushDb(session);

  const baselineStats = await collectStats(session.engine, proj(session), cFiles);
  console.log(`    baseline: ${r(baselineStats.usedMemoryMb, 2)}MB used, ${r(baselineStats.usedMemoryRssMb, 2)}MB RSS`);

  await runMemtierPass(session, config);

  const postStats = await collectStats(session.engine, proj(session), cFiles);
  const engineConfig = await detectEngineConfig(session);

  const usedMemoryDelta = postStats.usedMemoryMb - baselineStats.usedMemoryMb;
  const rssDelta = postStats.usedMemoryRssMb - baselineStats.usedMemoryRssMb;

  const bytesPerKeyRss =
    postStats.keyCount > 0
      ? (rssDelta * 1024 * 1024) / postStats.keyCount
      : 0;
  const bytesPerKeyUsed =
    postStats.keyCount > 0
      ? (usedMemoryDelta * 1024 * 1024) / postStats.keyCount
      : 0;

  console.log(
    `    → ${postStats.keyCount} keys, delta ${r(usedMemoryDelta, 2)}MB used / ${r(rssDelta, 2)}MB RSS, ${r(bytesPerKeyRss, 1)} B/key (RSS)`,
  );

  return {
    label: session.label,
    engine: session.engine,
    workload: "memory-load",
    opsPerSec: 0,
    p50Ms: 0,
    p99Ms: 0,
    p999Ms: 0,
    samplesOpsPerSec: [0],
    samplesP99Ms: [0],
    engineStats: postStats,
    config: engineConfig,
    metrics: {
      usedMemoryDeltaMb: { value: r(usedMemoryDelta, 2), unit: "MB", label: "Used memory (delta)" },
      rssDeltaMb: { value: r(rssDelta, 2), unit: "MB", label: "RSS (delta)" },
      baselineUsedMb: { value: r(baselineStats.usedMemoryMb, 2), unit: "MB", label: "Baseline used memory" },
      baselineRssMb: { value: r(baselineStats.usedMemoryRssMb, 2), unit: "MB", label: "Baseline RSS" },
      keyCount: { value: postStats.keyCount, unit: "keys", label: "Key count" },
      bytesPerKeyRss: { value: r(bytesPerKeyRss, 1), unit: "B/key", label: "Memory per key (RSS)" },
      bytesPerKeyUsed: { value: r(bytesPerKeyUsed, 1), unit: "B/key", label: "Memory per key (used_memory)" },
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
