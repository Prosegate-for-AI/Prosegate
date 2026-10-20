import { readFileSync } from "node:fs";
const run = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (run.head_sha !== process.env.GITHUB_SHA || run.conclusion !== "success" ||
    run.path !== ".github/workflows/eval-paid.yml" || run.event !== "workflow_dispatch" ||
    run.repository?.full_name !== process.env.GITHUB_REPOSITORY) {
  throw new Error("Evaluation must be a successful manual run of eval-paid.yml at this source commit in this repository.");
}
