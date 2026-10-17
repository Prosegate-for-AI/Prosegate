import { run } from "./run.js";

process.exitCode = run(process.argv.slice(2), process.stdout, process.stderr);
