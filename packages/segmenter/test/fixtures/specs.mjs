// Hand-written expectations for the fixture corpus. Nothing here is produced by the segmenter.
//
// Each entry describes what a correct analyse() must return for fixtures/<name>.md, using text
// anchors instead of numbers; test/tools/build-expected.mjs turns anchors into offsets by plain
// indexOf over the fixture and writes <name>.expected.json (kind, start, end, first 30 chars,
// word counts), so the numbers in the JSON are derived from the anchors, not from analyse().
//
//   segments: [kind, startAnchor, endAnchor?]  content range = [index of start, end of end anchor);
//             the partition rule (gap whitespace goes to the preceding segment; first segment starts
//             at 0; last ends at text.length) is applied by the tool.
//   units:    [kind, exact text, 'cont'?]       searched in order; 'cont' = continuation unit.
//   paragraphs: unit indexes grouped by paragraph (omit to skip the check).
//   masks:    [kind, exact text] in order.   bold: exact texts in order.
//   language: defaults to 'unknown' under 40 words, else 'en'.   words: asserted total prose words.
//
// In .crlf fixtures every "\n" in an anchor is matched as "\r\n".

export const specs = {
  "pr-description": {
    segments: [
      ["prose", "# Fix retry storm in the webhook worker"],
      ["prose", "This change stops", "within seconds."],
      ["prose", "## What changed"],
      ["prose", "- Added exponential", "for the migration."],
      ["prose", "## Test plan"],
      ["prose", "- [x] Unit tests", "for one hour."],
      ["code", "```bash", "--filter worker\n```"],
      ["prose", "Closes #482.", "for the repro."],
    ],
    units: [
      ["heading", "Fix retry storm in the webhook worker"],
      ["sentence", "This change stops the webhook worker from retrying failed deliveries in a tight loop."],
      ["sentence", "The old code re-queued a failed job immediately, so one bad endpoint could saturate the queue within seconds."],
      ["heading", "What changed"],
      ["list_item", "Added exponential backoff with jitter in `src/queue/retry.ts`, capped at 15 minutes."],
      ["list_item", "Moved the attempt counter into the job payload so restarts no longer reset it."],
      ["list_item", "**Breaking:** the `retryDelayMs` option is gone; see https://example.com/docs/retries for the migration."],
      ["heading", "Test plan"],
      ["list_item", "Unit tests for the backoff schedule."],
      ["list_item", "Soak test against a dead endpoint for one hour."],
      ["sentence", "Closes #482."],
      ["sentence", "Thanks to @maria for the repro."],
    ],
    paragraphs: [[0], [1, 2], [3], [4, 5, 6], [7], [8, 9], [10, 11]],
    masks: [
      ["inline_code", "`src/queue/retry.ts`"],
      ["inline_code", "`retryDelayMs`"],
      ["url", "https://example.com/docs/retries"],
    ],
    bold: ["**Breaking:**"],
    language: "en",
  },

  "design-doc": {
    segments: [
      ["prose", "# Rate limiting for the public API"],
      ["prose", "## Context"],
      ["prose", "Every public endpoint", "last quarter."],
      ["prose", "## Goals"],
      ["prose", "1. Isolate tenants", "configurable per plan."],
      ["prose", "## Proposal"],
      ["prose", "We will use a token bucket", "twice that."],
      ["table", "| Plan | Rate | Burst |", "| Team | 100/s | 200 |"],
      ["prose", "### Failure mode"],
      ["prose", "If Redis is unreachable", "read-heavy API."],
      ["prose", "## Open questions"],
      ["prose", "- Should webhooks", "in a header?"],
    ],
    units: [
      ["heading", "Rate limiting for the public API"],
      ["heading", "Context"],
      ["sentence", "Every public endpoint currently shares one global limit."],
      ["sentence", "A single noisy tenant can therefore starve everyone else, and support has seen three incidents in the last quarter."],
      ["heading", "Goals"],
      ["list_item", "Isolate tenants from each other."],
      ["list_item", "Keep p99 added latency under 2 ms."],
      ["list_item", "Make limits configurable per plan."],
      ["heading", "Proposal"],
      ["sentence", "We will use a token bucket per tenant, stored in Redis."],
      ["sentence", "Each request costs one token."],
      ["sentence", "Buckets refill at the plan rate (e.g. 100 requests per second on the Team plan) up to a burst of twice that."],
      ["heading", "Failure mode"],
      ["sentence", "If Redis is unreachable we fail open."],
      ["sentence", "This trades protection for availability, which Dr. Okafor argued is the right call for a read-heavy API."],
      ["heading", "Open questions"],
      ["list_item", "Should webhooks count against the limit?"],
      ["list_item", "Do we expose remaining tokens in a header?"],
    ],
    paragraphs: [[0], [1], [2, 3], [4], [5, 6, 7], [8], [9, 10, 11], [12], [13, 14], [15], [16, 17]],
    masks: [],
    bold: [],
    language: "en",
  },

  "chat-reply": {
    segments: [
      ["prose", "Sure, here's what I found.", "trailing tab."],
      ["prose", "Two options:"],
      ["prose", "1. Strip trailing", "leave the parser alone."],
      ["prose", "I'd go with option 2", "make the change?"],
    ],
    units: [
      ["sentence", "Sure, here's what I found."],
      ["sentence", "The failing test is `parses nested lists`, and it fails because the fixture has a trailing tab."],
      ["sentence", "Two options:"],
      ["list_item", "Strip trailing whitespace in the parser (smallest change)."],
      ["list_item", "Fix the fixture and leave the parser alone."],
      ["sentence", "I'd go with option 2 — the parser is behaving correctly."],
      ["sentence", "Want me to make the change?"],
    ],
    paragraphs: [[0, 1], [2], [3, 4], [5, 6]],
    masks: [["inline_code", "`parses nested lists`"]],
    bold: [],
    language: "en",
  },

  "nested-lists": {
    segments: [
      ["prose", "Release checklist:"],
      ["prose", "- Build", "- Publish"],
    ],
    units: [
      ["sentence", "Release checklist:"],
      ["list_item", "Build"],
      ["list_item", "Compile the TypeScript sources"],
      ["list_item", "Bundle the CLI"],
      ["list_item", "Verify the bundle size"],
      ["list_item", "Test"],
      ["list_item", "Run the unit tests"],
      ["list_item", "Run the eval harness"],
      ["list_item", "Publish"],
    ],
    paragraphs: [[0], [1, 2, 3, 4, 5, 6, 7, 8]],
    masks: [],
    bold: [],
  },

  "list-item-code": {
    segments: [
      ["prose", "Setup steps:"],
      ["prose", "- Install the CLI", "team's profile."],
    ],
    units: [
      ["sentence", "Setup steps:"],
      ["list_item", "Install the CLI with `npm install -g prosegate`, then run `prosegate init`."],
      ["list_item", "Copy the config:\n  `cp config.example.json ~/.prosegate/config.json`"],
      ["list_item", "Edit `~/.prosegate/config.json` and set \"profile\" to your team's profile."],
    ],
    paragraphs: [[0], [1, 2, 3]],
    masks: [
      ["inline_code", "`npm install -g prosegate`"],
      ["inline_code", "`prosegate init`"],
      ["inline_code", "`cp config.example.json ~/.prosegate/config.json`"],
      ["inline_code", "`~/.prosegate/config.json`"],
    ],
    bold: [],
  },

  "fence-in-list": {
    segments: [
      ["prose", "To reproduce:"],
      ["prose", "1. Start the server:"],
      ["code", "   ```bash", "pnpm dev\n   ```"],
      ["prose", "2. Open the page", "3. Watch the console."],
    ],
    units: [
      ["sentence", "To reproduce:"],
      ["list_item", "Start the server:"],
      ["list_item", "Open the page and click **Retry**."],
      ["list_item", "Watch the console."],
    ],
    paragraphs: [[0], [1], [2, 3]],
    masks: [],
    bold: ["**Retry**"],
  },

  "unterminated-fence": {
    segments: [
      ["prose", "Here is the script:"],
      ["code", "```python", "code\nmain()"],
    ],
    units: [["sentence", "Here is the script:"]],
    paragraphs: [[0]],
    masks: [],
    bold: [],
  },

  table: {
    segments: [
      ["prose", "Results by region:"],
      ["table", "| Region |", "| us     | 95 ms   | 0.1%   |"],
      ["prose", "The EU numbers", "extra hop."],
    ],
    units: [
      ["sentence", "Results by region:"],
      ["sentence", "The EU numbers are worse because of the extra hop."],
    ],
    paragraphs: [[0], [1]],
    masks: [],
    bold: [],
  },

  blockquote: {
    segments: [
      ["prose", "The maintainer replied:"],
      ["quote", "> This is working", "lazy continuation line of the quote"],
      ["quote", "> > nested quote line"],
      ["prose", "I disagree, but I'll live with it."],
    ],
    units: [
      ["sentence", "The maintainer replied:"],
      ["sentence", "I disagree, but I'll live with it."],
    ],
    paragraphs: [[0], [1]],
    masks: [],
    bold: [],
  },

  "quote-you-said": {
    segments: [
      ["prose", "You said "],
      ["quote", "\"keep the migration reversible at all costs\""],
      ["prose", " in the kickoff", "seed data."],
    ],
    units: [
      ["sentence", "You said"],
      ["sentence", "in the kickoff, so I added a down step.", "cont"],
      ["sentence", "I did not touch the seed data."],
    ],
    paragraphs: [[0], [1, 2]],
    masks: [],
    bold: [],
  },

  "quote-according-to": {
    segments: [
      ["prose", "According to Nielsen, "],
      ["quote", "\"users spend most of their time on other sites\""],
      ["prose", " and that matters", "both studies."],
    ],
    units: [
      ["sentence", "According to Nielsen,"],
      ["sentence", "and that matters for onboarding.", "cont"],
      ["sentence", "The result held across both studies."],
    ],
    paragraphs: [[0], [1, 2]],
    masks: [],
    bold: [],
  },

  "quote-says": {
    segments: [
      ["prose", "The docs say "],
      ["quote", "\"pass the token in the Authorization header\""],
      ["prose", ", but the error says "],
      ["quote", "\"invalid bearer token format\""],
      ["prose", " when we do. Ada Lovelace wrote "],
      ["quote", "\"the engine might compose elaborate pieces of music\""],
      ["prose", " long before anyone built one."],
    ],
    units: [
      ["sentence", "The docs say"],
      ["sentence", ", but the error says", "cont"],
      ["sentence", "when we do.", "cont"],
      ["sentence", "Ada Lovelace wrote"],
      ["sentence", "long before anyone built one.", "cont"],
    ],
    paragraphs: [[0], [1], [2, 3], [4]],
    masks: [],
    bold: [],
  },

  "quote-puts-it": {
    segments: [
      ["prose", "As the maintainers put it, "],
      ["quote", "\"we would rather ship late than ship broken\""],
      ["prose", ", and I agree. As you put it: "],
      ["quote", "\"make it boring\""],
      ["prose", "."],
    ],
    units: [
      ["sentence", "As the maintainers put it,"],
      ["sentence", ", and I agree.", "cont"],
      ["sentence", "As you put it:"],
    ],
    paragraphs: [[0], [1, 2]],
    masks: [],
    bold: [],
  },

  "quote-dash-credit": {
    segments: [
      ["quote", "\"Ship it before it is perfect, then keep fixing it\""],
      ["prose", " — Ada Lovelace"],
      ["prose", "We took that advice. "],
      ["quote", "\"Premature optimisation is the root of all evil\""],
      ["prose", " — Donald Knuth. Later we disagreed."],
    ],
    units: [
      ["sentence", "— Ada Lovelace", "cont"],
      ["sentence", "We took that advice."],
      ["sentence", "— Donald Knuth.", "cont"],
      ["sentence", "Later we disagreed."],
    ],
    paragraphs: [[0], [1], [2, 3]],
    masks: [],
    bold: [],
  },

  "quote-unattributed": {
    segments: [
      ["prose", "The release notes call it", "We should ask."],
      ["prose", "Someone on the thread", "in the old code."],
      ["prose", "He said \"we will ship", "went quiet."],
    ],
    units: [
      ["sentence", "The release notes call it \"a clean break from the legacy API surface\" without explaining what that means."],
      ["sentence", "We should ask."],
      ["sentence", "Someone on the thread wrote \"this should just work out of the box\" and nobody replied."],
      ["sentence", "It reads \"return the first match found\" in the old code."],
      ["sentence", "He said \"we will ship on Friday\" and then went quiet."],
    ],
    paragraphs: [[0, 1], [2, 3], [4]],
    masks: [],
    bold: [],
  },

  "scare-quotes": {
    segments: [["prose", "The \"robust\" layer", "good enough for now\" fix."]],
    units: [
      ["sentence", "The \"robust\" layer wraps every call, and our \"battle tested\" retry logic sits behind a \"so called\" feature flag."],
      ["sentence", "None of this is \"production ready\" yet, just a \"good enough for now\" fix."],
    ],
    paragraphs: [[0, 1]],
    masks: [],
    bold: [],
  },

  "quote-curly": {
    segments: [
      ["prose", "You wrote "],
      ["quote", "“the retry budget should never exceed two minutes”"],
      ["prose", " in the ticket.", "90 seconds."],
    ],
    units: [
      ["sentence", "You wrote"],
      ["sentence", "in the ticket.", "cont"],
      ["sentence", "The budget is now 90 seconds."],
    ],
    paragraphs: [[0], [1, 2]],
    masks: [],
    bold: [],
  },

  "quote-too-short": {
    segments: [
      ["prose", "You said \"ship it\" yesterday, and you asked "],
      ["quote", "\"why not now\""],
      ["prose", " this morning. Then you mentioned "],
      ["quote", "\"the second option is better\""],
      ["prose", " at lunch."],
    ],
    units: [
      ["sentence", "You said \"ship it\" yesterday, and you asked"],
      ["sentence", "this morning.", "cont"],
      ["sentence", "Then you mentioned"],
      ["sentence", "at lunch.", "cont"],
    ],
    paragraphs: [[0], [1, 2], [3]],
    masks: [],
    bold: [],
  },

  "quote-cue-far": {
    segments: [["prose", "You said earlier", "launch week\"."]],
    units: [
      ["sentence", "You said earlier that the plan was fine."],
      ["sentence", "I then wrote \"this is a different kind of sentence entirely\" in the doc."],
      ["sentence", "You said that we really should maybe \"revisit it after launch week\"."],
    ],
    paragraphs: [[0, 1, 2]],
    masks: [],
    bold: [],
  },

  "quote-in-list-item": {
    segments: [
      ["prose", "Feedback so far:"],
      ["prose", "- You said "],
      ["quote", "\"the onboarding flow is too long\""],
      ["prose", " and we agree.", "pricing page."],
    ],
    units: [
      ["sentence", "Feedback so far:"],
      ["list_item", "You said"],
      ["list_item", "and we agree.", "cont"],
      ["list_item", "Nobody has commented on the pricing page."],
    ],
    paragraphs: [[0], [1], [2, 3]],
    masks: [],
    bold: [],
  },

  "quote-with-code": {
    segments: [
      ["prose", "The spec says "],
      ["quote", "\"run `npm test` before every push\""],
      ["prose", " explicitly."],
      ["prose", "Set `\"a b c\"` in the config, because you said "],
      ["quote", "\"keep the defaults as they are\""],
      ["prose", " earlier."],
    ],
    units: [
      ["sentence", "The spec says"],
      ["sentence", "explicitly.", "cont"],
      ["sentence", "Set `\"a b c\"` in the config, because you said"],
      ["sentence", "earlier.", "cont"],
    ],
    paragraphs: [[0], [1], [2], [3]],
    masks: [["inline_code", "`\"a b c\"`"]],
    bold: [],
  },

  "crlf-basic.crlf": {
    segments: [
      ["prose", "# Notes"],
      ["prose", "First paragraph here.", "two sentences."],
      ["prose", "- one\n- two"],
      ["code", "```sh", "echo hi\n```"],
      ["prose", "Last line."],
    ],
    units: [
      ["heading", "Notes"],
      ["sentence", "First paragraph here."],
      ["sentence", "It has two sentences."],
      ["list_item", "one"],
      ["list_item", "two"],
      ["sentence", "Last line."],
    ],
    paragraphs: [[0], [1, 2], [3, 4], [5]],
    masks: [],
    bold: [],
  },

  "crlf-wrapped-quote.crlf": {
    segments: [
      ["prose", "You said "],
      ["quote", "\"the build must stay\ngreen on every commit\""],
      ["prose", " when we started.\nThen the plan changed."],
    ],
    units: [
      ["sentence", "You said"],
      ["sentence", "when we started.", "cont"],
      ["sentence", "Then the plan changed."],
    ],
    paragraphs: [[0], [1, 2]],
    masks: [],
    bold: [],
  },

  "emoji-astral": {
    segments: [
      ["prose", "Shipped 🚀 on Friday!", "Done ✅."],
      ["prose", "- 🎉 Release notes are live", "Café ☕ opens at 9"],
    ],
    units: [
      ["sentence", "Shipped 🚀 on Friday!"],
      ["sentence", "The 𝒳 operator handles 😀 and 𝄞 symbols."],
      ["sentence", "Done ✅."],
      ["list_item", "🎉 Release notes are live"],
      ["list_item", "Café ☕ opens at 9"],
    ],
    paragraphs: [[0, 1, 2], [3, 4]],
    masks: [],
    bold: [],
  },

  "code-only": {
    segments: [
      ["code", "```ts", "export const x = 1;\n```"],
      ["code", "    npm run build"],
    ],
    units: [],
    paragraphs: [],
    masks: [],
    bold: [],
    words: 0,
  },

  french: {
    segments: [
      ["prose", "Bonjour à tous.", "retardées de quelques heures."],
      ["prose", "Pour éviter", "chaque déploiement."],
    ],
    units: [
      ["sentence", "Bonjour à tous."],
      ["sentence", "Le serveur de production est tombé hier soir à cause d'une migration mal préparée."],
      ["sentence", "Nous avons restauré la base de données depuis la sauvegarde de minuit, puis nous avons rejoué les transactions manquantes une par une."],
      ["sentence", "Aucune donnée client n'a été perdue, mais plusieurs commandes ont été retardées de quelques heures."],
      ["sentence", "Pour éviter que cela se reproduise, nous allons ajouter une étape de validation avant chaque déploiement."],
    ],
    paragraphs: [[0, 1, 2, 3], [4]],
    masks: [],
    bold: [],
    language: "non_en",
  },

  "hazard-abbreviations": {
    segments: [
      ["prose", "Use a VCS", "Ask Ms. Gray about it."],
      ["prose", "We deploy in the U.S.", "5 p.m. sharp."],
    ],
    units: [
      ["sentence", "Use a VCS, e.g. Git, or i.e. anything that tracks history."],
      ["sentence", "Mr. Jones and Mrs. Smith met Dr. Patel and Prof. Lee at Acme Inc. headquarters."],
      ["sentence", "They compared tools vs. spreadsheets, cf. the appendix."],
      ["sentence", "The cost is approx. 40 dollars."],
      ["sentence", "Ask Ms. Gray about it."],
      ["sentence", "We deploy in the U.S. and the EU."],
      ["sentence", "The U.S. Army sent 3 units."],
      ["sentence", "St. Louis and Jr. staff joined; see Fig. 2 and Vol. 3."],
      ["sentence", "Globex Ltd. Berlin opens at 5 p.m. sharp."],
    ],
    paragraphs: [[0, 1, 2, 3, 4], [5, 6, 7, 8]],
    masks: [],
    bold: [],
    language: "en",
  },

  "hazard-initials": {
    segments: [["prose", "The paper is by", "notes follow."]],
    units: [
      ["sentence", "The paper is by J. Smith and J.R.R. Tolkien fans loved it."],
      ["sentence", "Then A. Einstein replied."],
      ["sentence", "We also ship Plan B."],
      ["sentence", "Next we test."],
      ["sentence", "See Appendix A."],
      ["sentence", "A few notes follow."],
    ],
    paragraphs: [[0, 1, 2, 3, 4, 5]],
    masks: [],
    bold: [],
  },

  "hazard-decimals-versions": {
    segments: [["prose", "Latency dropped", "tsx 4.23.15."]],
    units: [
      ["sentence", "Latency dropped from 3.14 ms to 0.5 ms on v1.2.3 and 1.2.x builds."],
      ["sentence", "Node 22.6 is required, but node 20.11.1 still works."],
      ["sentence", "We pin pnpm@10.33.2 and tsx 4.23.15."],
    ],
    paragraphs: [[0, 1, 2]],
    masks: [],
    bold: [],
  },

  "hazard-paths-files": {
    segments: [["prose", "Open README.md.", "1.5/2.0."]],
    units: [
      ["sentence", "Open README.md."],
      ["sentence", "Then edit src/index.ts and ./a.b before running ../scripts/build.sh on C:\\Users\\dev\\app\\config.json."],
      ["sentence", "The file notes.txt:12 has the error, not and/or or 1.5/2.0."],
    ],
    paragraphs: [[0, 1, 2]],
    masks: [
      ["path", "README.md"],
      ["path", "src/index.ts"],
      ["path", "./a.b"],
      ["path", "../scripts/build.sh"],
      ["path", "C:\\Users\\dev\\app\\config.json"],
      ["path", "notes.txt:12"],
    ],
    bold: [],
  },

  "hazard-urls-emails": {
    segments: [["prose", "Docs live at", "Then wait."]],
    units: [
      ["sentence", "Docs live at https://example.com/docs/a.b?x=1&y=2."],
      ["sentence", "Mail ops@example.com or www.example.org/help (see https://en.wikipedia.org/wiki/Foo_(bar)) for details."],
      ["sentence", "Then wait."],
    ],
    paragraphs: [[0, 1, 2]],
    masks: [
      ["url", "https://example.com/docs/a.b?x=1&y=2"],
      ["email", "ops@example.com"],
      ["url", "www.example.org/help"],
      ["url", "https://en.wikipedia.org/wiki/Foo_(bar)"],
    ],
    bold: [],
  },

  "hazard-ellipsis": {
    segments: [["prose", "Wait... what happened?", "Maybe later."]],
    units: [
      ["sentence", "Wait... what happened?"],
      ["sentence", "I tried it again..."],
      ["sentence", "Then it worked… and then it failed."],
      ["sentence", "Hmm…"],
      ["sentence", "Maybe later."],
    ],
    paragraphs: [[0, 1, 2, 3, 4]],
    masks: [],
    bold: [],
  },

  "hazard-closers": {
    segments: [
      ["prose", "She said, \"It is done.\"", "Nobody answered."],
      ["prose", "**Done.** Next step."],
    ],
    units: [
      ["sentence", "She said, \"It is done.\""],
      ["sentence", "Then she left (finally!) and he stayed."],
      ["sentence", "The note read [see below]."],
      ["sentence", "He asked (really?)"],
      ["sentence", "Nobody answered."],
      ["sentence", "**Done.**"],
      ["sentence", "Next step."],
    ],
    paragraphs: [[0, 1, 2, 3, 4], [5, 6]],
    masks: [],
    bold: ["**Done.**"],
  },

  "hazard-etc-no-month": {
    segments: [["prose", "Bring pens", "That is wrong."]],
    units: [
      ["sentence", "Bring pens, paper, etc."],
      ["sentence", "We start at 9 a.m."],
      ["sentence", "Please arrive early."],
      ["sentence", "Item No. 5 is missing."],
      ["sentence", "The audit closed Mar. 3 without issues."],
      ["sentence", "No."],
      ["sentence", "That is wrong."],
    ],
    paragraphs: [[0, 1, 2, 3, 4, 5, 6]],
    masks: [],
    bold: [],
  },

  bold: {
    segments: [
      ["prose", "This is **really important**", "is math."],
      ["prose", "**Note:** use", "stays plain."],
    ],
    units: [
      ["sentence", "This is **really important** and this is __also important__."],
      ["sentence", "A snake_case_name stays as written, and 2 ** 3 is math."],
      ["sentence", "**Note:** use `npm` here, or ***both*** styles, or **Use `npm`** today."],
      ["sentence", "**Unclosed bold stays plain."],
    ],
    paragraphs: [[0, 1], [2, 3]],
    masks: [
      ["inline_code", "`npm`"],
      ["inline_code", "`npm`"],
    ],
    bold: ["**really important**", "__also important__", "**Note:**", "***both***", "**Use `npm`**"],
  },

  "headings-only": {
    segments: [
      ["prose", "# Title"],
      ["prose", "## Section one"],
      ["prose", "### Subsection"],
      ["prose", "#### Four ####"],
      ["prose", "##### Five #####"],
      ["prose", "###### Six"],
    ],
    units: [
      ["heading", "Title"],
      ["heading", "Section one"],
      ["heading", "Subsection"],
      ["heading", "Four"],
      ["heading", "Five"],
      ["heading", "Six"],
    ],
    paragraphs: [[0], [1], [2], [3], [4], [5]],
    masks: [],
    bold: [],
  },

  setext: {
    segments: [
      ["prose", "Main Title", "=========="],
      ["prose", "Intro paragraph under the title."],
      ["prose", "Sub Heading", "Text right after the underline."],
      ["prose", "Two line", "------------"],
    ],
    units: [
      ["heading", "Main Title"],
      ["sentence", "Intro paragraph under the title."],
      ["heading", "Sub Heading"],
      ["sentence", "Text right after the underline."],
      ["heading", "Two line\nheading here"],
    ],
    paragraphs: [[0], [1], [2], [3], [4]],
    masks: [],
    bold: [],
  },

  empty: {
    segments: [],
    units: [],
    paragraphs: [],
    masks: [],
    bold: [],
    words: 0,
  },

  "whitespace-only": {
    segments: [["prose", "  \n\n\t\n"]],
    units: [],
    paragraphs: [],
    masks: [],
    bold: [],
    words: 0,
  },

  "thematic-breaks": {
    segments: [
      ["prose", "Part one."],
      ["prose", "---"],
      ["prose", "Part two."],
      ["prose", "***\n* * *"],
    ],
    units: [
      ["sentence", "Part one."],
      ["sentence", "Part two."],
    ],
    paragraphs: [[0], [1]],
    masks: [],
    bold: [],
  },

  "indented-code": {
    segments: [
      ["prose", "Run this:"],
      ["code", "    npm install", "    npm test"],
      ["prose", "Then check the output.", "stays part of the paragraph."],
    ],
    units: [
      ["sentence", "Run this:"],
      ["sentence", "Then check the output."],
      ["sentence", "A four-space indent in the middle of a paragraph\n    stays part of the paragraph."],
    ],
    paragraphs: [[0], [1, 2]],
    masks: [],
    bold: [],
  },

  "indented-in-list": {
    segments: [
      ["prose", "- First item"],
      ["prose", "    continuation paragraph indented four spaces"],
      ["prose", "- Second item"],
    ],
    units: [
      ["list_item", "First item"],
      ["sentence", "continuation paragraph indented four spaces"],
      ["list_item", "Second item"],
    ],
    paragraphs: [[0], [1], [2]],
    masks: [],
    bold: [],
  },

  "soft-wrap": {
    segments: [["prose", "This sentence wraps across", "across lines."]],
    units: [
      ["sentence", "This sentence wraps across\nseveral lines without ending\nuntil here."],
      ["sentence", "A second sentence\nalso wraps\nacross lines."],
    ],
    paragraphs: [[0, 1]],
    masks: [],
    bold: [],
  },

  "blank-lines": {
    segments: [
      ["prose", "First paragraph."],
      ["prose", "Second paragraph."],
    ],
    units: [
      ["sentence", "First paragraph."],
      ["sentence", "Second paragraph."],
    ],
    paragraphs: [[0], [1]],
    masks: [],
    bold: [],
  },

  "tilde-fence": {
    segments: [
      ["prose", "Install:"],
      ["code", "~~~bash", "npm i\n~~~"],
      ["prose", "Longer fence with a nested one:"],
      ["code", "````md", "inner\n```\n````"],
      ["prose", "Done."],
    ],
    units: [
      ["sentence", "Install:"],
      ["sentence", "Longer fence with a nested one:"],
      ["sentence", "Done."],
    ],
    paragraphs: [[0], [1], [2]],
    masks: [],
    bold: [],
  },

  "inline-code-double": {
    segments: [["prose", "Use ``a ` backtick``", "is literal."]],
    units: [
      ["sentence", "Use ``a ` backtick`` for literal backticks, or `` `code` `` inside prose."],
      ["sentence", "A dangling ` is literal."],
    ],
    paragraphs: [[0, 1]],
    masks: [
      ["inline_code", "``a ` backtick``"],
      ["inline_code", "`` `code` ``"],
    ],
    bold: [],
  },

  "task-list": {
    segments: [
      ["prose", "Todo:"],
      ["prose", "- [ ] write the parser", "spaced box"],
    ],
    units: [
      ["sentence", "Todo:"],
      ["list_item", "write the parser"],
      ["list_item", "write the tests"],
      ["list_item", "ship it"],
      ["list_item", "spaced box"],
    ],
    paragraphs: [[0], [1, 2, 3, 4]],
    masks: [],
    bold: [],
  },

  "ordered-variants": {
    segments: [
      ["prose", "Steps:"],
      ["prose", "1) Open the file", "* Done"],
    ],
    units: [
      ["sentence", "Steps:"],
      ["list_item", "Open the file"],
      ["list_item", "Edit the file"],
      ["list_item", "Save it"],
      ["list_item", "Close it"],
      ["list_item", "Done"],
    ],
    paragraphs: [[0], [1, 2, 3, 4, 5]],
    masks: [],
    bold: [],
  },

  "table-no-blank": {
    segments: [
      ["prose", "Here are the numbers"],
      ["table", "| Name | Count |", "| a    | 1     |"],
      ["prose", "Text immediately after has no pipe."],
    ],
    units: [
      ["sentence", "Here are the numbers"],
      ["sentence", "Text immediately after has no pipe."],
    ],
    paragraphs: [[0], [1]],
    masks: [],
    bold: [],
  },

  "lang-39-words": {
    segments: [["prose", "The team reviewed", "real disagreement."]],
    units: [
      ["sentence", "The team reviewed the plan on Monday and agreed that the first release should ship in March."],
      ["sentence", "Everyone wanted a smaller scope, so we cut two features and moved the rest to the next quarter without any real disagreement."],
    ],
    paragraphs: [[0, 1]],
    masks: [],
    bold: [],
    words: 39,
    language: "unknown",
  },

  "lang-40-words-en": {
    segments: [["prose", "The team reviewed", "disagreement here."]],
    units: [
      ["sentence", "The team reviewed the plan on Monday and agreed that the first release should ship in March."],
      ["sentence", "Everyone wanted a smaller scope, so we cut two features and moved the rest to the next quarter without any real disagreement here."],
    ],
    paragraphs: [[0, 1]],
    masks: [],
    bold: [],
    words: 40,
    language: "en",
  },

  "lang-40-words-nonen": {
    segments: [["prose", "El equipo revisó", "en absoluto."]],
    units: [
      ["sentence", "El equipo revisó el plan el lunes y acordó que la primera versión debería salir en marzo."],
      ["sentence", "Todos querían un alcance menor, así que recortamos dos funciones y movimos el resto al próximo trimestre sin ningún desacuerdo real en absoluto."],
    ],
    paragraphs: [[0, 1]],
    masks: [],
    bold: [],
    words: 40,
    language: "non_en",
  },

  "markdown-link": {
    segments: [["prose", "See [the migration guide]", "if stuck."]],
    units: [
      ["sentence", "See [the migration guide](https://example.com/guide/migrate.md) and the [changelog](./CHANGELOG.md) for details."],
      ["sentence", "Contact [support](mailto:help@example.com) if stuck."],
    ],
    paragraphs: [[0, 1]],
    masks: [
      ["url", "https://example.com/guide/migrate.md"],
      ["path", "./CHANGELOG.md"],
      ["email", "help@example.com"],
    ],
    bold: [],
  },

  "tab-indent": {
    segments: [
      ["prose", "Intro paragraph."],
      ["code", "\tcode with tab", "\tmore tab code"],
      ["prose", "After code."],
    ],
    units: [
      ["sentence", "Intro paragraph."],
      ["sentence", "After code."],
    ],
    paragraphs: [[0], [1]],
    masks: [],
    bold: [],
  },

  typography: {
    segments: [["prose", "It’s done.", "em—dash stay."]],
    units: [
      ["sentence", "It’s done."],
      ["sentence", "Let’s go."],
      ["sentence", "“Quoted” text with a no‑break hyphen here."],
      ["sentence", "Cut–off and em—dash stay."],
    ],
    paragraphs: [[0, 1, 2, 3]],
    masks: [],
    bold: [],
  },
};
