import { cpus } from "os";

export type Engine = "redis" | "valkey" | "dragonfly" | "kividb";
export type Workload =
  | "set-get-small"
  | "set-get-large"
  | "pipeline-30"
  | "memory-load"
  | "memory-load-random";

export interface Session {
  engine: Engine;
  workload: Workload;
  label: string;
}

export interface WorkloadConfig {
  ratio: string;
  dataSize: number;
  pipeline: number;
  threads: number;
  clients: number;
  testTime: number;
  requests: number;
  keyPattern: string;
  keyMax: number;
  /** memtier --random-data: values of random bytes instead of its default fill, 100 ASCII bytes. */
  randomData: boolean;
  warmupPasses: number;
  measuredPasses: number;
}

export const ENGINES: Engine[] = ["redis", "valkey", "dragonfly", "kividb"];
export const WORKLOADS: Workload[] = [
  "set-get-small",
  "set-get-large",
  "pipeline-30",
  "memory-load",
  "memory-load-random",
];

/**
 * The memory cells: one load of keys into an engine that has served nothing since it started, measured as a
 * baseline-corrected delta. RSS doesn't return to its baseline after FLUSHALL, so each needs a fresh engine.
 */
export type MemoryWorkload = "memory-load" | "memory-load-random";

export function isMemoryWorkload(workload: Workload): workload is MemoryWorkload {
  return workload === "memory-load" || workload === "memory-load-random";
}

const smokeMode = process.argv.includes("--smoke");
const isCloud = process.env.CLOUD_MODE === "1";

export interface MemtierSizing {
  threads: number;
  clients: number;
  totalConnections: number;
}

export function memtierSizing(smoke: boolean): MemtierSizing {
  const envThreads = process.env.MEMTIER_THREADS;
  let threads: number;

  if (envThreads) {
    threads = Math.max(1, parseInt(envThreads, 10) || 1);
  } else if (isCloud) {
    threads = Math.max(2, cpus().length - 2);
  } else {
    threads = smoke ? 2 : 4;
  }

  const targetConns = smoke ? 20 : 200;
  const clients = Math.max(1, Math.round(targetConns / threads));

  return { threads, clients, totalConnections: threads * clients };
}

export function workloadConfig(
  workload: Workload,
  smoke: boolean = smokeMode,
): WorkloadConfig {
  if (isMemoryWorkload(workload)) {
    return {
      ratio: "1:0",
      dataSize: 100,
      pipeline: 1,
      threads: 1,
      clients: 1,
      testTime: 0,
      requests: smoke ? 100_000 : 1_000_000,
      keyPattern: "P:P",
      keyMax: smoke ? 100_000 : 1_000_000,
      randomData: workload === "memory-load-random",
      warmupPasses: 0,
      measuredPasses: 1,
    };
  }

  const base = {
    randomData: false,
    warmupPasses: smoke ? 1 : 2,
    measuredPasses: smoke ? 2 : 10,
  };
  const sizing = memtierSizing(smoke);

  switch (workload) {
    case "set-get-small":
      return {
        ...base,
        ratio: "1:10",
        dataSize: 100,
        pipeline: 1,
        threads: sizing.threads,
        clients: sizing.clients,
        testTime: smoke ? 5 : 10,
        requests: 0,
        keyPattern: "R:R",
        keyMax: 100_000,
      };
    case "set-get-large":
      return {
        ...base,
        ratio: "1:10",
        dataSize: 10_240,
        pipeline: 1,
        threads: sizing.threads,
        clients: sizing.clients,
        testTime: smoke ? 5 : 10,
        requests: 0,
        keyPattern: "R:R",
        keyMax: 40_000,
      };
    case "pipeline-30":
      return {
        ...base,
        ratio: "1:10",
        dataSize: 100,
        pipeline: 30,
        threads: sizing.threads,
        clients: sizing.clients,
        testTime: smoke ? 5 : 10,
        requests: 0,
        keyPattern: "R:R",
        keyMax: 100_000,
      };
  }
}

export function preloadSizeBytes(workload: Workload, smoke: boolean = smokeMode): number {
  const config = workloadConfig(workload, smoke);
  const overhead = 72;
  return config.keyMax * (config.dataSize + overhead);
}

export function buildMatrix(smoke: boolean = smokeMode): Session[] {
  const sessions: Session[] = [];
  for (const engine of ENGINES) {
    for (const workload of WORKLOADS) {
      sessions.push({
        engine,
        workload,
        label: `${engine}/${workload}`,
      });
    }
  }
  return sessions;
}

export function composeFiles(session: Session): string[] {
  return [`compose/docker-compose.${session.engine}.yml`];
}

export function projectName(session: Session): string {
  return `kv-${session.engine}`;
}

export function containerName(session: Session, service: string): string {
  return `${projectName(session)}-${service}-1`;
}
