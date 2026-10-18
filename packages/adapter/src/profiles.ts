// Profile resolution for the adapter (ADR-19, 04, adapter obligations).
//
// Every session-start and every turn-end re-resolves the active profile from the sources this
// process can trust: the bundled starters and the bundled `core` pack (marked `bundled` only because
// they come from bundled.generated.ts, obligation 2), plus local YAML under ~/.prosegate/profiles and
// ~/.prosegate/packs. profile.json is never read for policy. A resolution error falls back to
// local/base and produces an issue naming the file at fault.
//
// Validation cost (ADR-29). Every hook is a fresh process, so an in-memory cache never hits. Every pack
// and profile file is parsed and checked (schema, injected-text filter) in every process; a parse is
// cheap. The one costly step is a local pack's example check, and ~/.prosegate/validated/ holds a marker
// per content hash saying it passed. That directory is writable by the agent, so a marker is a hash and
// nothing more: no rule, id or verdict is ever read back from disk (N3).

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
import { LOAD_DEADLINE_MS, type Ctx } from "./ctx.js";
import { ensureDirIn, readFileOrNull, writeFileAtomic } from "./fs-secure.js";
import { timed } from "./timing.js";
import { VERSION } from "./version.js";

/** 04: the fallback that always resolves. Under org policy `required` it is the org's own base (ADR-18). */
export function baseProfileId(ctx: Pick<Ctx, "policy">): string {
  return ctx.policy?.enforcement_default === "required" ? `${ctx.policy.namespace}/base` : "local/base";
}
const MAX_LOCAL_FILES = 200;
const MAX_LOCAL_FILE_BYTES = 1_000_000;

/** A problem with one of the user's own files, in words a person can act on. */
export interface Issue {
  /** Absolute path of the file at fault, or null when no file is to blame. */
  path: string | null;
  /** Parser-free reason, e.g. `invalid YAML, line 2`. */
  reason: string;
  /** The profile that was asked for could not be used and local/base took its place. */
  fellBack: boolean;
  /** The file was skipped (not used at all), as opposed to a profile that failed to resolve. */
  ignored: boolean;
}

export interface LocalProfileFile {
  /** Display name relative to the home, e.g. `profiles/team.yaml`. */
  file: string;
  /** Absolute path. */
  path: string;
  yaml: string;
}
export interface LocalPackFile {
  file: string;
  path: string;
  version: string;
  yaml: string;
}
export interface LocalLoad {
  profiles: Record<string, LocalProfileFile>;
  packs: Record<string, LocalPackFile[]>;
  /** Files that were skipped. */
  issues: Issue[];
  /** sha256 (16 hex) of the content of every local file that was read, keyed by `profiles/x.yaml`. */
  hashes: Record<string, string>;
}

// ---- parse memo and the examples marker ------------------------------------------------------------------

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

// Every pack and profile file is parsed in every process, so the schema checks and the injected-text
// filter always run on the actual text. The ONLY thing kept on disk is a marker that a local pack's
// examples passed for a content hash: those checks are the one costly step. The directory is writable
// by the agent, so a marker holds a hash and nothing else; it carries no rule, no id and no verdict
// the profile or the engine would read, and a forged or malformed one can at worst skip a sanity check
// on a file that is the user's own (N3).

const packMemo = new Map<string, { ok: true; value: RulePack } | { ok: false; message: string }>();
const profileMemo = new Map<string, { ok: true; id: string } | { ok: false; message: string }>();
const exampleMemo = new Map<string, string | null>();
/** Counts real parses and skipped example checks, so tests can show that an unchanged pack's examples run once. */
export const parseStats = { packParses: 0, profileParses: 0, exampleHits: 0 };

function markerPath(ctx: Ctx, key: string): string {
  return join(ctx.home, "validated", `${key.slice(0, 40)}.json`);
}

/** Whether a marker says this exact content's examples passed. Anything else in the file, or no file, is "no". */
function readExamplesMarker(ctx: Ctx, key: string): boolean {
  try {
    const text = readFileOrNull(markerPath(ctx, key));
    if (text === null) return false;
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && (v as Record<string, unknown>)["v"] === 1 && (v as Record<string, unknown>)["kind"] === "examples" && (v as Record<string, unknown>)["pack_hash"] === key;
  } catch {
    return false;
  }
}

function writeExamplesMarker(ctx: Ctx, key: string): void {
  try {
    ensureDirIn(ctx.home, join(ctx.home, "validated"), ctx.platform);
    writeFileAtomic(markerPath(ctx, key), JSON.stringify({ v: 1, kind: "examples", pack_hash: key }));
  } catch {
    // The marker is an optimisation; a failed write costs one more example check next time.
  }
}

export function packKey(yaml: string): string {
  return sha(`${VERSION}\0pack\0${yaml}`);
}

function parsePackCached(yaml: string): { ok: true; value: RulePack } | { ok: false; message: string } {
  const key = packKey(yaml);
  const hit = packMemo.get(key);
  if (hit !== undefined) return hit;
  parseStats.packParses++;
  const parsed = parseRulePackYaml(yaml);
  const entry = parsed.ok ? ({ ok: true, value: parsed.value } as const) : ({ ok: false, message: parsed.error.message } as const);
  packMemo.set(key, entry);
  return entry;
}

function parseProfileCached(yaml: string): { ok: true; id: string } | { ok: false; message: string } {
  const key = sha(`${VERSION}\0profile\0${yaml}`);
  const hit = profileMemo.get(key);
  if (hit !== undefined) return hit;
  parseStats.profileParses++;
  const parsed = parseProfileYaml(yaml);
  const entry = parsed.ok ? ({ ok: true, id: parsed.value.id } as const) : ({ ok: false, message: parsed.error.message } as const);
  profileMemo.set(key, entry);
  return entry;
}

export function clearParseCaches(): void {
  packMemo.clear();
  profileMemo.clear();
  exampleMemo.clear();
  parseStats.packParses = 0;
  parseStats.profileParses = 0;
  parseStats.exampleHits = 0;
}

// ---- issues in plain words -----------------------------------------------------------------------------

/**
 * The reason for a failed parse or resolution without parser vocabulary (UX S6): a YAML error becomes
 * `invalid YAML, line N`; schema problems become `not a valid profile (<first problem>)`; resolver
 * messages, which are already sentences, are clipped.
 */
export function plainReason(message: string, kind: "profile" | "pack"): string {
  const yaml = /YAML error \w+(?: at line (\d+))?/.exec(message);
  if (yaml !== null) return yaml[1] === undefined ? "invalid YAML" : `invalid YAML, line ${yaml[1]}`;
  if (/YAML (?:directives|aliases|anchors|tags)/.test(message)) return "uses YAML features that are not allowed";
  const invalid = /^(?:Profile|Rule pack|Pack)[^:]*is invalid: (.*)$/s.exec(message);
  if (invalid !== null) {
    const first = (invalid[1] ?? "").split(";")[0] ?? "";
    const clipped = safeInline(first).slice(0, 90);
    return `not a valid ${kind === "pack" ? "rule pack" : "profile"}${clipped === "" ? "" : ` (${clipped})`}`;
  }
  return safeInline(message).slice(0, 160);
}

function readYamlDir(ctx: Ctx, dir: string, label: string, issues: Issue[], hashes: Record<string, string>): Array<{ file: string; path: string; yaml: string }> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ file: string; path: string; yaml: string }> = [];
  const wanted = names.filter((n) => n.endsWith(".yaml")).sort();
  for (const [i, name] of wanted.slice(0, MAX_LOCAL_FILES).entries()) {
    const path = join(dir, name);
    const file = `${label}/${name}`;
    if (ctx.elapsedMs() > LOAD_DEADLINE_MS) {
      issues.push({ path: dir, reason: `${wanted.length - i} more files were not read because loading took too long`, fellBack: false, ignored: true });
      break;
    }
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      if (st.size > MAX_LOCAL_FILE_BYTES) {
        issues.push({ path, reason: "the file is larger than 1 MB", fellBack: false, ignored: true });
        continue;
      }
      const yaml = readFileOrNull(path);
      if (yaml !== null) {
        hashes[file] = sha(yaml).slice(0, 16);
        out.push({ file, path, yaml });
      }
    } catch {
      issues.push({ path, reason: "it could not be read", fellBack: false, ignored: true });
    }
  }
  return out;
}

/** Reads ~/.prosegate/profiles/*.yaml and ~/.prosegate/packs/*.yaml. A file that does not parse is skipped and reported. */
export function loadLocal(ctx: Ctx, exclude: ReadonlySet<string> = new Set()): LocalLoad {
  const issues: Issue[] = [];
  const hashes: Record<string, string> = {};
  const profiles: Record<string, LocalProfileFile> = {};
  const packs: Record<string, LocalPackFile[]> = {};
  for (const f of readYamlDir(ctx, join(ctx.home, "profiles"), "profiles", issues, hashes)) {
    if (exclude.has(f.file)) continue;
    const parsed = parseProfileCached(f.yaml);
    if (!parsed.ok) {
      issues.push({ path: f.path, reason: plainReason(parsed.message, "profile"), fellBack: false, ignored: true });
      continue;
    }
    if (Object.hasOwn(profiles, parsed.id)) {
      issues.push({ path: f.path, reason: `profile ${parsed.id} is already defined by ${(profiles[parsed.id] as LocalProfileFile).path}`, fellBack: false, ignored: true });
      continue;
    }
    profiles[parsed.id] = f;
  }
  for (const f of readYamlDir(ctx, join(ctx.home, "packs"), "packs", issues, hashes)) {
    if (exclude.has(f.file)) continue;
    const parsed = parsePackCached(f.yaml);
    if (!parsed.ok) {
      issues.push({ path: f.path, reason: plainReason(parsed.message, "pack"), fellBack: false, ignored: true });
      continue;
    }
    const list = (packs[parsed.value.id] ??= []);
    if (list.some((p) => p.version === parsed.value.version)) {
      issues.push({ path: f.path, reason: `pack ${parsed.value.id} ${parsed.value.version} is already defined by another file`, fellBack: false, ignored: true });
      continue;
    }
    list.push({ file: f.file, path: f.path, version: parsed.value.version, yaml: f.yaml });
  }
  return { profiles, packs, issues, hashes };
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
  /** One entry per problem found (skipped local files, a failed resolution). */
  issues: Issue[];
  local: LocalLoad;
}

function fileForError(error: ResolutionError, local: LocalLoad): string | null {
  for (const id of error.ids) {
    const p = local.profiles[id];
    if (p !== undefined) return p.path;
    const packs = local.packs[id];
    if (packs?.[0] !== undefined) return packs[0].path;
  }
  return null;
}

/**
 * The sources a resolution may use: the bundled content, plus the verified synced content the config
 * client supplies (Phase 7; null in the free tier). Bundled ids win a clash.
 */
export function sourcesFor(ctx: Pick<Ctx, "synced">): ResolutionSources {
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
  const issues: Issue[] = [...local.issues];
  const sources = sourcesFor(ctx);
  const policy = ctx.policy;
  const baseId = baseProfileId(ctx);
  try {
    const resolved = resolveProfile(requestedId, sources, { policy, local: overlayOf(local) });
    return { resolved, requestedId, fellBack: false, issues, local };
  } catch (error) {
    if (!(error instanceof ResolutionError)) throw error;
    issues.push({ path: fileForError(error, local), reason: plainReason(error.message, "profile"), fellBack: true, ignored: false });
    if (requestedId !== baseId) {
      try {
        const resolved = resolveProfile(baseId, sources, { policy, local: overlayOf(local) });
        return { resolved, requestedId, fellBack: true, issues, local };
      } catch (second) {
        if (!(second instanceof ResolutionError)) throw second;
        const secondFile = fileForError(second, local);
        if (secondFile !== null) issues.push({ path: secondFile, reason: `${plainReason(second.message, "profile")}; local files were not used`, fellBack: false, ignored: true });
      }
    }
    // Last resort: the bundled starters alone, with no local file at all.
    const resolved = resolveProfile(baseId, sources, { policy });
    return { resolved, requestedId, fellBack: true, issues, local: { profiles: {}, packs: {}, issues: local.issues, hashes: local.hashes } };
  }
}

/** The same profile as the bundled and synced sources define it, with no local file applied; null if it has no such definition. */
export function resolveBaseline(ctx: Ctx, id: string): ResolvedProfile | null {
  try {
    return resolveProfile(id, sourcesFor(ctx), { policy: ctx.policy });
  } catch {
    return null;
  }
}

/** The ids `prosegate profile <id>` knows about. `valid` is what it accepts: restricted to the org's namespace under `required`. */
export function listProfileIds(ctx: Ctx): { all: string[]; valid: string[] } {
  const local = loadLocal(ctx);
  const ids = new Set<string>([...Object.keys(sourcesFor(ctx).profiles), ...Object.keys(local.profiles)]);
  const policy = ctx.policy;
  const all = [...ids].sort();
  if (policy?.enforcement_default === "required") return { all, valid: all.filter((id) => id.split("/")[0] === policy.namespace) };
  return { all, valid: all };
}

// ---- packs ----------------------------------------------------------------------------------------

export class PackLoadError extends Error {
  override readonly name = "PackLoadError";
  constructor(
    message: string,
    /** The local file at fault (display name), or null for a bundled pack. */
    readonly file: string | null,
    readonly path: string | null = null,
    /** The same problem in words for the user. */
    readonly reason: string = message,
  ) {
    super(message);
  }
}

/**
 * Obligation 10 for local packs: every rule's hit examples must fire it and its miss examples must
 * not, evaluated as standalone documents with the floors bypassed. `<eval corpus ref: ...>`
 * examples name documents the adapter does not ship, so they are skipped. Returns the first problem,
 * or null. `deadline` is a process-elapsed millisecond mark after which the check gives up.
 */
export function verifyExamples(
  pack: RulePack,
  compiled: CompiledPack,
  resolved: ResolvedProfile,
  deadline: { elapsedMs: () => number; atMs: number } | null = null,
): string | null {
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
    if (deadline !== null && deadline.elapsedMs() > deadline.atMs) return "its examples could not be checked in time";
    for (const example of rule.examples.hit) {
      if (!isCorpusRef(example) && !fires(example, rule.id)) return `rule ${rule.id} does not fire on its own hit example`;
    }
    for (const example of rule.examples.miss) {
      if (!isCorpusRef(example) && fires(example, rule.id)) return `rule ${rule.id} fires on its own miss example`;
    }
  }
  return null;
}

export interface LoadedPacks {
  compiled: CompiledPack[];
  /** The parsed bodies, in the same order (the "profile updated" fingerprints read them). */
  bodies: RulePack[];
}

/**
 * Loads the body of every pack in `resolved.packs` by its exact (id, version, origin) and checks that
 * the body's own id and version match (obligation 9). Only snapshot.packs are loaded (obligation 15);
 * `synced` packs are not available in this item.
 */
export function loadPacks(ctx: Ctx, resolved: ResolvedProfile, local: LocalLoad): LoadedPacks {
  const compiled: CompiledPack[] = [];
  const bodies: RulePack[] = [];
  for (const pin of resolved.packs) {
    let yaml: string | undefined;
    let file: string | null = null;
    let path: string | null = null;
    if (pin.origin === "bundled") {
      yaml = BUNDLED_PACK_YAML[`${pin.id}@${pin.version}`];
    } else if (pin.origin === "local") {
      const found = local.packs[pin.id]?.find((p) => p.version === pin.version);
      yaml = found?.yaml;
      file = found?.file ?? null;
      path = found?.path ?? null;
    } else {
      throw new PackLoadError(`pack ${pin.id} ${pin.version} is synced content, which this build cannot load`, null);
    }
    if (yaml === undefined) throw new PackLoadError(`pack ${pin.id} ${pin.version} (${pin.origin}) has no body on this machine`, file, path);
    const parsed = parsePackCached(yaml);
    if (!parsed.ok) throw new PackLoadError(`pack ${pin.id} ${pin.version} is invalid: ${parsed.message}`, file, path, plainReason(parsed.message, "pack"));
    if (parsed.value.id !== pin.id || parsed.value.version !== pin.version) {
      throw new PackLoadError(`pack body says ${parsed.value.id} ${parsed.value.version}, but the profile pinned ${pin.id} ${pin.version}`, file, path, "the file changed while it was being read");
    }
    let pack: CompiledPack;
    try {
      pack = compilePack(parsed.value);
    } catch (error) {
      if (error instanceof PackCompileError) throw new PackLoadError(`pack ${pin.id}: ${error.message}`, file, path, "a pattern in it does not compile");
      throw error;
    }
    if (pin.origin === "local") {
      const key = packKey(yaml);
      let problem = exampleMemo.get(key);
      if (problem === undefined && readExamplesMarker(ctx, key)) {
        // The examples passed for exactly this text in an earlier process. Only the example checks are skipped:
        // the file was parsed and compiled above.
        parseStats.exampleHits++;
        problem = null;
        exampleMemo.set(key, null);
      }
      if (problem === undefined) {
        problem = verifyExamples(parsed.value, pack, resolved, { elapsedMs: ctx.elapsedMs, atMs: LOAD_DEADLINE_MS });
        if (problem === null) {
          writeExamplesMarker(ctx, key);
          exampleMemo.set(key, null);
        } else if (!problem.includes("in time")) {
          exampleMemo.set(key, problem);
        }
      }
      if (problem !== null && problem !== undefined) throw new PackLoadError(`pack ${pin.id}: ${problem}`, file, path, problem);
    }
    compiled.push(pack);
    bodies.push(parsed.value);
  }
  return { compiled, bodies };
}

export interface LoadedSession extends Resolution {
  packs: CompiledPack[];
  bodies: RulePack[];
}

/**
 * resolveSession plus loadPacks, retrying without a local pack file that fails to load (a failed
 * local pack must not take the session down; the issue names the file). `skipPacks` lets a caller that
 * will not review (mode off) avoid loading pack bodies at all.
 */
export function resolveAndLoad(ctx: Ctx, requestedId: string, skipPacks?: (resolved: ResolvedProfile) => boolean): LoadedSession {
  const exclude = new Set<string>();
  const extraIssues: Issue[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const resolution = timed("resolve", () => resolveSession(ctx, requestedId, exclude));
    if (skipPacks?.(resolution.resolved) === true) return { ...resolution, packs: [], bodies: [] };
    try {
      const loaded = timed("packs", () => loadPacks(ctx, resolution.resolved, resolution.local));
      return { ...resolution, issues: [...resolution.issues, ...extraIssues], packs: loaded.compiled, bodies: loaded.bodies };
    } catch (error) {
      if (!(error instanceof PackLoadError) || error.file === null || exclude.has(error.file)) throw error;
      exclude.add(error.file);
      extraIssues.push({
        path: error.path,
        reason: error.reason,
        fellBack: false,
        ignored: true,
      });
    }
  }
  throw new PackLoadError("local packs kept failing to load", null);
}

// ---- version summary (09 "profile updated" line) ----------------------------------------------------

/**
 * What the "profile updated" line compares (ADR-28): the pack versions the profile pinned and a
 * fingerprint of every rule in them. A local overlay changes neither, so the user's own `rule off`
 * never counts as an update.
 */
export function profileSummary(resolved: ResolvedProfile, bodies: readonly RulePack[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of resolved.packs) out[`pack:${p.id}`] = p.version;
  for (const body of bodies) {
    for (const rule of body.rules) out[`rule:${rule.id}`] = sha(JSON.stringify(rule)).slice(0, 8);
  }
  return out;
}

export function integerVersion(version: string): string {
  return version.split("+")[0] ?? version;
}

/** The result of comparing two summaries: fires when the integer version or a pinned pack moved. */
export function profileUpdate(
  prior: { version: string; summary: Record<string, string> },
  now: { version: string; summary: Record<string, string> },
): { fires: boolean; rulesChanged: number } {
  let packMoved = false;
  let rulesChanged = 0;
  for (const key of new Set([...Object.keys(prior.summary), ...Object.keys(now.summary)])) {
    if (prior.summary[key] === now.summary[key]) continue;
    if (key.startsWith("pack:")) packMoved = true;
    else rulesChanged++;
  }
  return { fires: integerVersion(prior.version) !== integerVersion(now.version) || packMoved, rulesChanged };
}
