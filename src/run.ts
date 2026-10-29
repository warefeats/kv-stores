import { type Session, type Engine, buildMatrix, isMemoryWorkload } from "./matrix.js";
import {
  type CellResult,
  composeUp,
  composeDown,
  isCloud,
  runThroughputWorkload,
  runMemoryWorkload,
} from "./load-runner.js";

interface RawResults {
  generatedAt: string;
  smoke: boolean;
  sessionCount: number;
  resultCount: number;
  failureCount: number;
  results: CellResult[];
  failures: { label: string; error: string }[];
}

const args = process.argv.slice(2);
const smoke = args.includes("--smoke");
const engineFilter = args
  .find((a) => a.startsWith("--engine="))
  ?.split("=")[1] as Engine | undefined;
const workloadFilter = args
  .find((a) => a.startsWith("--workload="))
  ?.split("=")[1];
const resume = args.includes("--resume");
const outputPath =
  args.find((a) => a.startsWith("--output="))?.split("=")[1] ?? "results.json";

let sessions = buildMatrix(smoke);

if (engineFilter) {
  sessions = sessions.filter((s) => s.engine === engineFilter);
}
if (workloadFilter) {
  sessions = sessions.filter((s) => s.workload === workloadFilter);
}

const engines = [...new Set(sessions.map((s) => s.engine))];
const cycleMap = new Map<Engine, Session[]>();
for (const engine of engines) {
  const engineSessions = sessions
    .filter((s) => s.engine === engine)
    .sort((a, b) => {
      const order = [
        "memory-load",
        "set-get-small",
        "set-get-large",
        "pipeline-30",
        "memory-load-random",
      ];
      return order.indexOf(a.workload) - order.indexOf(b.workload);
    });
  cycleMap.set(engine, engineSessions);
}

let existing: RawResults | undefined;
if (resume) {
  try {
    existing = await Bun.file(outputPath).json();
  } catch {
    /* no prior results */
  }
}

const allResults: CellResult[] = existing?.results ?? [];
const allFailures: { label: string; error: string }[] =
  existing?.failures ?? [];

console.log(
  `\nKV-stores benchmark — ${smoke ? "SMOKE" : "FULL"} (${sessions.length} sessions across ${engines.length} engines)\n`,
);

for (const [engine, cycleSessions] of cycleMap) {
  if (!cycleSessions || cycleSessions.length === 0) continue;

  if (
    resume &&
    cycleSessions.every((s) =>
      allResults.some((r) => r.label === s.label),
    )
  ) {
    console.log(`  skipping ${engine} (all sessions already completed)`);
    continue;
  }

  const anchor = cycleSessions[0]!;
  console.log(`\n> ${engine}`);

  try {
    await composeUp(anchor);

    // Workloads this engine has served since it started: a memory cell's baseline needs none.
    let served = 0;
    for (const session of cycleSessions) {
      if (resume && allResults.some((r) => r.label === session.label)) {
        console.log(`  skipping ${session.workload} (already completed)`);
        continue;
      }

      if (isMemoryWorkload(session.workload) && served > 0) {
        if (isCloud) {
          console.log(`  deferring ${session.workload}: it needs a fresh engine, which the cloud workflow starts for it in a later invocation`);
          continue;
        }
        console.log(`  restarting ${engine} for ${session.workload}`);
        await composeDown(anchor);
        await composeUp(anchor);
        served = 0;
      }
      served += 1;

      try {
        const result = isMemoryWorkload(session.workload)
          ? await runMemoryWorkload(session)
          : await runThroughputWorkload(session);
        allResults.push(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  x ${session.label}: ${msg}`);
        allFailures.push({ label: session.label, error: msg });
      }
    }
  } finally {
    await composeDown(anchor);
  }

  const output: RawResults = {
    generatedAt: new Date().toISOString(),
    smoke,
    sessionCount: sessions.length,
    resultCount: allResults.length,
    failureCount: allFailures.length,
    results: allResults,
    failures: allFailures,
  };
  await Bun.write(outputPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`  saved (${allResults.length} results so far)`);
}

console.log(
  `\ndone — ${allResults.length} results, ${allFailures.length} failures`,
);
if (allFailures.length > 0) {
  console.log("Failures:");
  for (const f of allFailures) {
    console.log(`  ${f.label}: ${f.error}`);
  }
  process.exit(1);
}
