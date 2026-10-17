import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Category } from './types.js';

/**
 * Finding id (03): first 10 lowercase hex characters of
 * sha256(category | rule_id | span.text | segment.id), fields joined with '|', UTF-8 encoded.
 *
 * PRIVACY: an id is a hash of the span text, so it is derived from the user's prose. Treat it as
 * span text: never put a finding id in telemetry, logs sent off the machine, or any payload that
 * must not carry prose (07 threat 5; the telemetry schema has no field for it by design). A short
 * phrase can be recovered from its id by guessing, so "it is only a hash" is not a defence.
 *
 * Choices 03 leaves open, fixed here:
 *  - a null rule_id (reviewer findings) is rendered as the empty string, so the preimage is
 *    `category||span.text|segment.id`;
 *  - the fields are joined with a bare '|' and are not escaped, so a span containing '|' can in
 *    principle collide with a different field split. Ids only need to be stable across passes and
 *    collision-free in practice within one turn, so this is accepted rather than changing the
 *    preimage 03 defines.
 */
export function findingId(
  category: Category,
  ruleId: string | null,
  spanText: string,
  segmentId: string,
): string {
  const preimage = [category, ruleId ?? '', spanText, segmentId].join('|');
  return bytesToHex(sha256(utf8ToBytes(preimage))).slice(0, 10);
}
