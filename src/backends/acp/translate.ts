/**
 * ACP wire shapes to session-domain events. ACP types stay inside
 * `src/backends/acp/` (layering rule). Everything here is pure so it can be
 * tested against captured adapter output.
 *
 * Differences from pi that this layer absorbs:
 * - ACP has no message boundaries. An assistant cell is opened lazily on
 *   the first chunk and closed when a tool call or user message arrives or
 *   the prompt turn ends.
 * - History replay (`session/load`) streams user text as chunks, which are
 *   buffered into one `user_message`.
 * - A tool call's title and input may arrive one update after the call is
 *   announced, so `tool_update` carries optional name/args refinements.
 */
import type { ModelInfo, SessionEvent, ToolArgs, UiRequest } from "../../session/types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Human-readable text for one ACP content block. */
function contentBlockText(block: unknown): string {
  if (!isRecord(block)) return "";
  switch (block["type"]) {
    case "text":
      return asString(block["text"]) ?? "";
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    case "resource_link":
      return asString(block["uri"]) ?? "[resource]";
    case "resource": {
      const resource = block["resource"];
      return isRecord(resource) ? (asString(resource["text"]) ?? "[resource]") : "[resource]";
    }
    default:
      return "";
  }
}

/** Text for a tool call's `content` array (content blocks, diffs, terminals). */
function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (!isRecord(entry)) continue;
    switch (entry["type"]) {
      case "content":
        parts.push(contentBlockText(entry["content"]));
        break;
      case "diff": {
        const path = asString(entry["path"]) ?? "";
        const newText = asString(entry["newText"]) ?? "";
        parts.push(path.length > 0 ? `${path}\n${newText}` : newText);
        break;
      }
      default:
        break;
    }
  }
  return parts.filter((part) => part.length > 0).join("\n");
}

/** Best-effort text for `rawOutput`, which adapters shape freely. */
function rawOutputText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!isRecord(raw)) return "";
  const stdout = asString(raw["stdout"]) ?? "";
  const stderr = asString(raw["stderr"]) ?? "";
  if (stdout.length > 0 || stderr.length > 0) {
    return stderr.length > 0 ? `${stdout}${stdout.length > 0 ? "\n" : ""}${stderr}` : stdout;
  }
  const output = asString(raw["output"]);
  if (output !== undefined) return output;
  return "";
}

function toolOutputText(update: Record<string, unknown>): string {
  const fromContent = toolContentText(update["content"]);
  return fromContent.length > 0 ? fromContent : rawOutputText(update["rawOutput"]);
}

function toolArgs(update: Record<string, unknown>): ToolArgs | undefined {
  const raw = update["rawInput"];
  if (!isRecord(raw) || Object.keys(raw).length === 0) return undefined;
  return raw;
}

/**
 * Stateful translator for one ACP session's `session/update` stream.
 * Create a new one per session (including after `session/new`).
 */
export class AcpUpdateTranslator {
  private assistantOpen = false;
  private userBuffer: string | undefined;
  private readonly openTools = new Set<string>();

  /** Translate one `session/update` notification's `update` payload. */
  update(update: unknown): SessionEvent[] {
    if (!isRecord(update)) return [];
    const kind = asString(update["sessionUpdate"]);
    switch (kind) {
      case "user_message_chunk": {
        const text = contentBlockText(update["content"]);
        const events = this.closeAssistant();
        this.userBuffer = (this.userBuffer ?? "") + text;
        return events;
      }
      case "agent_message_chunk": {
        const text = contentBlockText(update["content"]);
        if (text.length === 0) return [];
        return [...this.flushUser(), ...this.openAssistant(), { kind: "text_delta", delta: text }];
      }
      case "agent_thought_chunk": {
        const text = contentBlockText(update["content"]);
        if (text.length === 0) return [];
        return [...this.flushUser(), ...this.openAssistant(), { kind: "thinking_delta", delta: text }];
      }
      case "tool_call": {
        const toolCallId = asString(update["toolCallId"]);
        if (toolCallId === undefined) return [];
        const events: SessionEvent[] = [...this.flushUser(), ...this.closeAssistant()];
        const toolName =
          asString(update["title"]) ?? asString(update["name"]) ?? asString(update["kind"]) ?? "tool";
        this.openTools.add(toolCallId);
        events.push({ kind: "tool_start", toolCallId, toolName, args: toolArgs(update) ?? {} });
        const status = asString(update["status"]);
        const output = toolOutputText(update);
        if (status === "completed" || status === "failed") {
          this.openTools.delete(toolCallId);
          events.push({ kind: "tool_end", toolCallId, output, isError: status === "failed" });
        } else if (output.length > 0) {
          events.push({ kind: "tool_update", toolCallId, output });
        }
        return events;
      }
      case "tool_call_update": {
        const toolCallId = asString(update["toolCallId"]);
        if (toolCallId === undefined) return [];
        const status = asString(update["status"]);
        const output = toolOutputText(update);
        if (status === "completed" || status === "failed") {
          this.openTools.delete(toolCallId);
          return [{ kind: "tool_end", toolCallId, output, isError: status === "failed" }];
        }
        const title = asString(update["title"]);
        const args = toolArgs(update);
        return [
          {
            kind: "tool_update",
            toolCallId,
            output,
            ...(title === undefined ? {} : { toolName: title }),
            ...(args === undefined ? {} : { args }),
          },
        ];
      }
      default:
        return [];
    }
  }

  /**
   * The prompt turn ended (or history replay finished): flush buffered user
   * text, close the assistant cell, and fail any tool still marked running
   * so nothing spins forever after a cancel.
   */
  endTurn(): SessionEvent[] {
    const events = [...this.flushUser(), ...this.closeAssistant()];
    for (const toolCallId of this.openTools) {
      events.push({ kind: "tool_end", toolCallId, output: "(no result recorded)", isError: true });
    }
    this.openTools.clear();
    return events;
  }

  private openAssistant(): SessionEvent[] {
    if (this.assistantOpen) return [];
    this.assistantOpen = true;
    return [{ kind: "assistant_message_start" }];
  }

  private closeAssistant(): SessionEvent[] {
    if (!this.assistantOpen) return [];
    this.assistantOpen = false;
    return [{ kind: "assistant_message_end" }];
  }

  private flushUser(): SessionEvent[] {
    const text = this.userBuffer;
    this.userBuffer = undefined;
    if (text === undefined || text.length === 0) return [];
    return [{ kind: "user_message", text }];
  }
}

export interface PermissionChoice {
  readonly name: string;
  readonly optionId: string;
}

export interface TranslatedPermission {
  readonly request: Extract<UiRequest, { kind: "select" }>;
  readonly choices: readonly PermissionChoice[];
}

/** `session/request_permission` params to a select dialog. */
export function translatePermission(id: string, params: unknown): TranslatedPermission | null {
  if (!isRecord(params)) return null;
  const rawOptions = params["options"];
  if (!Array.isArray(rawOptions)) return null;
  const choices: PermissionChoice[] = [];
  for (const option of rawOptions) {
    if (!isRecord(option)) continue;
    const optionId = asString(option["optionId"]);
    const name = asString(option["name"]);
    if (optionId === undefined || name === undefined) continue;
    choices.push({ name, optionId });
  }
  if (choices.length === 0) return null;
  const toolCall = params["toolCall"];
  const title = isRecord(toolCall) ? asString(toolCall["title"]) : undefined;
  return {
    request: {
      kind: "select",
      id,
      title: title === undefined ? "Allow this action?" : `Allow: ${title}`,
      options: choices.map((choice) => choice.name),
    },
    choices,
  };
}

/** How a session exposes model and thinking choices, normalized. */
export interface AcpSessionConfig {
  readonly models: readonly ModelInfo[];
  readonly currentModelId: string | undefined;
  /**
   * `config_option` when models come from `configOptions` (set via
   * `session/set_config_option` with `modelConfigId`), `set_model` when they
   * come from the older `models` field (set via `session/set_model`), or
   * `none` when the agent exposes no model choice.
   */
  readonly modelMechanism: "config_option" | "set_model" | "none";
  readonly modelConfigId: string | undefined;
  readonly thinkingConfigId: string | undefined;
  readonly thinkingLevels: readonly string[];
  readonly currentThinkingLevel: string | undefined;
}

const EMPTY_CONFIG: AcpSessionConfig = {
  models: [],
  currentModelId: undefined,
  modelMechanism: "none",
  modelConfigId: undefined,
  thinkingConfigId: undefined,
  thinkingLevels: [],
  currentThinkingLevel: undefined,
};

function selectValues(options: unknown): { value: string; name: string }[] {
  if (!Array.isArray(options)) return [];
  const out: { value: string; name: string }[] = [];
  for (const entry of options) {
    if (!isRecord(entry)) continue;
    if (Array.isArray(entry["options"])) {
      out.push(...selectValues(entry["options"]));
      continue;
    }
    const value = asString(entry["value"]);
    if (value === undefined) continue;
    out.push({ value, name: asString(entry["name"]) ?? value });
  }
  return out;
}

/**
 * Normalize model/thinking choices from a `session/new`, `session/load`, or
 * `session/set_config_option` response. `provider` labels the models with the
 * backend id so `provider/id` keys stay unique across backends.
 */
export function parseSessionConfig(response: unknown, provider: string): AcpSessionConfig {
  if (!isRecord(response)) return EMPTY_CONFIG;
  let config: AcpSessionConfig = EMPTY_CONFIG;

  const configOptions = response["configOptions"];
  if (Array.isArray(configOptions)) {
    for (const option of configOptions) {
      if (!isRecord(option) || option["type"] !== "select") continue;
      const id = asString(option["id"]);
      if (id === undefined) continue;
      const category = asString(option["category"]);
      const current = asString(option["currentValue"]);
      const values = selectValues(option["options"]);
      if (category === "model") {
        config = {
          ...config,
          models: values.map((entry) => ({
            provider,
            id: entry.value,
            name: entry.name,
            reasoning: false,
          })),
          currentModelId: current,
          modelMechanism: "config_option",
          modelConfigId: id,
        };
      } else if (category === "thought_level") {
        config = {
          ...config,
          thinkingConfigId: id,
          thinkingLevels: values.map((entry) => entry.value),
          currentThinkingLevel: current,
        };
      }
    }
  }

  if (config.modelMechanism === "none") {
    const models = response["models"];
    if (isRecord(models) && Array.isArray(models["availableModels"])) {
      const available: ModelInfo[] = [];
      for (const entry of models["availableModels"]) {
        if (!isRecord(entry)) continue;
        const id = asString(entry["modelId"]);
        if (id === undefined) continue;
        available.push({ provider, id, name: asString(entry["name"]) ?? id, reasoning: false });
      }
      if (available.length > 0) {
        config = {
          ...config,
          models: available,
          currentModelId: asString(models["currentModelId"]),
          modelMechanism: "set_model",
        };
      }
    }
  }
  return config;
}

/** Apply a `config_option_update` notification to an existing config. */
export function applyConfigOptionUpdate(config: AcpSessionConfig, update: unknown, provider: string): AcpSessionConfig {
  if (!isRecord(update)) return config;
  const next = parseSessionConfig({ configOptions: update["configOptions"] }, provider);
  if (next.modelMechanism === "none" && next.thinkingConfigId === undefined) return config;
  return {
    ...config,
    ...(next.modelMechanism === "none"
      ? {}
      : {
          models: next.models,
          currentModelId: next.currentModelId,
          modelMechanism: next.modelMechanism,
          modelConfigId: next.modelConfigId,
        }),
    ...(next.thinkingConfigId === undefined
      ? {}
      : {
          thinkingConfigId: next.thinkingConfigId,
          thinkingLevels: next.thinkingLevels,
          currentThinkingLevel: next.currentThinkingLevel,
        }),
  };
}

/** The `ModelInfo` currently selected, if any. */
export function currentModel(config: AcpSessionConfig): ModelInfo | undefined {
  return config.models.find((model) => model.id === config.currentModelId);
}
