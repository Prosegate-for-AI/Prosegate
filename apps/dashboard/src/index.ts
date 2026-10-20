import { ConfigSchema } from "./config.js";
import { Auth } from "./auth.js";
import { Api } from "./api.js";
import { Dashboard } from "./views.js";
import { el, notice } from "./ui.js";
import "./style.css";

async function start(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;
  try {
    const response = await fetch("/config.json", { cache: "no-store", credentials: "omit", redirect: "error" });
    if (!response.ok) throw new Error("configuration");
    const config = ConfigSchema.parse(await response.json());
    const auth = new Auth(config);
    const app = new Dashboard(root, auth, new Api(config.apiOrigin, () => auth.token(), () => app.expired()));
    await app.start();
  } catch {
    root.replaceChildren(el("main", "setup", el("p", "eyebrow", "PROSEGATE"), el("h1", "", "Connect your dashboard"),
      notice("The dashboard needs its API address and managed sign-in settings. Ask the operator to configure this installation."),
      el("p", "muted", "No account information has been loaded.")));
  }
}
void start();
