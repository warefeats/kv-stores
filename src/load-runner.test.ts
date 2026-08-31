import { describe, expect, test } from "bun:test";
import { parseProcStat, computeCpuPercent } from "./load-runner.js";

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
