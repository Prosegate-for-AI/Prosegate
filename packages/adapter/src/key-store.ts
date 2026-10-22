import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Ctx } from "./ctx.js";
import { ensureHomeRestricted, restrictToOwner, writeFileAtomic } from "./fs-secure.js";
import type { KeyAccount, KeyOperation, KeyReply } from "./key-worker.js";

const KEYRING_VERSION = "2.1.1";
const State = z.strictObject({ backend: z.enum(["keychain", "file"]), reason: z.enum(["forced", "probe_failed"]).nullable(), probedAt: z.number(), fingerprint: z.string(), fileNoticeShown: z.boolean(), reprobe: z.boolean() });
type StoreState = z.infer<typeof State>;
const Secret = z.string().min(1).max(1000).regex(/^[\x21-\x7e]+$/);
const Secrets = z.strictObject({ openai: Secret.optional(), anthropic: Secret.optional() });
type Secrets = z.infer<typeof Secrets>;
export const FILE_STORE_NOTICE = "Prosegate: the OS keychain is unavailable or file storage was requested. Reviewer keys are stored in an owner-only local file; administrators can still access it.";
export class KeyStoreError extends Error {
  constructor(readonly code: "keychain_unavailable" | "keychain_timeout" | "key_file_unsafe" | "key_invalid" | "key_store_busy") { super(code); }
}
export type KeyRunner = (operation: KeyOperation, timeoutMs: number) => Promise<KeyReply>;

/** Secrets travel over pipes, never argv, environment, logs or uncaught exception messages. */
export function nativeKeyRunner(operation: KeyOperation, timeoutMs: number, entry = process.argv[1], execArgs = process.execArgv): Promise<KeyReply> {
  return new Promise((done) => {
    if (!entry) { done({ ok: false, reason: "unavailable" }); return; }
    const child = spawn(process.execPath, [...execArgs, entry, "--key-store-worker"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let output = "";
    let finished = false;
    const finish = (reply: KeyReply) => { if (!finished) { finished = true; clearTimeout(timer); done(reply); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ ok: false, reason: "timeout" }); }, timeoutMs);
    child.on("error", () => finish({ ok: false, reason: "unavailable" }));
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (part: string) => {
      output += part;
      if (output.length > 8192) { child.kill("SIGKILL"); finish({ ok: false, reason: "unavailable" }); }
    });
    child.on("close", (code) => {
      try {
        const r = JSON.parse(output) as KeyReply;
        if (code !== 0 || r.ok !== true || (r.value !== undefined && r.value !== null && !Secret.safeParse(r.value).success)) finish({ ok: false, reason: "unavailable" });
        else finish(r);
      } catch { finish({ ok: false, reason: "unavailable" }); }
    });
    child.stdin.end(JSON.stringify(operation));
  });
}

/** Refuse unsafe files rather than repairing permissions after reading a secret. */
function readSecrets(path: string, platform: NodeJS.Platform): Secrets {
  if (!existsSync(path)) return {};
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new KeyStoreError("key_file_unsafe");
    fd = openSync(path, constants.O_RDONLY | (platform === "win32" ? 0 : constants.O_NOFOLLOW));
    const st = fstatSync(fd);
    if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev || st.size > 8192 || st.nlink !== 1 || (platform !== "win32" && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()))) throw new KeyStoreError("key_file_unsafe");
    return Secrets.parse(JSON.parse(readFileSync(fd, "utf8")));
  } catch { throw new KeyStoreError("key_file_unsafe"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function writeSecrets(ctx: Ctx, values: Secrets): void {
  const directory = join(ctx.home, `.keys-${randomBytes(12).toString("hex")}`);
  mkdirSync(directory, { mode: 0o700 });
  const temp = join(directory, "keys.json");
  let fd: number | undefined;
  try {
    // Restrict the empty directory before any secret bytes exist, including on Windows.
    restrictToOwner(directory, true, ctx.platform);
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(values));
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    restrictToOwner(temp, false, ctx.platform);
    renameSync(temp, join(ctx.home, "keys.json"));
  } catch { throw new KeyStoreError("key_file_unsafe"); }
  finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* already renamed */ }
    try { rmdirSync(directory); } catch { /* preserve a directory we could not clean */ }
  }
}

export class KeyStore {
  private readonly statePath: string;
  private readonly keyPath: string;
  private readonly service: string;
  constructor(private readonly ctx: Ctx, private readonly runner: KeyRunner = nativeKeyRunner) {
    this.statePath = join(ctx.home, "key-store.json");
    this.keyPath = join(ctx.home, "keys.json");
    // Homes are independent, including tests, relocated installs and multiple OS users.
    this.service = `prosegate-${createHash("sha256").update(resolve(ctx.home)).digest("hex").slice(0, 16)}`;
  }
  private state(): StoreState | null {
    try { return State.parse(JSON.parse(readFileSync(this.statePath, "utf8"))); } catch { return null; }
  }
  private save(state: StoreState): void { writeFileAtomic(this.statePath, JSON.stringify(state)); }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    if (existsSync(this.ctx.home) && lstatSync(this.ctx.home).isSymbolicLink()) throw new KeyStoreError("key_file_unsafe");
    ensureHomeRestricted(this.ctx.home, this.ctx.platform);
    const home = lstatSync(this.ctx.home);
    if (!home.isDirectory() || home.isSymbolicLink() || (this.ctx.platform !== "win32" && ((home.mode & 0o077) !== 0 || home.uid !== process.getuid?.()))) throw new KeyStoreError("key_file_unsafe");
    const path = join(this.ctx.home, "key-store.lock");
    const until = Date.now() + 3000;
    let fd: number;
    for (;;) {
      try { fd = openSync(path, "wx", 0o600); break; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new KeyStoreError("key_file_unsafe");
        if (Date.now() >= until) throw new KeyStoreError("key_store_busy");
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    const token = randomBytes(16).toString("hex");
    try { writeFileSync(fd, token); } finally { closeSync(fd); }
    try { return await fn(); }
    finally { try { if (readFileSync(path, "utf8") === token) unlinkSync(path); } catch { /* never remove another owner's lock */ } }
  }
  private operation(op: KeyOperation["op"], account: KeyAccount, value?: string): KeyOperation { return { op, account, service: this.service, ...(value === undefined ? {} : { value }) }; }
  private async native(op: KeyOperation, timeout = 1000): Promise<string | null> {
    let r: KeyReply;
    try { r = await this.runner(op, timeout); } catch { throw new KeyStoreError("keychain_unavailable"); }
    if (!r.ok) throw new KeyStoreError(r.reason === "timeout" ? "keychain_timeout" : "keychain_unavailable");
    return r.value ?? null;
  }
  /** Explicit setup/review commands may probe/migrate. Automatic hooks use get() without probing. */
  async prepare(): Promise<{ backend: "file" | "keychain"; notice: string | null }> {
    return this.locked(() => this.prepareLocked());
  }
  private async prepareLocked(): Promise<{ backend: "file" | "keychain"; notice: string | null }> {
    ensureHomeRestricted(this.ctx.home, this.ctx.platform);
    const directory = lstatSync(this.ctx.home);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new KeyStoreError("key_file_unsafe");
    const before = this.state();
    const forced = this.ctx.env["PROSEGATE_KEY_STORE"];
    if (forced && forced !== "file" && forced !== "keychain") throw new KeyStoreError("key_invalid");
    const report = this.ctx.platform === "linux" ? process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } : undefined;
    const libc = this.ctx.platform === "linux" ? report?.header?.glibcVersionRuntime ?? "musl" : "native";
    const fingerprint = `${this.ctx.platform}-${process.arch}-${libc}-${process.versions.modules}-${KEYRING_VERSION}`;
    const expired = !before || before.reprobe || before.fingerprint !== fingerprint || this.ctx.now() - before.probedAt > 7 * 86400_000 || (forced && forced !== before.backend) || (!forced && before.reason === "forced");
    let state = before;
    if (expired) {
      let backend: StoreState["backend"] = "file";
      if (forced !== "file") {
        try { await this.native(this.operation("probe", "openai"), 1500); backend = "keychain"; }
        catch (e) { if (forced === "keychain") throw e; }
      }
      if (backend === "keychain" && existsSync(this.keyPath)) {
        const values = readSecrets(this.keyPath, this.ctx.platform);
        for (const account of ["openai", "anthropic"] as const) {
          const value = values[account];
          if (value !== undefined) {
            await this.native(this.operation("set", account, value));
            if (await this.native(this.operation("get", account)) !== value) throw new KeyStoreError("keychain_unavailable");
          }
        }
        // Only remove the file after every copied key has been read back.
        unlinkSync(this.keyPath);
      }
      state = { backend, reason: backend === "keychain" ? null : forced === "file" ? "forced" : "probe_failed", fingerprint, probedAt: this.ctx.now(), fileNoticeShown: before?.fileNoticeShown ?? false, reprobe: false };
      this.save(state);
    }
    if (!state) throw new KeyStoreError("keychain_unavailable");
    const notice = state.backend === "file" && !state.fileNoticeShown ? FILE_STORE_NOTICE : null;
    if (notice) this.save({ ...state, fileNoticeShown: true });
    return { backend: state.backend, notice };
  }
  /** No probing or silent backend changes on the read path. */
  async get(account: KeyAccount): Promise<string | null> {
    return this.locked(async () => {
      const state = this.state();
      if (!state) return null;
      if (state.backend === "file") return readSecrets(this.keyPath, this.ctx.platform)[account] ?? null;
      try { return await this.native(this.operation("get", account)); }
      catch (e) { this.save({ ...state, reprobe: true }); throw e; }
    });
  }
  async set(account: KeyAccount, value: string): Promise<void> {
    if (!Secret.safeParse(value).success) throw new KeyStoreError("key_invalid");
    return this.locked(async () => {
      const state = this.state();
      if (!state) throw new KeyStoreError("keychain_unavailable");
      if (state.backend === "keychain") { await this.native(this.operation("set", account, value)); return; }
      writeSecrets(this.ctx, { ...readSecrets(this.keyPath, this.ctx.platform), [account]: value });
    });
  }
  async remove(account: KeyAccount): Promise<void> {
    return this.locked(async () => {
      const state = this.state();
      if (!state) return;
      if (state.backend === "keychain") { await this.native(this.operation("delete", account)); return; }
      const values = readSecrets(this.keyPath, this.ctx.platform);
      Reflect.deleteProperty(values, account);
      writeSecrets(this.ctx, values);
    });
  }
}
