// Vitest setupFiles entry (incident 2026-10-18): in every test worker, every home-like variable points into a temp
// tree before any test file loads, so os.homedir(), process.env.HOME and every fallback in the product land there
// even in a test that builds its own environment. global-setup.ts sets the same tree for the main process.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ISO_ROOT_VAR, pointHomesAt } from "./global-setup.js";

pointHomesAt(process.env[ISO_ROOT_VAR] ?? mkdtempSync(join(tmpdir(), "pg-worker-iso-")));
