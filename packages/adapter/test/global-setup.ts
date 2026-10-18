// Vitest globalSetup (incident 2026-10-18: a test wrote the real ~/.claude/settings.json).
//  1. Points every home-like variable of the main process, and so of every worker it starts, at one temp tree.
//  2. Records the modification time of the real user's Claude settings (stat only: the file is never opened) and,
//     when the run ends, fails it if that time changed. A test that reaches the real home fails loudly even if the
//     product guard and the per-test isolation both missed.
// "Real" is the account's profile directory (os.userInfo), whatever HOME/USERPROFILE say now, plus the homes the
// environment named when the run started.

import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const ISO_ROOT_VAR = "PG_TEST_ISO_ROOT";

function mtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function realSettingsFiles(): string[] {
  const homes = new Set<string>();
  const add = (h: string | undefined): void => {
    if (h !== undefined && h !== "") homes.add(h);
  };
  try {
    add(userInfo().homedir);
  } catch {
    // no passwd entry: the environment's homes below still count
  }
  add(homedir());
  add(process.env["USERPROFILE"]);
  add(process.env["HOME"]);
  // The real Prosegate program files too (stat only): the launcher every registration names, and the directories init writes.
  const files = [...homes].flatMap((h) => [
    join(h, ".claude", "settings.json"),
    join(h, ".claude", "settings.local.json"),
    join(h, ".prosegate", "app"),
    join(h, ".prosegate", "app", "hook.mjs"),
    join(h, ".prosegate", "bin"),
  ]);
  for (const dir of [process.env["CLAUDE_CONFIG_DIR"], process.env["PROSEGATE_CLAUDE_HOME"]]) if (dir !== undefined && dir !== "") files.push(join(dir, "settings.json"));
  return [...new Set(files)];
}

export function pointHomesAt(root: string): void {
  const dir = (name: string): string => {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    return d;
  };
  process.env["HOME"] = dir("home");
  process.env["USERPROFILE"] = dir("home");
  process.env["APPDATA"] = dir("appdata");
  process.env["LOCALAPPDATA"] = dir("localappdata");
  process.env["XDG_CONFIG_HOME"] = dir("xdg");
  process.env["CLAUDE_CONFIG_DIR"] = dir("claude-config");
  process.env["PROSEGATE_CLAUDE_HOME"] = dir("claude-home");
  process.env["PROSEGATE_HOME"] = dir("prosegate");
}

export default function setup(): () => void {
  const before = new Map(realSettingsFiles().map((f) => [f, mtime(f)]));
  const root = mkdtempSync(join(tmpdir(), "pg-vitest-iso-"));
  process.env[ISO_ROOT_VAR] = root;
  pointHomesAt(root);
  return () => {
    const changed = [...before].filter(([file, was]) => mtime(file) !== was).map(([file]) => file);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (changed.length > 0) {
      throw new Error(`A test run changed a real Claude settings file or Prosegate program directory (incident 2026-10-18): ${changed.join(", ")}. Find the test that reached the real home and isolate it.`);
    }
  };
}
