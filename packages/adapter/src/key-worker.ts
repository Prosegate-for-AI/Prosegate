import { randomBytes } from "node:crypto";

export type KeyAccount = "openai" | "anthropic";
export interface KeyOperation { op: "probe" | "get" | "set" | "delete"; service: string; account: KeyAccount; value?: string }
export type KeyReply = { ok: true; value?: string | null } | { ok: false; reason: "unavailable" | "timeout" };

/** Private pipe protocol. Never run against an arbitrary service/account supplied by a provider. */
export async function keyWorker(raw: string): Promise<KeyReply> {
  try {
    const input = JSON.parse(raw) as KeyOperation;
    if (!/^prosegate-[a-f0-9]{16}$/.test(input.service) || !["openai", "anthropic"].includes(input.account)) return { ok: false, reason: "unavailable" };
    const { Entry } = await import("@napi-rs/keyring");
    const account = input.op === "probe" ? `probe-${randomBytes(16).toString("hex")}` : `reviewer-${input.account}`;
    const entry = new Entry(input.service, account, process.platform === "linux" ? { linux: { store: "secret-service" } } : undefined);
    switch (input.op) {
      case "probe": {
        const value = randomBytes(16).toString("hex");
        try { entry.setPassword(value); return entry.getPassword() === value ? { ok: true } : { ok: false, reason: "unavailable" }; }
        finally { entry.deletePassword(); }
      }
      case "get": return { ok: true, value: entry.getPassword() };
      case "set":
        if (!input.value || input.value.length > 1000 || !/^[\x21-\x7e]+$/.test(input.value)) return { ok: false, reason: "unavailable" };
        entry.setPassword(input.value);
        return { ok: true };
      case "delete": entry.deletePassword(); return { ok: true };
      default: return { ok: false, reason: "unavailable" };
    }
  } catch { return { ok: false, reason: "unavailable" }; }
}
