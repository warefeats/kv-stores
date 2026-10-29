import { describe, expect, test } from "bun:test";
import {
  parseProcStat,
  computeCpuPercent,
  parseServerVersion,
  parseKividbWorkerThreads,
} from "./load-runner.js";

describe("parseProcStat", () => {
  test("parses aggregate cpu line", () => {
    const raw = [
      "cpu  10132153 290696 3084719 46828483 16683 0 25195 0 0 0",
      "cpu0 1393280 32966 572056 13343292 6130 0 17875 0 0 0",
    ].join("\n");
    const result = parseProcStat(raw);
    expect(result).not.toBeNull();
    expect(result!.idle).toBe(46828483 + 16683);
    expect(result!.total).toBe(
      10132153 + 290696 + 3084719 + 46828483 + 16683 + 0 + 25195 + 0 + 0 + 0,
    );
  });

  test("returns null for non-Linux input", () => {
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("no cpu line here")).toBeNull();
  });

  test("returns null for truncated cpu line", () => {
    expect(parseProcStat("cpu  100 200")).toBeNull();
  });
});

describe("computeCpuPercent", () => {
  test("computes busy percentage from deltas", () => {
    const before = { idle: 1000, total: 2000 };
    const after = { idle: 1030, total: 2100 };
    expect(computeCpuPercent(before, after)).toBe(70);
  });

  test("returns 0 for zero delta", () => {
    const same = { idle: 1000, total: 2000 };
    expect(computeCpuPercent(same, same)).toBe(0);
  });

  test("returns 100 for all-busy", () => {
    const before = { idle: 1000, total: 2000 };
    const after = { idle: 1000, total: 2100 };
    expect(computeCpuPercent(before, after)).toBe(100);
  });

  test("rounds to one decimal place", () => {
    const before = { idle: 0, total: 0 };
    const after = { idle: 333, total: 1000 };
    expect(computeCpuPercent(before, after)).toBe(66.7);
  });
});

describe("parseServerVersion", () => {
  test("picks redis_version for Redis", () => {
    const info = [
      "# Server",
      "redis_version:8.8.2",
      "redis_git_sha1:00000000",
    ].join("\r\n");
    expect(parseServerVersion(info)).toBe("8.8.2");
  });

  test("picks valkey_version over redis_version for Valkey", () => {
    const info = [
      "# Server",
      "redis_version:7.2.4",
      "valkey_version:9.1.1",
      "redis_git_sha1:00000000",
    ].join("\r\n");
    expect(parseServerVersion(info)).toBe("9.1.1");
  });

  test("picks dragonfly_version over redis_version for Dragonfly", () => {
    const info = [
      "# Server",
      "redis_version:7.4.0",
      "dragonfly_version:1.40.1",
      "redis_git_sha1:00000000",
    ].join("\r\n");
    expect(parseServerVersion(info)).toBe("1.40.1");
  });

  test("picks kividb_version over its fixed redis_version for KiviDB", () => {
    const info = [
      "# Server",
      "redis_version:8.10.0",
      "redis_git_sha1:00000000",
      "redis_mode:standalone",
      "arch_bits:64",
      "kividb_version:1.1.2",
      "os:linux aarch64",
    ].join("\r\n");
    expect(parseServerVersion(info)).toBe("1.1.2");
  });

  test("returns unknown for empty input", () => {
    expect(parseServerVersion("")).toBe("unknown");
  });
});

describe("parseKividbWorkerThreads", () => {
  test("reads the worker thread count from the startup banner", () => {
    const logs = [
      "  KiviDB v1.1.2 - A fast Redis\u00ae-compatible store written in Rust",
      "  * Version        : 1.1.2",
      "  * CPUs           : 4 cores detected",
      "  * Listening on   : 0.0.0.0:6379",
      "  * Worker threads : 4",
      "  * AOF            : disabled",
    ].join("\n");
    expect(parseKividbWorkerThreads(logs)).toBe(4);
  });

  test("reads it through a compose logs prefix", () => {
    expect(parseKividbWorkerThreads("engine-1  |   * Worker threads : 62")).toBe(62);
  });

  test("does not take the CPU count for the thread count", () => {
    expect(parseKividbWorkerThreads("  * CPUs           : 64 cores detected")).toBeNull();
  });

  test("returns null when the banner is missing", () => {
    expect(parseKividbWorkerThreads("")).toBeNull();
  });
});
