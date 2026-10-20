import { it, expect } from "vitest";
import { privacyPage } from "./privacy-page.mjs";

it("renders policy without scripts, login dependencies or executable input", () => {
  const page = privacyPage('# Privacy\n\n## Local checks\n\n<script>alert("test")</script> & text');
  expect(page).toContain("<h1>Privacy</h1>");
  expect(page).toContain("<h2>Local checks</h2>");
  expect(page).toContain("&lt;script&gt;");
  expect(page).not.toContain("<script");
  expect(page).not.toContain("config.json");
});
