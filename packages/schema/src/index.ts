/** Placeholder so the workspace graph is real; replaced by product code in a later item. */
export const schemaPlaceholder = {
  id: "prosegate:schema:placeholder",
  uses: [] as readonly string[],
} as const;

export * from "./types.js";
export * from "./schemas.js";
export * from "./lenient.js";
export * from "./finding-id.js";
export * from "./spans.js";
export * from "./render.js";
export { idDenylistViolation, injectedTextDenylistViolation, injectedTextViolation } from "./injected-text.js";
// Telemetry: the raw per-kind schemas (TELEMETRY_KINDS) stay internal; the wire schema, the server-only
// stored schema and the one send path are the public surface.
export {
  ERROR_CODES,
  HARNESSES,
  KEY_PREFIXES,
  KEY_TAIL_MIN,
  LATENCY_BUCKETS_MS,
  ServerStoredEventSchema,
  TELEMETRY_BATCH_MAX,
  TELEMETRY_COUNT_MAX,
  TELEMETRY_RULE_IDS_MAX,
  TELEMETRY_STRING_MAX,
  TELEMETRY_TS_MAX,
  TELEMETRY_TS_MIN,
  TELEMETRY_TS_WINDOW_MS,
  TELEMETRY_WORDS_BUCKET_MAX,
  WireBatchSchema,
  WireEventSchema,
  encodeTelemetryBatch,
  findKeyShapedStrings,
  isTimestampWithinBounds,
  truncateToMinute,
} from "./telemetry.js";
export type {
  ErrorCode,
  ServerStoredEvent,
  TelemetryMaskContext,
  WireBatch,
  WireEvent,
} from "./telemetry.js";
export * from "./json-schema.js";
