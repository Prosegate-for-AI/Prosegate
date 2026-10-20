import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCtx } from "../src/ctx.js";
import { KeyStore, nativeKeyRunner, type KeyRunner } from "../src/key-store.js";
import { keyWorker } from "../src/key-worker.js";
import { tmpDir } from "./helpers.js";

const context = (force: string | null = "file") => createCtx({ home: tmpDir(), env: force ? { PROSEGATE_KEY_STORE: force } : {}, elapsedMs: () => 0 });
describe("reviewer key storage", () => {
  it("kills a hung native child and confines values to its private pipe", async () => {
    const root = tmpDir();
    const worker = join(root, "worker.mjs");
    writeFileSync(worker, 'let data="";for await (const c of process.stdin) data+=c;const r=JSON.parse(data);process.stdout.write(JSON.stringify({ok:!process.argv.join(" ").includes(r.value),value:r.value}));');
    const operation = { op: "set" as const, service: "prosegate-0000000000000000", account: "openai" as const, value: "dummy-private-value" };
    expect(await nativeKeyRunner(operation, 2000, worker, [])).toEqual({ ok: true, value: "dummy-private-value" });
    writeFileSync(worker, 'setInterval(()=>{},1000);');
    const start = performance.now();
    expect(await nativeKeyRunner(operation, 100, worker, [])).toEqual({ ok: false, reason: "timeout" });
    expect(performance.now() - start).toBeLessThan(2000);
    writeFileSync(worker, 'process.stderr.write("dummy-private-value");process.stdout.write("not json");');
    expect(await nativeKeyRunner(operation, 2000, worker, [])).toEqual({ ok: false, reason: "unavailable" });
  });
  it("round-trips file keys without involving the native store and warns once", async () => {
    const ctx = context(); const native = vi.fn<KeyRunner>(); const store = new KeyStore(ctx, native);
    expect((await store.prepare()).notice).toContain("owner-only");
    expect((await store.prepare()).notice).toBeNull();
    await store.set("openai", "dummy-private-value");
    await store.set("anthropic", "dummy-other-value");
    expect(await store.get("openai")).toBe("dummy-private-value");
    expect(readFileSync(join(ctx.home, "key-store.json"), "utf8")).not.toContain("dummy-private-value");
    await store.remove("openai");
    expect(await store.get("openai")).toBeNull();
    expect(await store.get("anthropic")).toBe("dummy-other-value");
    expect(native).not.toHaveBeenCalled();
    if (process.platform !== "win32") expect(statSync(join(ctx.home, "keys.json")).mode & 0o777).toBe(0o600);
  });
  it("rejects oversized, control-containing and whitespace-containing keys", async () => {
    const store = new KeyStore(context(), vi.fn<KeyRunner>()); await store.prepare();
    for (const value of ["", "a".repeat(1001), "a b", "a\nb", "a\u0000b"]) await expect(store.set("openai", value)).rejects.toThrow("key_invalid");
  });
  it("never persists native keys and a failed read marks reprobe without changing backend", async () => {
    const ctx = context(null);
    const native = vi.fn<KeyRunner>().mockResolvedValue({ ok: true });
    const store = new KeyStore(ctx, native); await store.prepare();
    await store.set("openai", "dummy-private-value");
    expect(existsSync(join(ctx.home, "keys.json"))).toBe(false);
    native.mockResolvedValue({ ok: false, reason: "timeout" });
    await expect(store.get("openai")).rejects.toThrow("keychain_timeout");
    expect(JSON.parse(readFileSync(join(ctx.home, "key-store.json"), "utf8"))).toMatchObject({ backend: "keychain", reprobe: true });
    expect(native.mock.calls.map(([, limit]) => limit)).toEqual([1500, 1000, 1000]);
  });
  it("falls back on probe failure but forced keychain fails explicitly", async () => {
    const native = vi.fn<KeyRunner>().mockResolvedValue({ ok: false, reason: "unavailable" });
    expect((await new KeyStore(context(null), native).prepare()).backend).toBe("file");
    await expect(new KeyStore(context("keychain"), native).prepare()).rejects.toThrow("keychain_unavailable");
  });
  it("migrates only after all keys are read back, retaining the file on failure", async () => {
    for (const success of [false, true]) {
      const ctx = context(); const store = new KeyStore(ctx); await store.prepare(); await store.set("openai", "dummy-private-value");
      const native = vi.fn<KeyRunner>().mockImplementation(async (op) => ({ ok: true, ...(op.op === "get" ? { value: success ? "dummy-private-value" : "different" } : {}) }));
      const moved = new KeyStore({ ...ctx, env: { PROSEGATE_KEY_STORE: "keychain" } }, native);
      if (success) { await moved.prepare(); expect(existsSync(join(ctx.home, "keys.json"))).toBe(false); }
      else { await expect(moved.prepare()).rejects.toThrow("keychain_unavailable"); expect(existsSync(join(ctx.home, "keys.json"))).toBe(true); }
    }
  });
  it("serializes concurrent updates so one provider does not overwrite the other", async () => {
    const ctx = context(); const a = new KeyStore(ctx); const b = new KeyStore(ctx); await a.prepare();
    await Promise.all([a.set("openai", "first"), b.set("anthropic", "second")]);
    expect(await a.get("openai")).toBe("first"); expect(await b.get("anthropic")).toBe("second");
  });
  it("isolates native namespaces between homes and rejects invalid worker requests", async () => {
    const native = vi.fn<KeyRunner>().mockResolvedValue({ ok: true });
    await new KeyStore(context(null), native).prepare(); await new KeyStore(context(null), native).prepare();
    expect(native.mock.calls[0]?.[0].service).not.toBe(native.mock.calls[1]?.[0].service);
    expect(await keyWorker(JSON.stringify({ service: "someone-elses-store", account: "openai", op: "get" }))).toEqual({ ok: false, reason: "unavailable" });
  });
  it("refuses malformed secret files instead of overwriting them", async () => {
    const ctx = context(); const store = new KeyStore(ctx); await store.prepare();
    writeFileSync(join(ctx.home, "keys.json"), "broken", { mode: 0o600 });
    await expect(store.set("openai", "valid")).rejects.toThrow("key_file_unsafe");
    expect(readFileSync(join(ctx.home, "keys.json"), "utf8")).toBe("broken");
  });
  it.skipIf(process.platform === "win32")("refuses a group/world-readable secret file", async () => {
    const ctx = context(); const store = new KeyStore(ctx); await store.prepare(); await store.set("openai", "dummy-private-value");
    chmodSync(join(ctx.home, "keys.json"), 0o644);
    await expect(store.get("openai")).rejects.toThrow("key_file_unsafe");
  });
});
