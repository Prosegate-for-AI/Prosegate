// `__PROSEGATE_VERSION__` is substituted by tsup (see tsup.config.ts) from this package's package.json.
declare const __PROSEGATE_VERSION__: string | undefined;

export const VERSION: string =
  typeof __PROSEGATE_VERSION__ === "string" ? __PROSEGATE_VERSION__ : "0.0.0-dev";
