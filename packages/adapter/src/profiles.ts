// Profile resolution for the adapter (ADR-19, 04, adapter obligations).
//
// Every session-start and every turn-end re-resolves the active profile from the sources this
// process can trust: the bundled starters and the bundled `core` pack (marked `bundled` only because
// they come from bundled.generated.ts, obligation 2), plus local YAML under ~/.prosegate/profiles and
// ~/.prosegate/packs. profile.json is never read for policy. A resolution error falls back to
// local/base and produces a line naming the file at fault.

import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { compilePack, reviewRulesDetailed, PackCompileError, type CompiledPack } from "@prosegate/engine";
import {
  BUNDLED_PACK_YAML,
  ResolutionError,
  bundledPackSources,
  bundledProfileSources,
  isCorpusRef,
  parseProfileYaml,
  parseRulePackYaml,
  resolveProfile,
  type LocalOverlay,
  type PackVersionSource,
  type ResolutionSources,
  type ResolvedProfile,
  type RulePack,
} from "@prosegate/profiles";
import { safeInline } from "@prosegate/schema";
import type { Ctx } from "./ctx.js";
import { readFileOrNull } from "./fs-secure.js";
import { timed } from "./timing.js";

/** 04: the fallback that always resolves. Under org policy `required` it is the org's own base (ADR-18). */
export function baseProfileId(ctx: Pick<Ctx, "policy">): string {
  return ctx.policy?.enforcement_default === "required" ? `${ctx.policy.namespace}/base` : "local/base";
}
const MAX_LOCAL_FILES = 200;
const MAX_LOCAL_FILE_BYTES = 1_000_000;

export interface LocalProfileFile {
  /** Display name, e.g. `profiles/team.yaml`. */
  file: string;
  yaml: string;
}
export interface LocalPackFile {
  file: string;
  version: string;
  yaml: string;
}
export interface LocalLoad {
  profiles: Record<string, LocalProfileFile>;
  packs: Record<string, LocalPackFile[]>;
  /** Files that were skipped, one user-facing line each. */
  issues: string[];
}

// ---- memoised parsing (obligation 19: validated pack text is not re-filtered when unchanged) ------

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const packParseCache = new Map<string, { ok: true; value: RulePack } | { ok: false; message: string }>();
const profileParseCache = new Map<string, { ok: true; id: string } | { ok: false; message: string }>();
/** Counts real parse/validate runs, so a test can show that an unchanged pack is validated once per process. */
export const parseStats = { packParses: 0, profileParses: 0 };

function parsePackCached(yaml: string): { ok: true; value: RulePack } | { ok: false; message: string } {
  const key = sha(yaml);
  const hit = packParseCache.get(key);
  if (hit !== undefined) return hit;
  parseStats.packParses++;
  const parsed = parseRulePackYaml(yaml);
  const entry = parsed.ok ? ({ ok: true, value: parsed.value } as const) : ({ ok: false, message: parsed.error.message } as const);
  packParseCache.set(key, entry);
  return entry;
}

function parseProfileCached(yaml: string): { ok: true; id: string } | { ok: false; message: string } {
  const key = sha(yaml);
  const hit = profileParseCache.get(key);
  if (hit !== undefined) return hit;
  parseStats.profileParses++;
  const parsed = parseProfileYaml(yaml);
  const entry = parsed.ok ? ({ ok: true, id: parsed.value.id } as const) : ({ ok: false, message: parsed.error.message } as const);
  profileParseCache.set(key, entry);
  return entry;
}

export function clearParseCaches(): void {
  packParseCache.clear();
  profileParseCache.clear();
  parseStats.packParses = 0;
  parseStats.profileParses = 0;
}

function line(file: string, message: string): string {
  const text = safeInline(`${file}: ${message}`);
  return text.length > 220 ? `${text.slice(0, 219)}…` : text;
}

function readYamlDir(dir: string, label: string, issues: string[]): Array<{ file: string; yaml: string }> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ file: string; yaml: string }> = [];
  for (const name of names.filter((n) => n.endsWith(".yaml")).sort().slice(0, MAX_LOCAL_FILES)) {
    const path = join(dir, name);
    const file = `${label}/${name}`;
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      if (st.size > MAX_LOCAL_FILE_BYTES) {
        issues.push(line(file, "ignored, the file is larger than 1 MB"));
        continue;
      }
      const yaml = readFileOrNull(path);
      if (yaml !== null) out.push({ file, yaml });
    } catch {
      issues.push(line(file, "ignored, it could not be read"));
    }
  }
  return out;
}

/** Reads ~/.prosegate/profiles/*.yaml and ~/.prosegate/packs/*.yaml. A file that does not parse is skipped and reported. */
export function loadLocal(ctx: Ctx, exclude: ReadonlySet<string> = new Set()): LocalLoad {
  const issues: string[] = [];
  const profiles: Record<string, LocalProfileFile> = {};
  const packs: Record<string, LocalPackFile[]> = {};
  for (const f of readYamlDir(join(ctx.home, "profiles"), "profiles", issues)) {
    if (exclude.has(f.file)) continue;
    const parsed = parseProfileCached(f.yaml);
    if (!parsed.ok) {
      issues.push(line(f.file, parsed.message));
      continue;
    }
    if (Object.hasOwn(profiles, parsed.id)) {
      issues.push(line(f.file, `ignored, profile id ${parsed.id} is already defined by ${(profiles[parsed.id] as LocalProfileFile).file}`));
      continue;
    }
    profiles[parsed.id] = f;
  }
  for (const f of readYamlDir(join(ctx.home, "packs"), "packs", issues)) {
    if (exclude.has(f.file)) continue;
    const parsed = parsePackCached(f.yaml);
    if (!parsed.ok) {
      issues.push(line(f.file, parsed.message));
      continue;
    }
    const list = (packs[parsed.value.id] ??= []);
    if (list.some((p) => p.version === parsed.value.version)) {
      issues.push(line(f.file, `ignored, pack ${parsed.value.id} ${parsed.value.version} is already defined by another file`));
      continue;
    }
    list.push({ file: f.file, version: parsed.value.version, yaml: f.yaml });
  }
  return { profiles, packs, issues };
}

export function overlayOf(local: LocalLoad): LocalOverlay {
  return {
    profiles: Object.fromEntries(Object.entries(local.profiles).map(([id, p]) => [id, { yaml: p.yaml }])),
    packs: Object.fromEntries(Object.entries(local.packs).map(([id, list]) => [id, list.map((p) => p.version)])),
  };
}

// ---- resolution ---------------------------------------------------------------------------------

export interface Resolution {
  resolved: ResolvedProfile;
  /** The profile that was asked for; differs from resolved.id after a fallback. */
  requestedId: string;
  fellBack: boolean;
  /** One user-facing line per problem found (skipped local files, a failed resolution). */
  issues: string[];
  local: LocalLoad;
}

function fileForError(error: ResolutionError, local: LocalLoad): string | null {
  for (const id of error.ids) {
    const p = local.profiles[id];
    if (p !== undefined) return p.file;
    const packs = local.packs[id];
    if (packs?.[0] !== undefined) return packs[0].file;
  }
  return null;
}

/**
 * The sources a resolution may use: the bundled content, plus the verified synced content the config
 * client supplies (Phase 7; null in the free tier). Bundled ids win a clash.
 */
function sourcesFor(ctx: Pick<Ctx, "synced">): ResolutionSources {
  const bundledPacks = bundledPackSources();
  const packs: Record<string, PackVersionSource[]> = {};
  for (const [id, list] of Object.entries(ctx.synced?.packs ?? {})) packs[id] = [...list];
  for (const [id, list] of Object.entries(bundledPacks)) packs[id] = [...(packs[id] ?? []), ...list];
  return { profiles: { ...(ctx.synced?.profiles ?? {}), ...bundledProfileSources() }, packs };
}

/**
 * Resolves `requestedId` (ADR-19). On a ResolutionError it falls back to local/base, first with the
 * local files and then without them, and reports which file was at fault. Under an org policy of
 * `required` a fallback outside the org is refused by the resolver, so the error propagates and the
 * caller fails (Phase 7 decides what "fail closed" shows; the free tier has no policy).
 */
export function resolveSession(ctx: Ctx, requestedId: string, exclude: ReadonlySet<string> = new Set()): Resolution {
  const local = loadLocal(ctx, exclude);
  const issues = [...local.issues];
  const sources = sourcesFor(ctx);
  const policy = ctx.policy;
  const baseId = baseProfileId(ctx);
  try {
    const resolved = resolveProfile(requestedId, sources, { policy, local: overlayOf(local) });
    return { resolved, requestedId, fellBack: false, issues, local };
  } catch (error) {
    if (!(error instanceof ResolutionError)) throw error;
    const file = fileForError(error, local);
    issues.push(line(file ?? requestedId, `${error.message}; using ${baseId} instead`));
    if (requestedId !== baseId) {
      try {
        const resolved = resolveProfile(baseId, sources, { policy, local: overlayOf(local) });
        return { resolved, requestedId, fellBack: true, issues, local };
      } catch (second) {
        if (!(second instanceof ResolutionError)) throw second;
        const secondFile = fileForError(second, local);
        if (secondFile !== null && secondFile !== file) issues.push(line(secondFile, `${second.message}; local files ignored`));
      }
    }
    // Last resort: the bundled starters alone, with no local file at all.
    const resolved = resolveProfile(baseId, sources, { policy });
    return { resolved, requestedId, fellBack: true, issues, local: { profiles: {}, packs: {}, issues: local.issues } };
  }
}

/** The ids `prosegate profile <id>` accepts: bundled and local, restricted to the org's namespace under `required`. */
export function listProfileIds(ctx: Ctx): string[] {
  const local = loadLocal(ctx);
  const ids = new Set<string>([...Object.keys(sourcesFor(ctx).profiles), ...Object.keys(local.profiles)]);
  const policy = ctx.policy;
  const all = [...ids].sort();
  if (policy?.enforcement_default === "required") return all.filter((id) => id.split("/")[0] === policy.namespace);
  return all;
}

// ---- packs ----------------------------------------------------------------------------------------

export class PackLoadError extends Error {
  override readonly name = "PackLoadError";
  constructor(
    message: string,
    /** The local file at fault, or null for a bundled pack. */
    readonly file: string | null,
  ) {
    super(message);
  }
}

const exampleChecked = new Map<string, string | null>();

/**
 * Obligation 10 for local packs: every rule's hit examples must fire it and its miss examples must
 * not, evaluated as standalone documents with the floors bypassed. `<eval corpus ref: ...>`
 * examples name documents the adapter does not ship, so they are skipped. Returns the first problem, or null.
 */
export function verifyExamples(pack: RulePack, compiled: CompiledPack, resolved: ResolvedProfile): string | null {
  const pin = resolved.packs.find((p) => p.id === pack.id);
  if (pin === undefined) return null;
  const probe: ResolvedProfile = {
    ...resolved,
    packs: [pin],
    categories: {},
    rules: {},
    allow_terms: [],
    thresholds: { ...resolved.thresholds, token_floor_words: 0 },
  };
  const fires = (text: string, ruleId: string): boolean => {
    const { diagnostics } = reviewRulesDetailed({
      request: {
        schema: "prosegate.review/1",
        text,
        context: { user_message: "", style_constraints: "", mode: "interactive" },
        profile_id: resolved.id,
        pass: 1,
        stages: ["rules"],
        session_id: "examples",
        turn_id: "examples",
        prior_findings: [],
      },
      resolved: probe,
      packs: [compiled],
      enforce: false,
    });
    return diagnostics.candidates.some((c) => c.rule_id === ruleId);
  };
  for (const rule of pack.rules) {
    for (const example of rule.examples.hit) {
      if (!isCorpusRef(example) && !fires(example, rule.id)) return `rule ${rule.id} does not fire on its own hit example`;
    }
    for (const example of rule.examples.miss) {
      if (!isCorpusRef(example) && fires(example, rule.id)) return `rule ${rule.id} fires on its own miss example`;
    }
  }
  return null;
}

/**
 * Loads the body of every pack in `resolved.packs` by its exact (id, version, origin) and checks that
 * the body's own id and version match (obligation 9). Only snapshot.packs are loaded (obligation 15);
 * `synced` packs are not available in this item.
 */
export function loadPacks(resolved: ResolvedProfile, local: LocalLoad): CompiledPack[] {
  const out: CompiledPack[] = [];
  for (const pin of resolved.packs) {
    let yaml: string | undefined;
    let file: string | null = null;
    if (pin.origin === "bundled") {
      yaml = BUNDLED_PACK_YAML[`${pin.id}@${pin.version}`];
    } else if (pin.origin === "local") {
      const found = local.packs[pin.id]?.find((p) => p.version === pin.version);
      yaml = found?.yaml;
      file = found?.file ?? null;
    } else {
      throw new PackLoadError(`pack ${pin.id} ${pin.version} is synced content, which this build cannot load`, null);
    }
    if (yaml === undefined) throw new PackLoadError(`pack ${pin.id} ${pin.version} (${pin.origin}) has no body on this machine`, file);
    const parsed = parsePackCached(yaml);
    if (!parsed.ok) throw new PackLoadError(`pack ${pin.id} ${pin.version} is invalid: ${parsed.message}`, file);
    if (parsed.value.id !== pin.id || parsed.value.version !== pin.version) {
      throw new PackLoadError(`pack body says ${parsed.value.id} ${parsed.value.version}, but the profile pinned ${pin.id} ${pin.version}`, file);
    }
    let compiled: CompiledPack;
    try {
      compiled = compilePack(parsed.value);
    } catch (error) {
      if (error instanceof PackCompileError) throw new PackLoadError(`pack ${pin.id}: ${error.message}`, file);
      throw error;
    }
    if (pin.origin === "local") {
      const key = `${sha(yaml)}:${resolved.thresholds.token_floor_words}`;
      let problem = exampleChecked.get(key);
      if (problem === undefined) {
        problem = verifyExamples(parsed.value, compiled, resolved);
        exampleChecked.set(key, problem);
      }
      if (problem !== null) throw new PackLoadError(`pack ${pin.id}: ${problem}`, file);
    }
    out.push(compiled);
  }
  return out;
}

export interface LoadedSession extends Resolution {
  packs: CompiledPack[];
}

/**
 * resolveSession plus loadPacks, retrying without a local pack file that fails to load (a failed
 * local pack must not take the session down; the line names the file). `skipPacks` lets a caller that
 * will not review (mode off) avoid loading pack bodies at all.
 */
export function resolveAndLoad(ctx: Ctx, requestedId: string, skipPacks?: (resolved: ResolvedProfile) => boolean): LoadedSession {
  const exclude = new Set<string>();
  const extraIssues: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const resolution = timed("resolve", () => resolveSession(ctx, requestedId, exclude));
    if (skipPacks?.(resolution.resolved) === true) return { ...resolution, packs: [] };
    try {
      const packs = timed("packs", () => loadPacks(resolution.resolved, resolution.local));
      return { ...resolution, issues: [...resolution.issues, ...extraIssues], packs };
    } catch (error) {
      if (!(error instanceof PackLoadError) || error.file === null || exclude.has(error.file)) throw error;
      exclude.add(error.file);
      extraIssues.push(line(error.file, `${error.message}; file ignored`));
    }
  }
  throw new PackLoadError("local packs kept failing to load", null);
}

// ---- version summary (09 "profile updated" line) ----------------------------------------------------

/** Effective, comparable facts about a resolved profile: pack versions and the severity/enablement overrides. */
export function profileSummary(resolved: ResolvedProfile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of resolved.packs) out[`pack:${p.id}`] = p.version;
  for (const [category, o] of Object.entries(resolved.categories)) out[`category:${category}`] = o.severity;
  for (const [ruleId, o] of Object.entries(resolved.rules)) {
    out[`rule:${ruleId}`] = o.enabled?.value === false ? "off" : (o.severity?.value ?? "on");
  }
  return out;
}

export function countChanges(before: Record<string, string>, after: Record<string, string>): number {
  let n = 0;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[key] !== after[key]) n++;
  return n;
}
