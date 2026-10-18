import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Category } from './types.js';

/**
 * Finding id (03, ADR-23): first 10 lowercase hex characters of
 * sha256(category | rule_id | span_key), fields joined with '|', UTF-8 encoded.
 *
 * `span_key` is the span text for phrase, regex, sentence-metric and reviewer findings, and the
 * empty string for document-scope findings (document_metric rules): a document metric describes the
 * whole turn and its span is only an anchor, so rewording the anchor sentence must not count as
 * clearing the finding. The segment id is deliberately NOT part of the preimage (ADR-23): segments
 * are numbered by position, so a revision that adds a paragraph above a flagged span would renumber
 * every later segment and make every pass-1 id vanish ("cleared") while the text shipped unchanged.
 *
 * PRIVACY: an id is a hash of the span text, so it is derived from the user's prose. Treat it as
 * span text: never put a finding id in telemetry, logs sent off the machine, or any payload that
 * must not carry prose (07 threat 5; the telemetry schema has no field for it by design). A short
 * phrase can be recovered from its id by guessing, so "it is only a hash" is not a defence.
 *
 * Choices 03 leaves open, fixed here:
 *  - a null rule_id (reviewer findings) is rendered as the empty string, so the preimage is
 *    `category||span_key`;
 *  - the fields are joined with a bare '|' and are not escaped, so a span containing '|' can in
 *    principle collide with a different field split. Ids only need to be stable across passes and
 *    collision-free in practice within one turn, so this is accepted rather than changing the
 *    preimage 03 defines.
 */
export function findingId(category: Category, ruleId: string | null, spanKey: string): string {
  const preimage = [category, ruleId ?? '', spanKey].join('|');
  return bytesToHex(sha256(utf8ToBytes(preimage))).slice(0, 10);
}
