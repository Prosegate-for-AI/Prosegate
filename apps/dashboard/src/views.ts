import { z } from "zod";
import { PROFILE_ID_RE } from "@prosegate/schema";
import type { Auth } from "./auth.js";
import { Api, MeSchema, ProfilesSchema, ProfileSchema, DevicesSchema, PacksSchema, KeysSchema, SamplesSchema, UsageSchema, PolicySchema, MembersSchema, errorText, profilePath, segment, type Me } from "./api.js";
import { returnPath } from "./config.js";
import { el, button, input, field, check, select, notice, table, text, date } from "./ui.js";

const routes = [
  ["/profiles", "Profiles"], ["/devices/approve", "Devices"], ["/rule-packs", "Rule packs"],
  ["/reviewer-keys", "Reviewer keys"], ["/samples", "Shared samples"], ["/usage", "Usage"], ["/organization", "Organization"],
] as const;
const anyResponse = z.unknown();
export class Dashboard {
  private me: Me | null = null;
  private content = el("main");
  private banner = el("div");
  private nav = el("nav");
  private generation = 0;
  private dirty = false;
  private pending = 0;
  private currentRoute = "/profiles";
  constructor(private readonly root: HTMLElement, private readonly auth: Auth, private readonly api: Api) {}
  async start(): Promise<void> {
    window.addEventListener("beforeunload", (event) => {
      if (this.me && (this.dirty || this.pending)) { event.preventDefault(); event.returnValue = ""; }
    });
    if (location.pathname === "/auth/callback") {
      try { history.replaceState(null, "", await this.auth.callback()); }
      catch { this.signIn("Sign-in could not be completed. Start again from this page."); return; }
    }
    if (!this.auth.token()) { this.signIn(); return; }
    try { this.me = await this.api.get("/v1/me", MeSchema); }
    catch (error) { await this.auth.logout(); this.signIn(errorText(error)); return; }
    this.shell();
    window.addEventListener("popstate", () => {
      if (!this.leave()) { history.pushState(null, "", this.currentRoute); return; }
      void this.navigate(returnPath(location.pathname), false);
    });
    await this.navigate(returnPath(location.pathname), false);
  }
  private leave(): boolean {
    if (this.pending) return false;
    if (this.dirty && !window.confirm("Discard your unsaved changes?")) return false;
    this.dirty = false; return true;
  }
  private signIn(message?: string): void {
    this.generation++;
    const box = el("main", "signin", el("p", "eyebrow", "PROSEGATE / WORKSPACE"),
      el("h1", "", "A clearer voice.\nA shared standard."),
      el("p", "lead", "Manage the profiles and rules that guide your team's writing."));
    const status = el("div");
    if (message) status.append(notice(message, true));
    box.append(status, button("Sign in", () => this.action(box, status, () => this.auth.login()), "primary"),
      el("p", "muted", "Use your organization’s managed account with multi-factor authentication."));
    this.root.replaceChildren(box);
  }
  expired(): void {
    if (!this.me) return;
    void this.auth.logout();
    this.banner.replaceChildren(notice("Your session has expired. Copy unsaved work before signing in again.", true),
      button("Sign in again", async () => { if (this.leave()) { try { await this.auth.login(); } catch { this.banner.append(notice("Sign-in is unavailable. Try again.", true)); } } }));
  }
  private shell(): void {
    const me = this.me;
    if (!me) return;
    this.nav = el("nav", "navigation"); this.nav.setAttribute("aria-label", "Workspace");
    for (const [path, label] of routes) {
      const a = el("a", "", label); a.href = path;
      a.addEventListener("click", (e) => { if (!e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); if (this.leave()) void this.navigate(path); } });
      this.nav.append(a);
    }
    this.content = el("main", "content"); this.content.id = "main"; this.content.tabIndex = -1;
    this.banner = el("div", "session-banner");
    const skip = el("a", "skip", "Skip to content"); skip.href = "#main";
    this.root.replaceChildren(skip,
      el("aside", "sidebar", el("div", "brand", el("span", "brand-mark", "p"), "Prosegate"),
        el("p", "workspace-label", me.org?.name ?? "Personal workspace"), this.nav,
        el("div", "sidebar-footer", el("span", "badge", `${me.plan} plan`), el("p", "", me.namespace),
          button("Sign out", async () => {
            if (!this.leave()) return;
            await this.auth.logout(); this.me = null; this.content.replaceChildren(); this.banner.replaceChildren();
            this.signIn("Signed out of this dashboard. Your identity provider may still have an active session.");
          }))),
      el("div", "workspace", this.banner, this.content));
  }
  private async navigate(path: string, push = true): Promise<void> {
    const generation = ++this.generation; this.currentRoute = path;
    if (push) history.pushState(null, "", path);
    for (const link of this.nav.querySelectorAll("a")) {
      if (link.pathname === path || (path === "/devices" && link.pathname === "/devices/approve")) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    this.content.replaceChildren(notice("Loading…"));
    try {
      const page = path.startsWith("/devices") ? await this.devices()
        : path === "/rule-packs" ? await this.packs() : path === "/reviewer-keys" ? await this.keys()
        : path === "/samples" ? await this.samples() : path === "/usage" ? await this.usage()
        : path === "/organization" ? await this.organization() : await this.profiles();
      if (generation === this.generation) { this.content.replaceChildren(page); this.content.focus(); }
    } catch (error) {
      if (generation === this.generation) this.content.replaceChildren(notice(errorText(error), true), button("Try again", () => this.navigate(path, false)));
    }
  }
  private page(title: string, description: string): HTMLElement {
    document.title = `${title} · Prosegate`;
    return el("section", "page", el("header", "page-header", el("p", "eyebrow", "WORKSPACE"), el("h1", "", title), el("p", "lead", description)));
  }
  private async action(container: HTMLElement, status: HTMLElement, run: () => Promise<void>): Promise<void> {
    if (container.getAttribute("aria-busy") === "true") return;
    const controls = [...container.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("button,input,textarea,select")];
    const disabled = controls.map((c) => c.disabled);
    controls.forEach((c) => { c.disabled = true; }); container.setAttribute("aria-busy", "true"); this.pending++;
    status.replaceChildren(notice("Working…"));
    try { await run(); }
    catch (error) { status.replaceChildren(notice(errorText(error), true)); }
    finally { controls.forEach((c, i) => { c.disabled = disabled[i] ?? false; }); container.removeAttribute("aria-busy"); this.pending--; }
  }
  private writable(id: string): boolean {
    const ns = id.split("/")[0], me = this.me;
    return !!me && (ns === me.namespace || (me.org !== null && ns === me.org.namespace && me.org.role === "admin"));
  }
  private async profiles(): Promise<HTMLElement> {
    const data = await this.api.get("/v1/profiles", ProfilesSchema);
    const page = this.page("Profiles", "Set the writing standards for a task, a team, or yourself.");
    const editor = el("div"), status = el("div");
    const id = input("profile-id", `${this.me?.namespace ?? ""}/`); id.required = true; id.maxLength = 120;
    const create = el("form", "card inline-form", field("New profile ID", id, "namespace/slug"));
    const add = button("Create profile", () => undefined, "primary"); add.type = "submit"; create.append(add);
    create.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!PROFILE_ID_RE.test(id.value) || !this.writable(id.value)) { status.replaceChildren(notice("Enter a valid profile ID in a namespace you can edit.", true)); return; }
      if (!this.leave()) return;
      void this.action(create, status, async () => { editor.replaceChildren(await this.editor(id.value, true)); status.replaceChildren(); });
    });
    page.append(create, status);
    if (!data.profiles.length) page.append(el("div", "empty", el("h2", "", "Start with your first profile"), el("p", "", "Create a profile above to inherit a starter profile and adjust its rules.")));
    else page.append(table(["Profile", "Version", "Updated", ""], data.profiles.map((p) => [
      el("div", "", el("strong", "", p.name), el("p", "muted compact", p.id)), String(p.version), date(p.updated_at),
      button(this.writable(p.id) ? "Edit" : "View", async () => {
        if (!this.leave()) return;
        await this.action(page, status, async () => { editor.replaceChildren(await this.editor(p.id, false)); status.replaceChildren(); });
      }),
    ])));
    page.append(editor); return page;
  }
  private async editor(id: string, fresh: boolean): Promise<HTMLElement> {
    const saved = fresh ? null : await this.api.get(profilePath(id), ProfileSchema);
    let etag = saved?.etag, isNew = fresh;
    const editable = this.writable(id);
    const area = el("textarea", "yaml"); area.name = "yaml"; area.spellcheck = false; area.maxLength = 65536; area.rows = 17;
    area.value = saved?.yaml ?? `schema: prosegate.profile/1\nid: ${id}\nversion: 1\nname: My writing profile\nextends: local/pr-description\n`;
    area.readOnly = !editable;
    let baseline = area.value;
    area.addEventListener("input", () => {
      this.dirty = area.value !== baseline; preview.replaceChildren(); status.replaceChildren();
    });
    const status = el("div"), preview = el("div");
    const panel = el("section", "card editor", el("h2", "", id), field("Profile YAML", area,
      "The service validates inheritance and assigns the next version when you save."), status);
    const toolbar = el("div", "actions");
    toolbar.append(button(editable ? "Preview draft" : "View resolved profile", () => this.action(panel, status, async () => {
      const result = editable
        ? await this.api.mutate(`${profilePath(id)}/preview`, "POST", { yaml: area.value }, anyResponse)
        : await this.api.get(`${profilePath(id)}/resolved`, anyResponse);
      preview.replaceChildren(el("h3", "", editable ? "Resolved draft · not saved" : "Resolved profile"), el("pre", "resolution", text(result)));
      status.replaceChildren(notice("Profile resolved successfully."));
    })));
    if (editable) toolbar.append(button("Save profile", () => this.action(panel, status, async () => {
      const result = await this.api.mutate(profilePath(id), "PUT", { yaml: area.value },
        z.object({ etag: z.string(), version: z.number(), resolution: z.unknown() }), isNew ? { "If-None-Match": "*" } : { "If-Match": etag ?? "" });
      etag = result.etag; isNew = false; baseline = area.value; this.dirty = false;
      sharingBox.hidden = false; remove.hidden = false;
      preview.replaceChildren(el("h3", "", `Saved version ${result.version}`), el("pre", "resolution", text(result.resolution)));
      status.replaceChildren(notice("Profile saved. The version in your YAML is assigned by the server."));
    }), "primary"));
    toolbar.append(button("Close editor", () => { if (this.leave()) { panel.remove(); void this.navigate("/profiles", false); } }));
    const sharing = check("Allow this profile to share blocking excerpts", saved?.sharing_enabled ?? false);
    sharing.control.disabled = !editable;
    const sharingStatus = el("div");
    const sharingBox = el("section", "sharing", el("h3", "", "Sample sharing"), el("p", "muted",
      "Opt in to send excerpts of up to 600 characters, up to 20 per device per day. Samples expire after 90 days. Redaction is heuristic and may miss sensitive text. Organization policy can disable sharing."),
      sharing.node, sharingStatus);
    sharingBox.hidden = fresh;
    if (editable) sharingBox.append(button("Update sharing", () => this.action(sharingBox, sharingStatus, async () => {
      if (sharing.control.checked && !window.confirm("Allow excerpts from this profile to be stored for up to 90 days?")) { sharingStatus.replaceChildren(); return; }
      await this.api.mutate(`${profilePath(id)}/sharing`, "PUT", { enabled: sharing.control.checked }, anyResponse);
      sharingStatus.replaceChildren(notice(sharing.control.checked ? "Sample sharing enabled." : "Sample sharing disabled."));
    })));
    const remove = button("Delete profile", () => this.action(panel, status, async () => {
      if (!window.confirm(`Delete ${id} and its saved versions?`)) { status.replaceChildren(); return; }
      await this.api.mutate(profilePath(id), "DELETE", {}, anyResponse, { "If-Match": etag ?? "" });
      this.dirty = false; await this.navigate("/profiles", false);
    }), "danger"); remove.hidden = fresh || !editable;
    panel.append(toolbar, preview, sharingBox, remove); return panel;
  }
  private async devices(): Promise<HTMLElement> {
    const { devices } = await this.api.get("/v1/devices", DevicesSchema);
    const page = this.page("Devices", "Approve a connection from your adapter, or revoke a device you no longer use.");
    const code = input("user-code"); code.placeholder = "ABCD-EFGH"; code.maxLength = 9; code.required = true;
    code.pattern = "[A-Za-z2-9]{4}-?[A-Za-z2-9]{4}"; code.autocomplete = "off"; code.spellcheck = false;
    const own = check("I started this request on my own device."); own.control.required = true;
    const status = el("div"), form = el("form", "card", el("h2", "", "Approve a device"),
      el("p", "muted", "Enter the code shown in your terminal. Only approve a request you initiated. Codes expire after 10 minutes."),
      field("Device code", code), own.node, status);
    const submit = button("Approve device", () => undefined, "primary"); submit.type = "submit"; form.append(submit);
    form.addEventListener("submit", (event) => { event.preventDefault(); void this.action(form, status, async () => {
      await this.api.mutate("/v1/device-codes/approve", "POST", { user_code: code.value.toUpperCase() }, anyResponse);
      code.value = ""; own.control.checked = false;
      status.replaceChildren(notice("Device approved. Return to your terminal to finish connecting, then refresh this list."));
    }); });
    page.append(form, el("div", "section-heading", el("h2", "", "Your devices"), button("Refresh devices", () => this.navigate("/devices/approve", false))));
    if (!devices.length) page.append(el("p", "empty", "No devices connected yet."));
    else page.append(table(["Device", "Last active", "Status", ""], devices.map((d) => [d.name, date(d.last_seen), d.revoked_at ? "Revoked" : "Connected",
      d.revoked_at ? null : button("Revoke device", () => this.action(page, status, async () => {
        if (!window.confirm(`Revoke ${d.name}? It will need to be connected again.`)) { status.replaceChildren(); return; }
        await this.api.mutate(`/v1/devices/${segment(d.id)}`, "DELETE", {}, anyResponse); await this.navigate("/devices/approve", false);
      }), "danger")])));
    return page;
  }
  private async packs(): Promise<HTMLElement> {
    const { rule_packs } = await this.api.get("/v1/rule-packs", PacksSchema);
    const page = this.page("Rule packs", "Published rule collections available from your configuration service.");
    const detail = el("div"), status = el("div");
    page.append(status, rule_packs.length ? table(["Pack", "Publisher", "Published versions"], rule_packs.map((pack) => [
      pack.id, pack.publisher, el("div", "actions", ...pack.versions.map((version) => button(version, () => this.action(page, status, async () => {
        const result = await this.api.get(`/v1/rule-packs/${segment(pack.id)}/${segment(version)}`, z.object({ yaml: z.string(), signature: z.string() }));
        detail.replaceChildren(el("section", "card", el("h2", "", `${pack.id} · ${version}`),
          el("p", "muted", "Published through the service’s validation and signing pipeline."), el("pre", "", result.yaml)));
        status.replaceChildren();
      }))))])) : el("p", "empty", "No rule packs have been published to this service yet."), detail);
    return page;
  }
  private async keys(): Promise<HTMLElement> {
    const { keys } = await this.api.get("/v1/reviewer-keys", KeysSchema);
    const page = this.page("Reviewer keys", "Check provider usage and revoke keys issued to your devices. Secret values are never shown here.");
    const status = el("div");
    page.append(notice(this.me?.vending_enabled ? "Key requests are available from connected devices." : "New managed key requests are currently unavailable for this account."), status);
    if (this.me?.account_flagged) page.append(el("section", "card", el("h2", "", "Account confirmation needed"),
      el("p", "", "Review unexpected usage and revoke affected keys before confirming. Confirmation does not reset spending limits."),
      button("Confirm account reviewed", () => this.action(page, status, async () => {
        if (!window.confirm("Confirm that you have reviewed the account’s unexpected usage?")) { status.replaceChildren(); return; }
        await this.api.mutate("/v1/reviewer-keys/confirm-account", "POST", {}, anyResponse);
        this.me = await this.api.get("/v1/me", MeSchema); await this.navigate("/reviewer-keys", false);
      }))));
    page.append(keys.length ? table(["Provider / key ID", "Status", "Budget used", "Expires", ""], keys.map((k) => [
      el("div", "", k.provider, el("p", "muted compact", k.key_id)), k.status, `${k.usage_pct.toFixed(1)}%`, date(k.expires_at),
      ["revoked", "revoking"].includes(k.status) ? null : button("Revoke key", () => this.action(page, status, async () => {
        if (!window.confirm("Revoke this reviewer key? Reviews using it will stop.")) { status.replaceChildren(); return; }
        await this.api.mutate(`/v1/reviewer-keys/${segment(k.key_id)}/revoke`, "POST", {}, anyResponse);
        await this.navigate("/reviewer-keys", false);
      }), "danger"),
    ])) : el("p", "empty", "No managed reviewer keys for this account."));
    page.append(el("p", "muted", "Usage reflects the latest provider poll. Revocation may remain pending while the provider is unavailable."),
      button("Refresh status", () => this.navigate("/reviewer-keys", false)));
    return page;
  }
  private async samples(): Promise<HTMLElement> {
    const { samples } = await this.api.get("/v1/samples", SamplesSchema);
    const page = this.page("Shared samples", "Excerpts shared by your devices from profiles with sample sharing enabled.");
    page.append(notice("Samples are retained for up to 90 days. Automatic redaction can miss sensitive information. Delete any sample you do not want retained."));
    const status = el("div"); page.append(status);
    if (!samples.length) page.append(el("p", "empty", "You have no shared samples."));
    for (const sample of samples) {
      const details = el("details", "", el("summary", "", "Finding details"), el("pre", "", text(sample.finding)));
      page.append(el("article", "card", el("div", "section-heading", el("h2", "", sample.profile_id), el("span", "badge", `Pass ${sample.pass}`)),
        el("p", "muted", date(sample.created_at)), el("blockquote", "excerpt", sample.excerpt), details,
        button("Delete sample", () => this.action(page, status, async () => {
          if (!window.confirm("Permanently delete this shared sample?")) { status.replaceChildren(); return; }
          await this.api.mutate(`/v1/samples/${segment(sample.id)}`, "DELETE", {}, anyResponse); await this.navigate("/samples", false);
        }), "danger")));
    }
    page.append(el("p", "muted", "Showing up to the 200 most recent samples.")); return page;
  }
  private async usage(): Promise<HTMLElement> {
    const page = this.page("Usage", "Aggregated finding counts from telemetry. No draft text is included.");
    const from = input("from", new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10), "date");
    const to = input("to", new Date().toISOString().slice(0, 10), "date"); from.required = true; to.required = true;
    const form = el("form", "card inline-form", field("From", from), field("To", to));
    const status = el("div"), chart = el("div");
    const draw = async () => {
      const delta = Date.parse(to.value) - Date.parse(from.value);
      if (!Number.isFinite(delta) || delta < 0 || delta > 365 * 86400000) { status.replaceChildren(notice("Choose a valid range of at most 366 days.", true)); return; }
      const { usage } = await this.api.get(`/v1/dashboard/usage?from=${segment(from.value)}&to=${segment(to.value)}`, UsageSchema);
      status.replaceChildren();
      if (!usage.length) { chart.replaceChildren(el("p", "empty", "No finding counts for these dates. Daily aggregates may take time to appear.")); return; }
      const daily = new Map<string, number>(); let total = 0;
      for (const row of usage) { daily.set(row.day, (daily.get(row.day) ?? 0) + row.count); total += row.count; }
      const max = Math.max(...daily.values(), 1);
      chart.replaceChildren(el("div", "metric card", el("span", "muted", "Findings in this period"), el("strong", "", total.toLocaleString())),
        el("section", "card chart", el("h2", "", "Findings by day"), ...[...daily.entries()].sort().map(([day, count]) => {
          const meter = el("meter"); meter.min = 0; meter.max = max; meter.value = count; meter.setAttribute("aria-label", `${day}: ${count} findings`);
          return el("div", "bar-row", el("span", "", day), meter, el("strong", "", count.toLocaleString()));
        })),
        table(["Day", "Profile", "Category", "Findings"], usage.map((r) => [r.day, r.profile_id, r.category, String(r.count)])));
    };
    const submit = button("Apply dates", () => undefined, "primary"); submit.type = "submit"; form.append(submit);
    form.addEventListener("submit", (e) => { e.preventDefault(); void this.action(form, status, draw); });
    page.append(form, status, chart, el("p", "muted", "Counts measure findings, not review sessions or writing volume."));
    await draw(); return page;
  }
  private async organization(): Promise<HTMLElement> {
    const org = this.me?.org, page = this.page("Organization", "Set shared policy and manage access to your workspace.");
    if (!org) { page.append(el("p", "empty", "You are not a member of an organization. Ask an administrator to add your account ID: " + this.me?.account_id)); return page; }
    const base = `/v1/orgs/${segment(org.id)}`, current = await this.api.get(`${base}/policy`, PolicySchema);
    let etag = current.etag;
    const admin = org.role === "admin", policy = current.policy;
    const enforcement = select("enforcement", ["profile default", "enforce", "advisory", "required"], policy.enforcement_default ?? "profile default");
    const unrestricted = check("Allow all supported providers", policy.allowed_providers === undefined);
    const providers = input("providers", policy.allowed_providers?.join(", ") ?? "");
    const byok = check("Require members to bring their own reviewer key", policy.byok_required ?? false);
    const sharing = check("Allow members to opt in to sample sharing", policy.sharing_allowed ?? true);
    const status = el("div"), form = el("form", "card", el("h2", "", org.name), el("p", "muted", `Your role: ${org.role ?? "member"}`),
      field("Default enforcement", enforcement, "Required makes organization profiles mandatory. Confirm the team is ready before enabling it."),
      unrestricted.node, field("Allowed providers", providers, "Comma-separated IDs, for example openai, anthropic. An empty restricted list permits none."),
      byok.node, sharing.node, status);
    [enforcement, unrestricted.control, providers, byok.control, sharing.control].forEach((c) => {
      c.disabled = !admin; c.addEventListener("change", () => { this.dirty = true; });
    });
    providers.addEventListener("input", () => { this.dirty = true; });
    if (admin) {
      const save = button("Save policy", () => undefined, "primary"); save.type = "submit"; form.append(save);
      form.addEventListener("submit", (event) => { event.preventDefault(); void this.action(form, status, async () => {
        if (enforcement.value === "required" && !window.confirm("Require organization profiles for all members? Personal profiles will no longer be selectable.")) { status.replaceChildren(); return; }
        const result = await this.api.mutate(`${base}/policy`, "PUT", {
          ...(enforcement.value !== "profile default" ? { enforcement_default: enforcement.value } : {}),
          byok_required: byok.control.checked, sharing_allowed: sharing.control.checked,
          ...(!unrestricted.control.checked ? { allowed_providers: providers.value.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
        }, PolicySchema, { "If-Match": etag });
        etag = result.etag; this.dirty = false; status.replaceChildren(notice("Organization policy saved."));
      }); });
    } else form.append(notice("Only administrators can change policy or membership."));
    page.append(form);
    if (!admin) return page;
    const { members } = await this.api.get(`${base}/members`, MembersSchema);
    const memberStatus = el("div"), account = input("account-id"), role = select("role", ["member", "admin"], "member");
    account.required = true; account.pattern = "[A-Za-z0-9_-]{1,64}";
    const memberForm = el("form", "card", el("h2", "", "Members"), el("p", "muted", "Add an existing provisioned account by its account ID."),
      el("div", "inline-form", field("Account ID", account), field("Role", role)), memberStatus);
    const add = button("Add or update member", () => undefined, "primary"); add.type = "submit"; memberForm.append(add);
    const reload = async () => { this.me = await this.api.get("/v1/me", MeSchema); await this.navigate("/organization", false); };
    memberForm.addEventListener("submit", (event) => { event.preventDefault(); void this.action(memberForm, memberStatus, async () => {
      if (this.dirty) { memberStatus.replaceChildren(notice("Save or discard your policy changes before updating members.", true)); return; }
      if (account.value === this.me?.account_id && role.value !== "admin" && !window.confirm("Remove your administrator role?")) { memberStatus.replaceChildren(); return; }
      await this.api.mutate(`${base}/members/${segment(account.value)}`, "PUT", { role: role.value }, anyResponse); await reload();
    }); });
    memberForm.append(table(["Account ID", "Role", ""], members.map((m) => [m.account_id, m.role,
      button("Remove member", () => this.action(memberForm, memberStatus, async () => {
        if (this.dirty) { memberStatus.replaceChildren(notice("Save or discard your policy changes before updating members.", true)); return; }
        if (!window.confirm(`Remove account ${m.account_id} from this organization?`)) { memberStatus.replaceChildren(); return; }
        await this.api.mutate(`${base}/members/${segment(m.account_id)}`, "DELETE", {}, anyResponse); await reload();
      }), "danger"),
    ])));
    page.append(memberForm); return page;
  }
}
