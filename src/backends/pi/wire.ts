/**
 * Pi RPC wire-event parsing. External data is `unknown` until validated
 * here; these types never leave `src/backends/pi/` (layering rule).
 *
 * Unrecognized event types parse to `null` and are ignored, keeping the
 * backend forward-compatible with newer pi releases.
 */

export type PiWireEvent =
  | { readonly type: "agent_start" }
  | { readonly type: "agent_settled" }
  | { readonly type: "assistant_message_start" }
  | { readonly type: "assistant_message_end" }
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "thinking_delta"; readonly delta: string }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "tool_execution_update"; readonly toolCallId: string; readonly text: string }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly text: string;
      readonly isError: boolean;
    }
  | {
      readonly type: "queue_update";
      readonly steering: readonly string[];
      readonly followUp: readonly string[];
    }
  | {
      readonly type: "response";
      readonly id: string | undefined;
      readonly command: string;
      readonly success: boolean;
      readonly error: string | undefined;
      readonly data: unknown;
    }
  | { readonly type: "extension_ui_request"; readonly raw: Record<string, unknown> };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Concatenated text blocks from a pi content array (tool output). */
export function contentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const block of value) {
    if (isRecord(block) && block["type"] === "text") {
      const text = asString(block["text"]);
      if (text !== undefined) parts.push(text);
    }
  }
  return parts.join("");
}

/**
 * Parse one decoded JSONL record into a wire event, or `null` when the
 * record is malformed or an event type this backend does not consume.
 */
export function parsePiWireEvent(line: string): PiWireEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const type = asString(value["type"]);
  if (type === undefined) return null;

  switch (type) {
    case "agent_start":
      return { type: "agent_start" };
    case "agent_settled":
      return { type: "agent_settled" };
    case "message_start":
    case "message_end": {
      const message = value["message"];
      if (!isRecord(message) || message["role"] !== "assistant") return null;
      return type === "message_start"
        ? { type: "assistant_message_start" }
        : { type: "assistant_message_end" };
    }
    case "message_update": {
      const delta = value["assistantMessageEvent"];
      if (!isRecord(delta)) return null;
      const deltaType = asString(delta["type"]);
      const deltaText = asString(delta["delta"]);
      if (deltaText === undefined) return null;
      if (deltaType === "text_delta") return { type: "text_delta", delta: deltaText };
      if (deltaType === "thinking_delta") return { type: "thinking_delta", delta: deltaText };
      return null;
    }
    case "tool_execution_start": {
      const toolCallId = asString(value["toolCallId"]);
      const toolName = asString(value["toolName"]);
      if (toolCallId === undefined || toolName === undefined) return null;
      const args = value["args"];
      return {
        type: "tool_execution_start",
        toolCallId,
        toolName,
        args: isRecord(args) ? args : {},
      };
    }
    case "tool_execution_update": {
      const toolCallId = asString(value["toolCallId"]);
      if (toolCallId === undefined) return null;
      const partial = value["partialResult"];
      const text = isRecord(partial) ? contentText(partial["content"]) : "";
      return { type: "tool_execution_update", toolCallId, text };
    }
    case "tool_execution_end": {
      const toolCallId = asString(value["toolCallId"]);
      if (toolCallId === undefined) return null;
      const result = value["result"];
      const text = isRecord(result) ? contentText(result["content"]) : "";
      return {
        type: "tool_execution_end",
        toolCallId,
        text,
        isError: value["isError"] === true,
      };
    }
    case "queue_update":
      return {
        type: "queue_update",
        steering: stringArray(value["steering"]),
        followUp: stringArray(value["followUp"]),
      };
    case "response": {
      const command = asString(value["command"]);
      if (command === undefined) return null;
      return {
        type: "response",
        id: asString(value["id"]),
        command,
        success: value["success"] === true,
        error: asString(value["error"]),
        data: value["data"],
      };
    }
    case "extension_ui_request":
      return { type: "extension_ui_request", raw: value };
    default:
      return null;
  }
}
