/**
 * Translate a stored pi conversation (`get_messages` payload) into the
 * session-event vocabulary, so resuming a session replays through the same
 * state machine as live streaming. Pi message shapes stay inside this
 * directory (layering rule).
 *
 * Emission order mirrors live streaming: an assistant message's thinking
 * and text stream first, the message closes, then its tool calls start.
 * Each tool closes when its `toolResult` arrives. Tool calls that never
 * got a result (aborted runs) are closed as errors at the end so nothing
 * renders as running forever.
 */
import type { SessionEvent, ToolArgs } from "../../session/types";
import { asString, contentText, isRecord } from "./wire";

const MISSING_RESULT = "(no result recorded)";

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const text = contentText(content);
  if (text.length > 0) return text;
  const hasImage = content.some((block) => isRecord(block) && block["type"] === "image");
  return hasImage ? "[image]" : "";
}

export function translateHistory(messages: unknown): SessionEvent[] {
  if (!Array.isArray(messages)) return [];
  const events: SessionEvent[] = [];
  const openTools = new Set<string>();

  for (const message of messages) {
    if (!isRecord(message)) continue;
    switch (message["role"]) {
      case "user": {
        const text = userText(message["content"]);
        if (text.length > 0) events.push({ kind: "user_message", text });
        break;
      }
      case "assistant": {
        events.push({ kind: "assistant_message_start" });
        const toolStarts: SessionEvent[] = [];
        const content = message["content"];
        for (const block of Array.isArray(content) ? content : []) {
          if (!isRecord(block)) continue;
          switch (block["type"]) {
            case "thinking": {
              const thinking = asString(block["thinking"]);
              if (thinking !== undefined && thinking.length > 0) {
                events.push({ kind: "thinking_delta", delta: thinking });
              }
              break;
            }
            case "text": {
              const text = asString(block["text"]);
              if (text !== undefined && text.length > 0) {
                events.push({ kind: "text_delta", delta: text });
              }
              break;
            }
            case "toolCall": {
              const toolCallId = asString(block["id"]);
              const toolName = asString(block["name"]);
              if (toolCallId === undefined || toolName === undefined) break;
              const rawArgs = block["arguments"];
              const args: ToolArgs = isRecord(rawArgs) ? rawArgs : {};
              toolStarts.push({ kind: "tool_start", toolCallId, toolName, args });
              openTools.add(toolCallId);
              break;
            }
            default:
              break;
          }
        }
        events.push({ kind: "assistant_message_end" });
        const errorMessage = asString(message["errorMessage"]);
        if (message["stopReason"] === "error" && errorMessage !== undefined) {
          events.push({ kind: "error", message: errorMessage });
        }
        events.push(...toolStarts);
        break;
      }
      case "toolResult": {
        const toolCallId = asString(message["toolCallId"]);
        if (toolCallId === undefined) break;
        openTools.delete(toolCallId);
        events.push({
          kind: "tool_end",
          toolCallId,
          output: contentText(message["content"]),
          isError: message["isError"] === true,
        });
        break;
      }
      case "bashExecution": {
        const command = asString(message["command"]);
        if (command === undefined) break;
        const toolCallId = `bash:${String(message["timestamp"] ?? events.length)}`;
        events.push({ kind: "tool_start", toolCallId, toolName: "bash", args: { command } });
        events.push({
          kind: "tool_end",
          toolCallId,
          output: asString(message["output"]) ?? "",
          isError: message["cancelled"] === true || (message["exitCode"] ?? 0) !== 0,
        });
        break;
      }
      default:
        break;
    }
  }

  for (const toolCallId of openTools) {
    events.push({ kind: "tool_end", toolCallId, output: MISSING_RESULT, isError: true });
  }
  return events;
}
