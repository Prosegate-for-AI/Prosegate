import { z } from "zod";

function endpoint(value: string, originOnly: boolean): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
      (!originOnly || url.pathname === "/") && !/[\s<>]/.test(value);
  } catch { return false; }
}
export const ConfigSchema = z.strictObject({
  apiOrigin: z.string().refine((v) => endpoint(v, true), "Use an HTTPS API origin."),
  authority: z.string().refine((v) => endpoint(v, false), "Use an HTTPS OIDC issuer."),
  clientId: z.string().min(1).max(200),
});
export type Config = z.infer<typeof ConfigSchema>;
export function returnPath(value: unknown): string {
  return typeof value === "string" && /^\/(?:profiles|devices(?:\/approve)?|rule-packs|reviewer-keys|samples|usage|organization)$/.test(value) ? value : "/profiles";
}
