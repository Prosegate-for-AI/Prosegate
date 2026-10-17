import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scanText } from "./check-secrets.mjs";

// Fake keys are assembled at runtime so no key-like literal exists in this file.
const ALPHA = "Ab1_Cd2-Ef3_Gh4-Ij5_Kl6-Mn7_Op8-Qr9";
const body = (n) => ALPHA.repeat(Math.ceil(n / ALPHA.length)).slice(0, n);
const SK = "sk" + "-";
const PGD = "pgd" + "_";
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-secrets.mjs");

describe("scanText (unit)", () => {
  it("names each prefix and never returns the value", () => {
    const text = [
      SK + body(30),
      SK + "ant-" + body(30),
      SK + "proj-" + body(30),
      SK + "svcacct-" + body(30),
      SK + "admin-" + body(30),
      PGD + body(30),
    ].join("\n");
    const hits = scanText(text);
    expect(hits.map((h) => h.redacted)).toEqual([
      "sk-…(redacted)",
      "sk-ant-…(redacted)",
      "sk-proj-…(redacted)",
      "sk-svcacct-…(redacted)",
      "sk-admin-…(redacted)",
      "pgd_…(redacted)",
    ]);
    expect(JSON.stringify(hits)).not.toContain(body(20));
  });

  it("matches at exactly 20 characters after the prefix and not at 19", () => {
    // The generic sk- pattern also covers sk-ant- and friends, whose own name counts toward its 20
    // characters ("ant-" is 4), so only the plain prefixes have 19/20 as the visible edge.
    for (const prefix of [SK, PGD]) {
      expect(scanText(`x ${prefix}${body(19)}`)).toEqual([]);
      expect(scanText(`x ${prefix}${body(20)}`)).toHaveLength(1);
    }
    for (const sub of ["ant-", "proj-", "svcacct-", "admin-"]) {
      expect(scanText(`x ${SK}${sub}${body(19 - sub.length)}`)).toEqual([]);
      expect(scanText(`x ${SK}${sub}${body(20 - sub.length)}`)).toHaveLength(1);
    }
  });

  it("accepts the full base64url alphabet, including - and _, and stops at other characters", () => {
    expect(scanText(`k=${SK}${"A".repeat(10)}-${"b".repeat(5)}_${"C".repeat(5)}`)).toHaveLength(1);
    expect(scanText(`k=${SK}${"A".repeat(10)}.${"b".repeat(15)}`)).toEqual([]);
  });

  it("ignores words that merely end in sk-", () => {
    expect(scanText("task-queue-consumer-handler-name\ndisk-usage-statistics-report-gen")).toEqual([]);
  });

  it("flags a PEM private key header", () => {
    const h = "-----BEGIN " + "PRIVATE KEY-----";
    expect(scanText(h).map((x) => x.redacted)).toEqual(["PEM private key…(redacted)"]);
    expect(scanText("-----BEGIN " + "OPENSSH PRIVATE KEY-----")).toHaveLength(1);
    expect(scanText("-----BEGIN " + "PUBLIC KEY-----")).toEqual([]);
  });
});

// ---- subprocess tests against temp git repos ------------------------------------------------

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "pg-secrets-"));
  dirs.push(dir);
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  return {
    dir,
    git,
    write(name, content) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    },
    run(script = SCRIPT) {
      const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
      return { code: r.status, out: r.stdout, err: r.stderr };
    },
  };
}

describe("check-secrets (subprocess)", () => {
  it("passes a clean repo and prints ok", () => {
    const r = repo();
    r.write("a.txt", "hello\n");
    const res = r.run();
    expect(res.code).toBe(0);
    expect(res.out).toContain("check:secrets: ok");
  });

  it("fails on an untracked file, naming file:line and not the value", () => {
    const r = repo();
    r.write("a.txt", `one\nOPENAI_API_KEY=${SK}${body(30)}\n`);
    const res = r.run();
    expect(res.code).toBe(1);
    expect(res.err).toContain("a.txt:2");
    expect(res.err).toContain("sk-…(redacted)");
    expect(res.err + res.out).not.toContain(body(20));
  });

  it("fails when the key was staged and the working copy was then deleted", () => {
    const r = repo();
    r.write("a.txt", SK + body(30));
    r.git("add", "a.txt");
    unlinkSync(join(r.dir, "a.txt"));
    const res = r.run();
    expect(res.code).toBe(1);
    expect(res.err).toContain("a.txt:1");
    expect(res.err).toContain("staged");
  });

  it("fails when the key was staged and the working copy was then scrubbed", () => {
    const r = repo();
    r.write("a.txt", SK + body(30));
    r.git("add", "a.txt");
    r.write("a.txt", "clean now\n");
    expect(r.run().code).toBe(1);
  });

  it("fails on a tracked file modified after commit (unstaged)", () => {
    const r = repo();
    r.write("a.txt", "clean\n");
    r.git("add", ".");
    r.git("commit", "-qm", "init");
    r.write("a.txt", `${SK}${body(30)}\n`);
    const res = r.run();
    expect(res.code).toBe(1);
    expect(res.err).toContain("working tree");
  });

  it("does not scan gitignored files", () => {
    const r = repo();
    r.write(".gitignore", "secret.txt\n");
    r.write("secret.txt", SK + body(30));
    expect(r.run().code).toBe(0);
  });

  it("excludes pnpm-lock.yaml at the root only", () => {
    const r = repo();
    r.write("pnpm-lock.yaml", SK + body(30));
    expect(r.run().code).toBe(0);
    r.write("sub/pnpm-lock.yaml", SK + body(30));
    expect(r.run().code).toBe(1);
  });

  it("reads UTF-16LE with BOM (PowerShell 5.1 redirect output)", () => {
    const r = repo();
    r.write(
      "ps.txt",
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`k=${SK}proj-${body(40)}\r\n`, "utf16le")]),
    );
    const res = r.run();
    expect(res.code).toBe(1);
    expect(res.err).toContain("ps.txt:1");
    expect(res.err).toContain("sk-proj-…(redacted)");
  });

  it("reads UTF-16LE and UTF-16BE without a BOM", () => {
    const r = repo();
    r.write("le.txt", Buffer.from(`some text here\n${SK}${body(30)}\n`, "utf16le"));
    expect(r.run().err).toContain("le.txt:2");
    const r2 = repo();
    r2.write("be.txt", Buffer.from(`some text here\n${SK}${body(30)}\n`, "utf16le").swap16());
    expect(r2.run().err).toContain("be.txt:2");
  });

  it("reads UTF-16BE with BOM", () => {
    const r = repo();
    r.write(
      "be.txt",
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(`${SK}${body(30)}`, "utf16le").swap16()]),
    );
    expect(r.run().code).toBe(1);
  });

  it("scans a file with stray NUL bytes instead of skipping it", () => {
    const r = repo();
    r.write("odd.dat", Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`\n${SK}${body(30)}\n`)]));
    expect(r.run().code).toBe(1);
  });

  it("skips known binary formats", () => {
    const r = repo();
    r.write("img.dat", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), Buffer.from(SK + body(30))]));
    r.write("pic.png", Buffer.from(SK + body(30)));
    expect(r.run().code).toBe(0);
  });

  it("reports the right line number in a CRLF file", () => {
    const r = repo();
    r.write("crlf.txt", `a\r\nb\r\n${SK}${body(30)}\r\nd\r\n`);
    expect(r.run().err).toContain("crlf.txt:3");
  });

  it.each([
    ["assignment", (k) => `key=${k}`],
    ["double quote", (k) => `"${k}"`],
    ["single quote", (k) => `'${k}'`],
    ["JSON-escaped newline", (k) => String.raw`{"a":"x\n` + k + `"}`],
    ["JSON-escaped tab", (k) => String.raw`{"a":"x\t` + k + `"}`],
    ["unicode escape", (k) => String.raw`"x\u000a` + k + `"`],
    ["hex escape", (k) => String.raw`"x\x0a` + k + `"`],
    ["URL-encoded newline", (k) => `?a=%0A${k}`],
    ["URL-encoded space", (k) => `?a=%20${k}`],
    ["bearer header", (k) => `Authorization: Bearer ${k}`],
  ])("detects a key after %s", (_name, wrap) => {
    const r = repo();
    r.write("f.txt", wrap(SK + "proj-" + body(40)));
    expect(r.run().code).toBe(1);
  });

  it("detects real-format keys containing - and _", () => {
    const r = repo();
    r.write("f.txt", SK + "proj-" + "Zx9_Yw8-Vu7_Ts6-Rq5_Po4-Nm3_Lk2-Ji1_Hg0".repeat(2) + "\n");
    expect(r.run().code).toBe(1);
  });

  it("applies the 20 character boundary end to end", () => {
    const r = repo();
    r.write("f.txt", SK + body(19));
    expect(r.run().code).toBe(0);
    r.write("f.txt", SK + body(20));
    expect(r.run().code).toBe(1);
  });

  it("detects the device key prefix and a PEM private key block", () => {
    const r = repo();
    r.write("d.txt", PGD + body(24));
    r.write("k.pem.txt", "-----BEGIN " + "PRIVATE KEY-----\nMC4C\n-----END " + "PRIVATE KEY-----\n");
    const res = r.run();
    expect(res.code).toBe(1);
    expect(res.err).toContain("d.txt:1");
    expect(res.err).toContain("k.pem.txt:1");
  });

  it("exits 2 outside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "pg-nogit-"));
    dirs.push(dir);
    const res = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
    expect(res.status).toBe(2);
  });

  it("still runs when started through a symlinked or junctioned path", () => {
    const r = repo();
    r.write("a.txt", SK + body(30));
    const holder = mkdtempSync(join(tmpdir(), "pg-link-"));
    dirs.push(holder);
    const link = join(holder, "scripts-link");
    symlinkSync(dirname(SCRIPT), link, "junction");
    const res = r.run(join(link, "check-secrets.mjs"));
    expect(res.code).toBe(1);
    expect(res.err).toContain("a.txt:1");
  });
});
