import type { AccountErrorCode } from "./accounts";
import type { CatalogErrorCode } from "./catalogs";
import type { LibraryErrorCode } from "./games";
import type { PushErrorCode } from "./push/service";
import type { JsonDelta, PlayerSnapshot, ScreenSnapshot } from "@gamehearth/sdk/platform";
import type { RoomErrorCode, RoomView, ScreenView } from "./rooms";
import type { ProfileErrorCode } from "./profiles";
import type { SoloErrorCode } from "./solo";

export type ClientMessage = (
  | { type: "hello"; room: string; visible?: boolean; deltas?: boolean }
  | { type: "visibility"; visible: boolean }
  | { type: "start" }
  | { type: "set-option"; name: string; value: string | number | boolean }
  | { type: "leave" }
  | { type: "kick"; member: number }
  | { type: "add-bot" }
  | { type: "hand-over"; member: number }
  | { type: "take-back" }
  | { type: "move"; action: unknown; expectedVersion?: number }
  | { type: "new-round" }
  | { type: "abort" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "screen"; deltas?: boolean }
  | { type: "remove-screen"; screen: number }
  | { type: "resync" }
) & { id?: number };

export type ProtocolErrorCode =
  | RoomErrorCode
  | AccountErrorCode
  | PushErrorCode
  | CatalogErrorCode
  | LibraryErrorCode
  | SoloErrorCode
  | ProfileErrorCode
  | "not-signed-in"
  | "not-admin"
  | "forbidden"
  | "signed-out"
  | "bad-message"
  | "not-joined"
  | "no-device"
  | "not-found"
  | "rate-limited"
  | "too-many-connections"
  | "removed"
  | "room-closed"
  | "server-error";

export type ServerMessage =
  | { type: "room"; room: RoomView }
  | { type: "screen-room"; room: ScreenView }
  | { type: "frame"; snapshot: PlayerSnapshot<unknown, unknown, unknown> | ScreenSnapshot<unknown> }
  | { type: "frame"; base: number; delta: JsonDelta }
  | { type: "pairing"; code: string; expiresAt: number; expiresInMs: number }
  | { type: "ack"; id: number }
  | { type: "error"; code: ProtocolErrorCode; message: string; id?: number };

export function parseClientMessage(raw: string): ClientMessage | string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "The message is not valid JSON";
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "A message must be an object with type";
  }
  const message = value as Record<string, unknown>;
  const id = message["id"];
  if (id !== undefined && !(Number.isSafeInteger(id) && (id as number) >= 0)) {
    return "id must be a whole number from 0";
  }
  const parsed = parseBody(message);
  return typeof parsed === "string" || id === undefined ? parsed : { ...parsed, id: id as number };
}

function parseBody(message: Record<string, unknown>): ClientMessage | string {
  switch (message["type"]) {
    case "hello": {
      if (typeof message["room"] !== "string") {
        return "hello needs room as text";
      }
      const visible = message["visible"];
      if (visible !== undefined && typeof visible !== "boolean") {
        return "visible must be true or false";
      }
      const deltas = message["deltas"];
      if (deltas !== undefined && typeof deltas !== "boolean") {
        return "deltas must be true or false";
      }
      return { type: "hello", room: message["room"], ...(visible === undefined ? {} : { visible }), ...(deltas === undefined ? {} : { deltas }) };
    }
    case "visibility":
      return typeof message["visible"] === "boolean" ? { type: "visibility", visible: message["visible"] } : "visibility needs visible as true or false";
    case "start":
      return { type: "start" };
    case "set-option": {
      const name = message["name"];
      const value = message["value"];
      if (typeof name !== "string" || name.length === 0 || name.length > 40) {
        return "set-option needs name as text";
      }
      const simple = typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value)) || (typeof value === "string" && value.length <= 40);
      return simple ? { type: "set-option", name, value } : "set-option needs value as true, false, a whole number or short text";
    }
    case "leave":
      return { type: "leave" };
    case "new-round":
      return { type: "new-round" };
    case "abort":
      return { type: "abort" };
    case "pause":
      return { type: "pause" };
    case "resume":
      return { type: "resume" };
    case "screen": {
      const deltas = message["deltas"];
      if (deltas !== undefined && typeof deltas !== "boolean") {
        return "deltas must be true or false";
      }
      return deltas === undefined ? { type: "screen" } : { type: "screen", deltas };
    }
    case "resync":
      return { type: "resync" };
    case "remove-screen":
      return Number.isSafeInteger(message["screen"]) ? { type: "remove-screen", screen: message["screen"] as number } : "remove-screen needs screen as a number";
    case "kick":
      return Number.isSafeInteger(message["member"]) ? { type: "kick", member: message["member"] as number } : "kick needs member as a number";
    case "add-bot":
      return { type: "add-bot" };
    case "take-back":
      return { type: "take-back" };
    case "hand-over":
      return Number.isSafeInteger(message["member"]) ? { type: "hand-over", member: message["member"] as number } : "hand-over needs member as a number";
    case "move": {
      if (!("action" in message)) {
        return "move needs action";
      }
      const expected = message["expectedVersion"];
      if (expected !== undefined && !Number.isSafeInteger(expected)) {
        return "expectedVersion must be a whole number";
      }
      return expected === undefined
        ? { type: "move", action: message["action"] }
        : { type: "move", action: message["action"], expectedVersion: expected as number };
    }
    default:
      return `Unknown message type ${JSON.stringify(message["type"])}`;
  }
}
