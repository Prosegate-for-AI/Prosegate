import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCtx } from "./ctx.js";
import { run } from "./run.js";

function sink(): { chunks: string[]; write(c: string): void } {
  const chunks: string[] = [];
  return { chunks, write: (c) => void chunks.push(c) };
}

async function exec(argv: string[], stdin = ""): Promise<{ code: number; out: string; err: string }> {
  const out = sink();
  const err = sink();
  const code = await run(argv, { stdin: () => Promise.resolve(stdin), stdout: out, stderr: err, ctx: createCtx({ env: {}, home: mkdtempSync(join(tmpdir(), "pg-run-")) }) });
  return { code, out: out.chunks.join(""), err: err.chunks.join("") };
}

describe("run", () => {
  it("prints the version for --version and exits 0", async () => {
    const r = await exec(["--version"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^\S+\n$/);
    expect(r.err).toBe("");
  });

  it.each([[[]], [["--help"]]])("prints usage to stdout and exits 0 for %j", async (argv) => {
    const r = await exec(argv);
    expect(r.code).toBe(0);
    expect(r.out).toContain("usage: prosegate");
    expect(r.out).not.toContain("placeholder");
    expect(r.err).toBe("");
  });

  it("lists every command in the help", async () => {
    const r = await exec(["--help"]);
    for (const word of ["session-start", "turn-start", "turn-end", "advisory", "enforce", "quiet", "off", "profile [<id>]", "reload", "rule off <id>", "rule on <id>", "rule list", "status"]) {
      expect(r.out).toContain(word);
    }
  });

  it("rejects an unknown command on stderr with exit 1", async () => {
    const r = await exec(["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe('prosegate: unknown command "frobnicate". Run prosegate --help.\n');
    expect(r.out).toBe("");
  });

  it("reports init as unavailable on stderr with exit 1", async () => {
    const r = await exec(["init"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe("prosegate init is not available in this build yet.\n");
    expect(r.out).toBe("");
  });

  it("fails open on malformed hook input: exit 1, one stderr line, nothing on stdout", async () => {
    const r = await exec(["turn-end"], "{nope");
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^prosegate: could not review this turn \(turn-end failed: invalid hook input\); your reply was not held\. Details: .+\.log\n$/);
  });
});
