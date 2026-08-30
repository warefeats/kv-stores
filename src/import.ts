import { importRun, type RunMetadata, validateResults } from "./import-run.js";

const args = process.argv.slice(2);
const resultsPath =
  args.find((a) => a.startsWith("--results="))?.split("=")[1] ?? "results.json";

const raw = await Bun.file(resultsPath).json();
const results = validateResults(raw);

const meta: RunMetadata = {
  id: "",
  label: "M2 Max (local)",
  publishedAt: new Date().toISOString().split("T")[0]!,
  environment: {
    machine: "Apple Mac Studio",
    chip: "Apple M2 Max",
    cores: "12 CPU cores",
    memory: "96 GB",
    os: "macOS (Docker via OrbStack)",
    arch: "arm64",
    runtime: "Docker Compose",
  },
  protocol: {
    warmups: results.smoke ? 1 : 2,
    runs: results.smoke ? 2 : 10,
    processModel: "container-per-engine",
    cacheState: "n/a",
    output: "memtier_benchmark JSON",
  },
};

const { runFile, benchmarkFile } = await importRun(results, meta);
console.log(`wrote ${runFile}`);
console.log(`updated ${benchmarkFile}`);
