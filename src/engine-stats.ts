import { $ } from "bun";
import type { Engine } from "./matrix.js";

export interface EngineStats {
  rssMb: number;
  usedMemoryMb: number;
  usedMemoryRssMb: number;
  keyCount: number;
  hitRatio: number;
}

const isCloud = process.env.CLOUD_MODE === "1";
const engineHost = process.env.ENGINE_HOST || "engine";

export async function dockerStats(containerName: string): Promise<number> {
  if (isCloud) return 0;
  const result =
    await $`docker stats ${containerName} --no-stream --format {{.MemUsage}}`
      .text()
      .catch(() => "0MiB / 0MiB");
  const match = result.match(/([\d.]+)(MiB|GiB)/);
  if (!match) return 0;
  const value = parseFloat(match[1]!);
  const unit = match[2]!;
  return unit === "GiB" ? value * 1024 : value;
}

export async function engineInfo(
  projectName: string,
  composeFiles: string[],
): Promise<{ usedMemoryMb: number; usedMemoryRssMb: number; keyCount: number; hitRatio: number }> {
  let infoRaw: string;
  let dbsizeRaw: string;
  let infoStatsRaw: string;

  if (isCloud) {
    infoRaw = await $`redis-cli -h ${engineHost} -p 6379 INFO memory`.text().catch(() => "");
    dbsizeRaw = await $`redis-cli -h ${engineHost} -p 6379 DBSIZE`.text().catch(() => "0");
    infoStatsRaw = await $`redis-cli -h ${engineHost} -p 6379 INFO stats`.text().catch(() => "");
  } else {
    const fFlags = composeFiles.map((f) => ["-f", f]).flat();
    infoRaw = await $`docker compose ${fFlags} -p ${projectName} exec -T client redis-cli -h engine INFO memory`.text().catch(() => "");
    dbsizeRaw = await $`docker compose ${fFlags} -p ${projectName} exec -T client redis-cli -h engine DBSIZE`.text().catch(() => "0");
    infoStatsRaw = await $`docker compose ${fFlags} -p ${projectName} exec -T client redis-cli -h engine INFO stats`.text().catch(() => "");
  }

  const usedMemory = parseInfoBytes(infoRaw, "used_memory");
  const usedMemoryRss = parseInfoBytes(infoRaw, "used_memory_rss");
  const keyMatch = dbsizeRaw.match(/(\d+)/);
  const keyCount = keyMatch ? parseInt(keyMatch[1]!, 10) : 0;

  const hits = parseInfoInt(infoStatsRaw, "keyspace_hits");
  const misses = parseInfoInt(infoStatsRaw, "keyspace_misses");
  const hitRatio = (hits + misses) > 0 ? hits / (hits + misses) : 0;

  return {
    usedMemoryMb: usedMemory / (1024 * 1024),
    usedMemoryRssMb: usedMemoryRss / (1024 * 1024),
    keyCount,
    hitRatio,
  };
}

function parseInfoBytes(info: string, field: string): number {
  const re = new RegExp(`^${field}:(\\d+)`, "m");
  const match = info.match(re);
  return match ? parseInt(match[1]!, 10) : 0;
}

function parseInfoInt(info: string, field: string): number {
  const re = new RegExp(`^${field}:(\\d+)`, "m");
  const match = info.match(re);
  return match ? parseInt(match[1]!, 10) : 0;
}

export async function collectStats(
  engine: Engine,
  projName: string,
  composeFilesList: string[],
): Promise<EngineStats> {
  const containerN = `${projName}-engine-1`;
  const [rssMb, info] = await Promise.all([
    dockerStats(containerN),
    engineInfo(projName, composeFilesList),
  ]);
  return {
    rssMb,
    usedMemoryMb: info.usedMemoryMb,
    usedMemoryRssMb: info.usedMemoryRssMb,
    keyCount: info.keyCount,
    hitRatio: info.hitRatio,
  };
}

export async function resetStats(
  projectName: string,
  composeFiles: string[],
): Promise<void> {
  if (isCloud) {
    await $`redis-cli -h ${engineHost} -p 6379 CONFIG RESETSTAT`.quiet();
  } else {
    const fFlags = composeFiles.map((f) => ["-f", f]).flat();
    await $`docker compose ${fFlags} -p ${projectName} exec -T client redis-cli -h engine CONFIG RESETSTAT`.quiet();
  }
}
