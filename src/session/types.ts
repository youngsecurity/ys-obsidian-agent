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

/**
 * The domain vocabulary the UI renders. Each backend translates its native
 * wire format into these events at its own boundary.
 */
export type SessionEvent =
  | { readonly kind: "state_change"; readonly state: BackendState; readonly detail?: string }
  | { readonly kind: "assistant_message_start" }
  | { readonly kind: "text_delta"; readonly delta: string }
  | { readonly kind: "thinking_delta"; readonly delta: string }
  | { readonly kind: "assistant_message_end" }
  | { readonly kind: "tool_start"; readonly toolCallId: string; readonly toolName: string }
  | { readonly kind: "tool_update"; readonly toolCallId: string; readonly output: string }
  | {
      readonly kind: "tool_end";
      readonly toolCallId: string;
      readonly output: string;
      readonly isError: boolean;
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
  /** Answer a dialog {@link UiRequest}. */
  respondUi(response: UiResponse): void;
  /** Kill the subprocess tree and release resources. Idempotent. */
  dispose(): Promise<void>;
}

export interface BackendLaunchArgs {
  /** Absolute path of the vault root; becomes the subprocess cwd. */
  readonly vaultRootAbs: string;
}

/** One entry in the backend registry. */
export interface BackendDescriptor {
  readonly id: string;
  readonly displayName: string;
  /** Probe whether this backend can run on this machine. */
  isAvailable(): Promise<boolean>;
  createBackendProcess(args: BackendLaunchArgs): BackendProcess;
}
