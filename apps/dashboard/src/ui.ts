type Child = Node | string | null | false;
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className;
  for (const child of children) if (child !== null && child !== false) node.append(child);
  return node;
}
export const text = (value: unknown): string => JSON.stringify(value, null, 2);
export const date = (value: number): string => new Date(value).toLocaleString();
export function button(label: string, action: () => void | Promise<void>, kind = "secondary"): HTMLButtonElement {
  const b = el("button", kind, label); b.type = "button"; b.addEventListener("click", () => { void action(); }); return b;
}
export function input(name: string, value = "", type = "text"): HTMLInputElement {
  const i = el("input"); i.name = name; i.id = `field-${name}`; i.type = type; i.value = value; return i;
}
export function field(label: string, control: HTMLElement, help = ""): HTMLElement {
  control.id ||= `field-${crypto.randomUUID()}`;
  const title = el("label", "field-name", label); title.htmlFor = control.id;
  const wrapper = el("div", "field", title, control);
  if (help) {
    const description = el("small", "muted", help); description.id = `${control.id}-help`;
    control.setAttribute("aria-describedby", description.id); wrapper.append(description);
  }
  return wrapper;
}
export function check(label: string, checked = false): { node: HTMLElement; control: HTMLInputElement } {
  const control = el("input"); control.type = "checkbox"; control.checked = checked;
  return { node: el("label", "check", control, el("span", "", label)), control };
}
export function select(name: string, values: string[], selected: string): HTMLSelectElement {
  const s = el("select"); s.name = name;
  for (const value of values) { const o = el("option", "", value); o.value = value; s.append(o); }
  s.value = selected; return s;
}
export function notice(message: string, error = false): HTMLElement {
  const n = el("div", error ? "notice error" : "notice", message); n.setAttribute("role", error ? "alert" : "status"); return n;
}
export function table(headers: string[], rows: Child[][]): HTMLElement {
  const t = el("table", "", el("thead", "", el("tr", "", ...headers.map((h) => { const th = el("th", "", h); th.scope = "col"; return th; }))),
    el("tbody", "", ...rows.map((r) => el("tr", "", ...r.map((c) => el("td", "", c))))));
  return el("div", "table-wrap", t);
}
