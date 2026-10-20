// Stdio only. Hook/session state supplies context; tool arguments can never supply policy or pass counts.
import type { Readable, Writable } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { reviewRulesDetailed } from "@prosegate/engine";
import { ProfileIdSchema, type ReviewResult } from "@prosegate/schema";
import { ENGINE_BUDGET_MAX_MS, SESSION_ID_RE, type Ctx } from "./ctx.js";
import { resolveAndLoad } from "./profiles.js";
import { selectableProfiles, selectProfile } from "./selection.js";
import { listSessions, normaliseCwd, SessionStore, SESSION_LIVE_MS, TURN_FILE_TTL_MS } from "./store.js";
import { VERSION } from "./version.js";
import { buildInject } from "./inject.js";

const Empty = z.strictObject({});
const Select = z.strictObject({ profile_id: ProfileIdSchema });
const Review = z.strictObject({ text: z.string().max(100 * 1024), profile_id: ProfileIdSchema.optional() });
export const MCP_TOOLS: Tool[] = [
  { name: "list_profiles", description: "List the available prose styles and the active profile.", inputSchema: z.toJSONSchema(Empty) as Tool["inputSchema"], annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "select_profile", description: "Choose a prose style before writing. During a revision it applies next turn. The selection is shown to the user.", inputSchema: z.toJSONSchema(Select) as Tool["inputSchema"], annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "review_prose", description: "Check a draft with local prose rules. Advisory only, once per user turn; subsequent calls return the first result, even if the text or profile changes. Maximum 100 KiB of text (UTF-16).", inputSchema: z.toJSONSchema(Review) as Tool["inputSchema"], annotations: { readOnlyHint: true, openWorldHint: false } },
];

class ToolFailure extends Error {}
const failure = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });
const result = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

export class ProsegateTools {
  private boundId: string | null = null;
  constructor(private readonly base: Ctx) {}

  /** No "most recent session" guessing: same-folder ambiguity must never target another chat. */
  private session(ctx: Ctx): SessionStore {
    const explicit = ctx.env["PROSEGATE_SESSION"];
    if (explicit !== undefined && explicit !== "") {
      if (!SESSION_ID_RE.test(explicit)) throw new ToolFailure("Invalid session binding.");
      const store = new SessionStore(ctx, explicit);
      if (store.readState() === null) throw new ToolFailure("The bound session is unavailable. Start the Prosegate session hooks first.");
      return store;
    }
    const cwd = normaliseCwd(ctx, ctx.env["CLAUDE_PROJECT_DIR"] || ctx.cwd);
    const sessions = listSessions(ctx).filter((entry) => {
      const s = new SessionStore(ctx, entry.id).readState();
      return s !== null && normaliseCwd(ctx, s.cwd) === cwd && ctx.now() - s.updated_at <= SESSION_LIVE_MS;
    });
    if (sessions.length !== 1) throw new ToolFailure(sessions.length === 0
      ? "No active Prosegate session in this folder. Start a Claude Code session with the Prosegate hooks installed."
      : "More than one Prosegate session is active in this folder. Bind this server with prosegate mcp --session <id> or PROSEGATE_SESSION; no session was changed.");
    const only = sessions[0];
    if (only === undefined) throw new ToolFailure("Session unavailable.");
    const id = only.id;
    if (this.boundId !== null && this.boundId !== id) throw new ToolFailure("The original session is no longer available. Restart or explicitly bind this MCP server.");
    this.boundId = id;
    return new SessionStore(ctx, id);
  }

  call(name: string, args: unknown): CallToolResult {
    // A long-lived server needs a fresh budget for every call.
    const start = performance.now();
    const ctx = { ...this.base, elapsedMs: () => performance.now() - start };
    try {
      const schema = name === "list_profiles" ? Empty : name === "select_profile" ? Select : name === "review_prose" ? Review : null;
      if (schema === null) return failure("Unknown tool.");
      if (!schema.safeParse(args ?? {}).success) return failure("Invalid tool arguments.");
      const store = this.session(ctx);
      const profiles = selectableProfiles(ctx);
      if (name === "list_profiles") return result(profiles.map((p) => ({
        id: p.id, name: p.name, description: p.trigger.description ?? "", active: p.id === store.readState()?.active_profile,
      })));
      if (name === "select_profile") {
        const { profile_id } = Select.parse(args);
        const profile = profiles.find((p) => p.id === profile_id);
        if (profile === undefined) return failure(`Profile unavailable. Valid ids: ${profiles.map((p) => p.id).join(", ") || "(none)"}.`);
        const s = selectProfile(ctx, store, profile);
        const reply = result({ active_profile: s.active_profile, previous_profile: s.previous_profile, sticky: profile.trigger.sticky });
        reply.content.push({ type: "text", text: `For this profile (from next turn if a revision is already in progress):\n${buildInject(profile)}` });
        return reply;
      }
      const input = Review.parse(args);
      let reviewed: ReviewResult | null = null;
      // The lock covers cache lookup, review and cache write, including calls from another MCP process.
      store.updateState(() => { throw new ToolFailure("Session unavailable."); }, (state) => {
        const turn = store.readTurn();
        if (turn === null || ctx.now() - turn.ts >= TURN_FILE_TTL_MS) throw new ToolFailure("No current user turn. Submit a prompt before checking a draft.");
        reviewed = store.readReviewCache(turn);
        if (reviewed !== null) {
          if (!profiles.some((p) => p.id === reviewed?.profile.id)) throw new ToolFailure("The cached review's profile is no longer available under the current policy.");
          return state;
        }
        const id = input.profile_id ?? state.active_profile;
        if (!profiles.some((p) => p.id === id)) throw new ToolFailure(`Profile unavailable. Valid ids: ${profiles.map((p) => p.id).join(", ") || "(none)"}.`);
        const loaded = resolveAndLoad(ctx, id);
        if (loaded.fellBack || loaded.resolved.id !== id) throw new ToolFailure("The selected profile could not be loaded.");
        const detailed = reviewRulesDetailed({
          request: {
            schema: "prosegate.review/1", text: input.text, profile_id: id, pass: 1, stages: ["rules"],
            session_id: store.sessionId, turn_id: turn.turn_id, prior_findings: [],
            context: { user_message: turn.user_message, style_constraints: "", mode: state.context_mode },
          },
          resolved: loaded.resolved, packs: loaded.packs, enforce: false,
          budgetMs: ctx.testHooks.engineBudgetMs ?? ENGINE_BUDGET_MAX_MS, maxProseChars: 100 * 1024,
        });
        reviewed = detailed.diagnostics.budget_exceeded ? {
          ...detailed.result, verdict: "skipped", skipped_reason: "reviewer_unavailable", findings: [], cleared: [],
          stats: { ...detailed.result.stats, findings_by_category: {} }, feedback_text: "",
        } : detailed.result;
        store.writeReviewCache(turn, reviewed);
        return state;
      });
      return result(reviewed);
    } catch (error) {
      // Never return parser/provider/filesystem exception text (it may include secrets or draft text).
      return failure(error instanceof ToolFailure ? error.message : "Prosegate could not complete this tool call. No reply was blocked.");
    }
  }
}

export function createMcpServer(ctx: Ctx): Server {
  const tools = new ProsegateTools(ctx);
  const server = new Server({ name: "prosegate", version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: MCP_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, (request) => tools.call(request.params.name, request.params.arguments));
  return server;
}

export async function serveMcp(ctx: Ctx, stdin: Readable, stdout: Writable, stderr: Writable): Promise<void> {
  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport(stdin, stdout, { maxBufferSize: 2 * 1024 * 1024 });
  await new Promise<void>((resolve, reject) => {
    const end = (): void => { void server.close().then(resolve, reject); };
    stdin.once("end", end);
    server.onclose = () => { stdin.off("end", end); resolve(); };
    server.onerror = () => { stderr.write("Prosegate: invalid MCP message or transport failure.\n"); };
    void server.connect(transport).catch(reject);
  });
}
