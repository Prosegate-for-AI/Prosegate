import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["docs/**", "**/dist/**", "**/node_modules/**", "coverage/**", ".wrangler/**", ".claude/**", ".scratch/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // Plain Node scripts (scripts/, eval/runners/): declare the few globals they use.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", URL: "readonly", Buffer: "readonly" },
    },
  },
);
