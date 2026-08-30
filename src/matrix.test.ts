import { describe, expect, test } from "bun:test";
import {
  buildMatrix,
  composeFiles,
  projectName,
  containerName,
  workloadConfig,
  ENGINES,
  WORKLOADS,
} from "./matrix.js";

describe("buildMatrix", () => {
  test("full matrix has 15 sessions (3 engines × 5 workloads)", () => {
    const sessions = buildMatrix(false);
    expect(sessions).toHaveLength(15);
  });

  test("smoke matrix has 15 sessions (same count, different params)", () => {
    const sessions = buildMatrix(true);
    expect(sessions).toHaveLength(15);
  });

  test("every engine appears", () => {
    const sessions = buildMatrix(false);
    for (const engine of ENGINES) {
      expect(sessions.filter((s) => s.engine === engine).length).toBeGreaterThan(0);
    }
  });

  test("every workload appears", () => {
    const sessions = buildMatrix(false);
    for (const workload of WORKLOADS) {
      expect(sessions.filter((s) => s.workload === workload).length).toBeGreaterThan(0);
    }
  });

  test("labels are unique", () => {
    const sessions = buildMatrix(false);
    const labels = sessions.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("composeFiles", () => {
  test("returns engine-specific compose file", () => {
    const session = buildMatrix(false).find((s) => s.engine === "redis")!;
    const files = composeFiles(session);
    expect(files).toEqual(["compose/docker-compose.redis.yml"]);
  });

  test("dragonfly uses its own compose file", () => {
    const session = buildMatrix(false).find((s) => s.engine === "dragonfly")!;
    const files = composeFiles(session);
    expect(files).toEqual(["compose/docker-compose.dragonfly.yml"]);
  });
});

describe("projectName", () => {
  test("prefixes with kv-", () => {
    const session = buildMatrix(false).find((s) => s.engine === "valkey")!;
    expect(projectName(session)).toBe("kv-valkey");
  });
});

describe("containerName", () => {
  test("builds container name from project and service", () => {
    const session = buildMatrix(false).find((s) => s.engine === "redis")!;
    expect(containerName(session, "engine")).toBe("kv-redis-engine-1");
  });
});

describe("workloadConfig", () => {
  test("smoke reduces measured passes to 2", () => {
    const config = workloadConfig("set-get-small", true);
    expect(config.measuredPasses).toBe(2);
    expect(config.warmupPasses).toBe(1);
  });

  test("full uses 10 measured passes", () => {
    const config = workloadConfig("set-get-small", false);
    expect(config.measuredPasses).toBe(10);
    expect(config.warmupPasses).toBe(2);
  });

  test("set-get-small uses 100B data", () => {
    const config = workloadConfig("set-get-small", false);
    expect(config.dataSize).toBe(100);
    expect(config.ratio).toBe("1:10");
    expect(config.pipeline).toBe(1);
  });

  test("set-get-large uses 10KB data", () => {
    const config = workloadConfig("set-get-large", false);
    expect(config.dataSize).toBe(10_240);
  });

  test("pipeline-30 uses pipeline depth 30", () => {
    const config = workloadConfig("pipeline-30", false);
    expect(config.pipeline).toBe(30);
    expect(config.dataSize).toBe(100);
  });

  test("memory-load uses sequential key pattern and request count", () => {
    const config = workloadConfig("memory-load", false);
    expect(config.keyPattern).toBe("P:P");
    expect(config.ratio).toBe("1:0");
    expect(config.requests).toBe(100_000);
    expect(config.warmupPasses).toBe(0);
    expect(config.measuredPasses).toBe(1);
  });

  test("smoke memory-load uses fewer keys", () => {
    const config = workloadConfig("memory-load", true);
    expect(config.requests).toBe(10_000);
    expect(config.keyMax).toBe(10_000);
  });
});
