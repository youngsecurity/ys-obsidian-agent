import { type App, Modal, Notice, Setting } from "obsidian";

import type { UiRequest, UiResponse } from "../session/types";

/**
 * Present a backend {@link UiRequest} with native Obsidian UI. Dialog
 * requests (select, confirm, input, editor) resolve with exactly one
 * {@link UiResponse}: dismissing the modal without answering sends
 * `cancelled` so the backend never hangs on a closed dialog. This is the
 * tool-approval surface resolved by design doc gotcha 5.
 */
export function presentUiRequest(
  app: App,
  request: UiRequest,
  respond: (response: UiResponse) => void
): void {
  switch (request.kind) {
    case "notify":
      new Notice(request.message);
      return;
    case "select":
      new SelectModal(app, request, respond).open();
      return;
    case "confirm":
      new ConfirmModal(app, request, respond).open();
      return;
    case "input":
      new TextModal(app, { title: request.title, placeholder: request.placeholder }, request.id, respond).open();
      return;
    case "editor":
      new TextModal(app, { title: request.title, prefill: request.prefill, multiline: true }, request.id, respond).open();
      return;
    default: {
      const _exhaustive: never = request;
      void _exhaustive;
    }
  }
}

/** Ensures exactly one response per dialog, defaulting to cancelled. */
class RespondOnce {
  private sent = false;

  constructor(private readonly respond: (response: UiResponse) => void) {}

  send(response: UiResponse): void {
    if (this.sent) return;
    this.sent = true;
    this.respond(response);
  }

  cancel(id: string): void {
    this.send({ id, kind: "cancelled" });
  }
}

class SelectModal extends Modal {
  private readonly once: RespondOnce;

  constructor(
    app: App,
    private readonly request: Extract<UiRequest, { kind: "select" }>,
    respond: (response: UiResponse) => void
  ) {
    super(app);
    this.once = new RespondOnce(respond);
  }

  override onOpen(): void {
    this.titleEl.setText(this.request.title);
    for (const option of this.request.options) {
      new Setting(this.contentEl).addButton((button) =>
        button.setButtonText(option).onClick(() => {
          this.once.send({ id: this.request.id, kind: "value", value: option });
          this.close();
        })
      );
    }
  }

  override onClose(): void {
    this.once.cancel(this.request.id);
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  private readonly once: RespondOnce;

  constructor(
    app: App,
    private readonly request: Extract<UiRequest, { kind: "confirm" }>,
    respond: (response: UiResponse) => void
  ) {
    super(app);
    this.once = new RespondOnce(respond);
  }

  override onOpen(): void {
    this.titleEl.setText(this.request.title);
    if (this.request.message !== undefined) {
      this.contentEl.createEl("p", { text: this.request.message });
    }
    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText("Confirm")
          .setCta()
          .onClick(() => {
            this.once.send({ id: this.request.id, kind: "confirmed", confirmed: true });
            this.close();
          })
      )
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => {
          this.once.send({ id: this.request.id, kind: "confirmed", confirmed: false });
          this.close();
        })
      );
  }

  override onClose(): void {
    this.once.cancel(this.request.id);
    this.contentEl.empty();
  }
}

interface TextModalConfig {
  readonly title: string;
  readonly placeholder?: string;
  readonly prefill?: string;
  readonly multiline?: boolean;
}

class TextModal extends Modal {
  private readonly once: RespondOnce;
  private value: string;

  constructor(
    app: App,
    private readonly config: TextModalConfig,
    private readonly requestId: string,
    respond: (response: UiResponse) => void
  ) {
    super(app);
    this.once = new RespondOnce(respond);
    this.value = config.prefill ?? "";
  }

  override onOpen(): void {
    this.titleEl.setText(this.config.title);
    if (this.config.multiline === true) {
      const textarea = this.contentEl.createEl("textarea", {
        cls: "ys-agent-modal-editor",
        attr: { rows: "8" },
      });
      textarea.value = this.value;
      textarea.addEventListener("input", () => {
        this.value = textarea.value;
      });
    } else {
      const input = this.contentEl.createEl("input", {
        attr: { type: "text", placeholder: this.config.placeholder ?? "" },
      });
      input.value = this.value;
      input.addEventListener("input", () => {
        this.value = input.value;
      });
    }
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Submit")
        .setCta()
        .onClick(() => {
          this.once.send({ id: this.requestId, kind: "value", value: this.value });
          this.close();
        })
    );
  }

  override onClose(): void {
    this.once.cancel(this.requestId);
    this.contentEl.empty();
  }
}
