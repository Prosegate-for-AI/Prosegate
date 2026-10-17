// Transcription of docs/08 Rule catalogue (core 0.1.0) into engine rule objects.
// Regex sources are written as the *intended* RE2 (the markdown "\|" and "\\b" escapes removed).
import { neutral } from './corpus.mjs';

const ph = (phrases, extra = {}) => ({ k: 'phrase', phrases, ...extra });
const rx = (pattern, extra = {}) => ({ k: 'regex', pattern, ...extra });
const mt = (metric, extra) => ({ k: 'metric', metric, ...extra });

// ---- examples that need a document context
const sec = (n) => `## Heading ${n}\n${neutral(45, 100 + n)}`;
const SIX_HEADINGS_300 = [1, 2, 3, 4, 5, 6].map(sec).join('\n\n');             // ~290-300 words, 6 headings
const SIX_HEADINGS_1200 = [1, 2, 3, 4, 5, 6].map((n) => `## Heading ${n}\n${neutral(195, 200 + n)}`).join('\n\n');
const EIGHTY_PCT_BULLETS = 'Here is what changed.\n\nThe cache is now per tenant.\n\n' + Array.from({ length: 8 }, (_, i) => `- Change number ${i + 1} touches the loader`).join('\n');
const LIST_12_KEYS = 'The loader reads these config keys.\n\n' + Array.from({ length: 12 }, (_, i) => `- key_${i + 1}`).join('\n');
const UNIFORM_10 = Array.from({ length: 10 }, (_, i) => `The worker number ${i + 1} reads the shared queue and writes each finished record into the staging table before it exits.`).join(' ');
const VARIED_4 = 'Short one here today. ' + 'The scheduler reads the queue and then writes each record to disk before moving on to the next batch of work. ' + 'It retries twice. ' + 'The importer validates every header against the schema, hashes the body with a fixed salt, and then renames the file once the lock is free again.';
const OPENING = 'The cache is keyed by tenant and region, so each tenant sees its own entries. Invalidation happens when a tenant changes its plan.';
const CLOSING_RESTATE = 'The cache is keyed by tenant and region, so each tenant sees its own entries. Invalidation happens when a tenant changes its plan.';
const MIDDLE = 'The scheduler reads the queue and writes each record to disk. The importer validates every header against the schema. The build step compresses the response body before upload.';
const CLOSING_NEXT = 'Next, run the migration script on staging and compare the dashboard before you merge.';
const BOLD7 = 'The deploy has **three** steps. First **stop** the worker, then **copy** the files and **start** it. The cache is **warm** after a minute. Check the **logs** and the **dashboard**. ' + neutral(110, 31);
const BOLD1 = 'The deploy has three steps. First stop the worker, then copy the files and start it. **Never run the migration twice.** ' + neutral(110, 32);
const SHORT_REPLY_SUMMARY = neutral(100, 41) + ' In summary, the fix is safe.';
const LONG_DOC_SUMMARY = neutral(900, 42) + ' In summary, the fix is safe.';

export const RULES = [
  { id: 'core.filler.001', parts: [ph(["let's dive in", "let's dive into", "let's explore", 'great question', 'certainly!', 'absolutely!', 'sure thing', "i'd be happy to", "i'd be glad to"], { position: 'sentence_start' })],
    hit: ["Great question! Let's dive into the cache layer."], miss: ['The cache layer is per tenant.'] },
  { id: 'core.filler.002', parts: [ph(['i hope this helps', 'hope this helps', 'feel free to reach out', 'let me know if you have any questions', 'happy to help', "don't hesitate to"], { position: 'closing' })],
    hit: ['Let me know if you have any questions!'], miss: ["Reply by Thursday if the dates don't work."] },
  { id: 'core.filler.003', parts: [ph(['as an ai', 'as a language model', 'this document outlines', 'in this section we will', 'in this response', 'the following is'])],
    hit: ['This document outlines the migration plan.'], miss: ['The migration runs in three phases.'] },
  { id: 'core.filler.004', parts: [ph(['in conclusion', 'to summarize', 'in summary', 'overall,'], { position: 'sentence_start', maxDocWords: 400 })],
    hit: [SHORT_REPLY_SUMMARY], miss: [LONG_DOC_SUMMARY] },

  { id: 'core.hedge.001', parts: [ph(["it's important to note", 'it is important to note', "it's worth noting", 'it is worth noting', 'it should be noted', "it's worth mentioning"]), ph(['note that'], { position: 'sentence_start' })],
    hit: ["It's worth noting that the index is unique."], miss: ['The index is unique.'] },
  { id: 'core.hedge.002', parts: [rx('\\b(somewhat|fairly|relatively|rather)\\s+(\\w+)')],
    hit: ['The query is relatively slow.'], miss: ['The query takes 400 ms.'] },
  { id: 'core.hedge.003', parts: [ph(['arguably', 'generally speaking', 'in many cases', 'it could be argued', 'to some extent', 'in a sense'])],
    hit: ['Arguably, the retry is unnecessary.'], miss: ['The retry is unnecessary.'] },
  { id: 'core.hedge.004', parts: [rx('\\b(may or may not|could potentially|might possibly|can possibly)\\b')],
    hit: ['This could potentially break the build.'], miss: ['This breaks the build when X.'] },
  { id: 'core.hedge.005', parts: [rx('\\bit depends[.!]')],
    hit: ['It depends.'], miss: ['It depends on whether the table is partitioned.'] },

  { id: 'core.vocab.001', parts: [ph(['delve', 'delves', 'delving', 'leverage', 'leverages', 'leveraging', 'utilize', 'utilise', 'foster', 'fosters', 'streamline', 'bolster', 'underscores', 'elevate'])],
    hit: ['We can leverage the existing cache.'], miss: ['We can use the existing cache.'] },
  { id: 'core.vocab.002', parts: [ph(['tapestry', 'realm', 'testament', 'synergy', 'paradigm shift', 'game-changer', 'cornerstone']), rx("\\b(the|this|today's) (current |modern |evolving |changing )?landscape\\b")],
    hit: ['The current landscape of auth libraries…'], miss: ['Three auth libraries fit: …'] },
  { id: 'core.vocab.003', parts: [ph(['robust', 'seamless', 'seamlessly', 'crucial', 'pivotal', 'nuanced', 'holistic', 'cutting-edge', 'comprehensive', 'meticulous', 'ever-evolving'])],
    hit: ['A robust and seamless integration.'], miss: ['The integration retries on 5xx and is idempotent.'] },
  { id: 'core.vocab.004', parts: [ph(['truly', 'genuinely', 'incredibly', 'remarkably', 'extremely']), rx('\\bhighly (effective|efficient|scalable|recommended|likely|unlikely)\\b')],
    hit: ['This is incredibly useful.'], miss: ['This saves 20 minutes per deploy.'] },
  { id: 'core.vocab.005', parts: [ph(['a wide range of', 'a variety of', 'a plethora of', 'a myriad of', 'a number of', 'various'])],
    hit: ['There are a number of options.'], miss: ['There are three options.'] },

  // triad.001 as written: [a-z]+ ; the "<=12 chars" constraint is expressed as {1,12}; digit/<=25-word constraints are post-filters.
  { id: 'core.triad.001', parts: [rx('\\b([a-z]{1,12}), ([a-z]{1,12}),? and ([a-z]{1,12})\\b', { post: 'triad1' })],
    hit: ['It is fast, simple, and reliable.'], miss: ['Install git, node, and pnpm.'], missIsKnownFalsePositive: true },
  { id: 'core.triad.002', parts: [rx("\\bnot (just|only|merely|about) .{3,80}?, (but|it's about|it is about)\\b")],
    hit: ["It's not just about speed, it's about trust."], miss: ['Not only did the test fail, the build did too.'] },
  { id: 'core.triad.003', parts: [ph(["whether it's", "whether you're"]), rx('\\bfrom \\w+ to \\w+, (and )?\\w+')],
    hit: ["Whether it's a startup or an enterprise…"], miss: ['Whether the flag is set decides the path.'] },

  { id: 'core.structure.001', parts: [mt('headers_per_100_words', { above: 1.5, minSentences: 8 })], hit: [SIX_HEADINGS_300], miss: [SIX_HEADINGS_1200] },
  { id: 'core.structure.002', parts: [mt('bullet_ratio', { above: 0.6, minSentences: 8 })], hit: [EIGHTY_PCT_BULLETS], miss: [LIST_12_KEYS], missIsKnownAmbiguous: true },
  { id: 'core.structure.003', parts: [mt('sentence_length_cv', { below: 0.25, minSentences: 10 })], hit: [UNIFORM_10], miss: [VARIED_4] },
  { id: 'core.structure.004', parts: [mt('closing_similarity', { above: 0.6, minSentences: 6 })], hit: [[OPENING, MIDDLE, CLOSING_RESTATE].join('\n\n')], miss: [[OPENING, MIDDLE, CLOSING_NEXT].join('\n\n')] },
  { id: 'core.structure.005', parts: [mt('bold_per_100_words', { above: 3, minSentences: 6 })], hit: [BOLD7], miss: [BOLD1] },

  { id: 'core.repetition.001', parts: [mt('similarity_to_prior', { above: 0.7, minWords: 6 })],
    hit: ['The cache is per tenant. The scheduler reads the queue and writes each record to disk. Each tenant has its own cache.'],
    miss: ['It is in the house of the people. The dog is on the road in the rain.'] },
];

// Supplementary probes not in 08 (labelled as extras in the report).
export const EXTRAS = [
  ['core.filler.001', 'sentence-initial only: mid-sentence phrase must NOT fire', 'Honestly it was a great question that nobody answered.', false],
  ['core.filler.002', 'closing only: phrase in first paragraph of a long doc must NOT fire', 'Let me know if you have any questions! ' + neutral(150, 5), false],
  ['core.filler.004', 'doc exactly 400 words, "under 400" boundary', neutral(396, 8) + ' In summary, the fix is safe.', null],
  ['core.hedge.001', '"note that" sentence-initial', 'Note that the index is unique.', true],
  ['core.hedge.001', '"note that" mid-sentence must NOT fire', 'Please note that the index is unique.', false],
  ['core.hedge.002', '"rather than" false positive', 'Use a queue rather than a cron job.', null],
  ['core.hedge.004', 'sentence-initial capital', 'Could potentially break the build.', true],
  ['core.vocab.001', 'noun "leverage" false positive', 'Operating leverage rose in the third quarter.', null],
  ['core.vocab.001', 'inflection "leveraged" (not in list)', 'The team leveraged the cache.', null],
  ['core.vocab.002', 'noun phrase "tapestry"', 'A rich tapestry of options.', true],
  ['core.vocab.004', 'regex part: "highly effective"', 'This is highly effective.', true],
  ['core.triad.001', 'capitalised first word', 'Fast, simple, and reliable are rare together.', true],
  ['core.triad.001', 'digit in sentence suppresses', 'It is fast, simple, and reliable on all 3 runners.', false],
  ['core.triad.001', 'no Oxford comma', 'It is fast, simple and reliable.', true],
  ['core.triad.003', 'regex part: "from X to Y, and Z"', 'It covers everything from startups to enterprises, and everything between.', true],
  ['core.triad.003', 'regex part, sentence-initial capital', 'From startups to enterprises, teams share this problem.', true],
];
