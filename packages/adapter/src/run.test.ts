import { describe, expect, it } from "vitest";
import { run } from "./run.js";

function sink(): { chunks: string[]; write(c: string): void } {
  const chunks: string[] = [];
  return { chunks, write: (c) => void chunks.push(c) };
}

function exec(argv: string[]): { code: number; out: string; err: string } {
  const out = sink();
  const err = sink();
  const code = run(argv, out, err);
  return { code, out: out.chunks.join(""), err: err.chunks.join("") };
}

describe("run", () => {
  it("prints the version for --version and exits 0", () => {
    const r = exec(["--version"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^\S+\n$/);
    expect(r.err).toBe("");
  });

  it.each([[[]], [["--help"]]])("prints usage to stdout and exits 0 for %j", (argv) => {
    const r = exec(argv);
    expect(r.code).toBe(0);
    expect(r.out).toContain("usage: prosegate");
    expect(r.out).not.toContain("placeholder");
    expect(r.err).toBe("");
  });

  it("rejects an unknown command on stderr with exit 1", () => {
    const r = exec(["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe('prosegate: unknown command "frobnicate". Run prosegate --help.\n');
    expect(r.out).toBe("");
  });

  it("reports init as unavailable on stderr with exit 1", () => {
    const r = exec(["init"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe("prosegate init is not available in this build yet.\n");
    expect(r.out).toBe("");
  });
});
