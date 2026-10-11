import type {
  NormalizedEvent,
  SessionEnded,
  SessionRegistered,
  StuckEvent,
  UnstuckEvent,
} from "./types.ts";

const NORMALIZED_EVENT_TYPES = ["stuck", "unstuck", "registered", "ended"] as const;
type NormalizedEventType = (typeof NORMALIZED_EVENT_TYPES)[number];

type JsonObject = Record<string, unknown>;

export type NormalizedEventValidation =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; error: "Invalid or missing event type" | "Unknown event type" | "Invalid event fields" };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isEventType(value: unknown): value is NormalizedEventType {
  return typeof value === "string" && (NORMALIZED_EVENT_TYPES as readonly string[]).includes(value);
}

function isStuckEvent(value: JsonObject): value is JsonObject & StuckEvent {
  return (
    value.type === "stuck" &&
    isNonEmptyString(value.sessionId) &&
    isNonEmptyString(value.paneId) &&
    isString(value.cwd) &&
    isString(value.transcriptPath) &&
    (value.reason === "stopped" || value.reason === "permission") &&
    isNonEmptyString(value.message) &&
    isTimestamp(value.timestamp)
  );
}

function isUnstuckEvent(value: JsonObject): value is JsonObject & UnstuckEvent {
  return value.type === "unstuck" && isNonEmptyString(value.sessionId) && isTimestamp(value.timestamp);
}

function isRegisteredEvent(value: JsonObject): value is JsonObject & SessionRegistered {
  return (
    value.type === "registered" &&
    isNonEmptyString(value.sessionId) &&
    isNonEmptyString(value.paneId) &&
    isString(value.cwd) &&
    isString(value.transcriptPath) &&
    isTimestamp(value.timestamp)
  );
}

function isEndedEvent(value: JsonObject): value is JsonObject & SessionEnded {
  return value.type === "ended" && isNonEmptyString(value.sessionId) && isTimestamp(value.timestamp);
}

export function validateNormalizedEvent(value: unknown): NormalizedEventValidation {
  if (!isJsonObject(value) || typeof value.type !== "string" || value.type.length === 0) {
    return { ok: false, error: "Invalid or missing event type" };
  }

  if (!isEventType(value.type)) {
    return { ok: false, error: "Unknown event type" };
  }

  if (value.type === "stuck" && isStuckEvent(value)) {
    return { ok: true, event: value };
  }
  if (value.type === "unstuck" && isUnstuckEvent(value)) {
    return { ok: true, event: value };
  }
  if (value.type === "registered" && isRegisteredEvent(value)) {
    return { ok: true, event: value };
  }
  if (value.type === "ended" && isEndedEvent(value)) {
    return { ok: true, event: value };
  }

  return { ok: false, error: "Invalid event fields" };
}
