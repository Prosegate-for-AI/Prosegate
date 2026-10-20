import { InMemoryWebStorage, UserManager, WebStorageStateStore, type User } from "oidc-client-ts";
import type { Config } from "./config.js";
import { returnPath } from "./config.js";

/** Only the short-lived PKCE transaction survives a redirect. Tokens never enter browser storage. */
export class Auth {
  private readonly manager: UserManager;
  private user: User | null = null;
  constructor(config: Config) {
    this.manager = new UserManager({
      authority: config.authority, client_id: config.clientId,
      redirect_uri: `${location.origin}/auth/callback`, response_type: "code", scope: "openid profile",
      loadUserInfo: false, automaticSilentRenew: false, monitorSession: false,
      userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
      stateStore: new WebStorageStateStore({ store: sessionStorage, prefix: "prosegate.oidc." }),
      staleStateAgeInSeconds: 600, requestTimeoutInSeconds: 20, fetchRequestCredentials: "omit",
    });
  }
  async login(): Promise<void> {
    await this.manager.clearStaleState();
    await this.manager.signinRedirect({ state: returnPath(location.pathname), nonce: crypto.randomUUID() });
  }
  async callback(): Promise<string> {
    // Remove authorization codes from the address bar even on a rejected callback.
    const url = location.href;
    history.replaceState(null, "", "/auth/callback");
    this.user = await this.manager.signinRedirectCallback(url);
    if (!this.token()) { await this.logout(); throw new Error("session_expired"); }
    return returnPath(this.user?.state);
  }
  token(): string | null {
    const p = this.user?.profile, now = Date.now() / 1000;
    return this.user?.id_token && p && p.exp > now && p.iat + 3600 > now ? this.user.id_token : null;
  }
  async logout(): Promise<void> {
    this.user = null;
    await this.manager.removeUser();
  }
}
