/**
 * THE contract layer (docs/design.md). Backend-agnostic session domain types.
 *
 * Rules enforced by review:
 * - UI imports session types only. UI never imports a backend.
 * - Backends import session types only. Backends never import UI or each other.
 * - No backend wire types (pi RPC JSON, ACP SDK types) leak past the
 *   backend's own directory.
 */

/** Lifecycle of a backend subprocess. */
export type BackendState = "starting" | "ready" | "streaming" | "error" | "exited";

/** Base64-encoded image attached to a prompt. */
export interface PromptImage {
  readonly data: string;
  readonly mimeType: string;
}

export interface PromptInput {
  readonly message: string;
  readonly images?: readonly PromptImage[];
}

/**
 * A dialog or notification the backend asks the host UI to present.
 * Pi surfaces these via its extension UI sub-protocol; ACP surfaces
 * permission requests. Both translate into this vocabulary.
 */
export type UiRequest =
  | {
      readonly kind: "select";
      readonly id: string;
      readonly title: string;
      readonly options: readonly string[];
    }
  | {
      readonly kind: "confirm";
      readonly id: string;
      readonly title: string;
      readonly message?: string;
    }
  | {
      readonly kind: "input";
      readonly id: string;
      readonly title: string;
      readonly placeholder?: string;
    }
  | {
      readonly kind: "editor";
      readonly id: string;
      readonly title: string;
      readonly prefill?: string;
    }
  | {
      readonly kind: "notify";
      readonly id: string;
      readonly message: string;
      readonly level: "info" | "warning" | "error";
    };

/** Host UI answer to a dialog {@link UiRequest}. */
export type UiResponse =
  | { readonly id: string; readonly kind: "value"; readonly value: string }
  | { readonly id: string; readonly kind: "confirmed"; readonly confirmed: boolean }
  | { readonly id: string; readonly kind: "cancelled" };

/** Tool-call arguments as the backend reported them (JSON object). */
export type ToolArgs = Readonly<Record<string, unknown>>;

/** A model the backend can run. `provider/id` is the stable selector. */
export interface ModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
}

/** `provider/id` string used in settings and CLI flags. */
export function modelKey(model: Pick<ModelInfo, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

/**
 * The domain vocabulary the UI renders. Each backend translates its native
 * wire format into these events at its own boundary.
 *
 * History replay: a backend launched with a `resumeHandle` re-emits its
 * stored transcript through this same vocabulary (`user_message`,
 * assistant boundaries and deltas, tool start/end) before reporting
 * `ready`, so the session state machine needs no separate history path.
 */
export type SessionEvent =
  | { readonly kind: "state_change"; readonly state: BackendState; readonly detail?: string }
  /**
   * The backend learned (or changed) its session identity and model setup.
   * The handle is opaque to everything outside the backend; pass it back
   * via {@link BackendLaunchArgs.resumeHandle} to resume later.
   */
  | {
      readonly kind: "session_info";
      readonly resumeHandle: string | undefined;
      readonly model: ModelInfo | undefined;
      readonly thinkingLevel: string | undefined;
    }
  /** The backend discarded its transcript (new session). */
  | { readonly kind: "session_reset" }
  /** A user message that the session did not originate (history replay). */
  | { readonly kind: "user_message"; readonly text: string }
  | { readonly kind: "assistant_message_start" }
  | { readonly kind: "text_delta"; readonly delta: string }
  | { readonly kind: "thinking_delta"; readonly delta: string }
  | { readonly kind: "assistant_message_end" }
  | {
      readonly kind: "tool_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: ToolArgs;
    }
  /**
   * Streamed tool progress. `toolName`/`args` are optional refinements for
   * backends that learn a tool call's real title or input after announcing
   * it (ACP adapters do this); when absent the original values stand.
   */
  | {
      readonly kind: "tool_update";
      readonly toolCallId: string;
      readonly output: string;
      readonly toolName?: string;
      readonly args?: ToolArgs;
    }
  | {
      readonly kind: "tool_end";
      readonly toolCallId: string;
      readonly output: string;
      readonly isError: boolean;
    }
  /** Pending steer/follow-up messages changed. */
  | {
      readonly kind: "queue_update";
      readonly steering: readonly string[];
      readonly followUp: readonly string[];
    }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ui_request"; readonly request: UiRequest };

export type SessionEventListener = (event: SessionEvent) => void;

/** Removes the listener when called. */
export type Unsubscribe = () => void;

/**
 * A running backend subprocess translated to the session domain.
 * Implementations own their wire protocol end to end.
 */
export interface BackendProcess {
  readonly state: BackendState;
  subscribe(listener: SessionEventListener): Unsubscribe;
  /** Send a user prompt. Rejects if the backend cannot accept it. */
  prompt(input: PromptInput): Promise<void>;
  /** Queue a steering message delivered mid-run. */
  steer(message: string): Promise<void>;
  /** Queue a message delivered after the agent finishes. */
  followUp(message: string): Promise<void>;
  /** Abort the current agent operation. */
  abort(): Promise<void>;
  /** Discard the transcript and start a fresh persisted session. */
  newSession(): Promise<void>;
  /** Models available to switch to. Empty when the backend cannot switch. */
  listModels(): Promise<readonly ModelInfo[]>;
  /** Switch model; the backend follows with a `session_info` event. */
  setModel(model: ModelInfo): Promise<void>;
  /** Thinking levels the current model supports. Empty when unsupported. */
  listThinkingLevels(): Promise<readonly string[]>;
  /** Set the thinking level; the backend follows with a `session_info` event. */
  setThinkingLevel(level: string): Promise<void>;
  /** Answer a dialog {@link UiRequest}. */
  respondUi(response: UiResponse): void;
  /** Kill the subprocess tree and release resources. Idempotent. */
  dispose(): Promise<void>;
}

export interface BackendLaunchArgs {
  /** Absolute path of the vault root; becomes the subprocess cwd. */
  readonly vaultRootAbs: string;
  /**
   * Opaque handle from a previous `session_info` event. When set, the
   * backend resumes that session and replays its history. A stale or
   * unknown handle degrades to a fresh session.
   */
  readonly resumeHandle?: string;
  /** User-configured executable; empty or absent means auto-detect. */
  readonly executablePath?: string;
  /** Default model selector (`provider/id` or a backend-specific pattern). */
  readonly model?: string;
  /** Default thinking level; absent means the backend's own default. */
  readonly thinkingLevel?: string;
}

/** One entry in the backend registry. */
export interface BackendDescriptor {
  readonly id: string;
  readonly displayName: string;
  /**
   * Absolute path of a runnable executable, honoring the override when set,
   * or `null` when none can be found. Used by settings to show detection
   * status and by launch to fail early with a clear message.
   */
  resolveExecutable(override?: string): string | null;
  createBackendProcess(args: BackendLaunchArgs): BackendProcess;
}
