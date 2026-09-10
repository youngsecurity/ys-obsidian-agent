import { type App, type Component, MarkdownRenderer } from "obsidian";

import type { TranscriptItem } from "../session/AgentSession";
import { clampOutput, summarizeArgs } from "./toolSummary";

type ItemOf<K extends TranscriptItem["kind"]> = Extract<TranscriptItem, { kind: K }>;

interface Cell<K extends TranscriptItem["kind"] = TranscriptItem["kind"]> {
  readonly kind: K;
  readonly el: HTMLElement;
  update(item: ItemOf<K>): void;
}

class UserCell implements Cell<"user"> {
  readonly kind = "user";
  readonly el: HTMLElement;

  constructor(item: ItemOf<"user">) {
    this.el = createDiv({ cls: "ys-agent-cell ys-agent-user", text: item.text });
  }

  update(item: ItemOf<"user">): void {
    this.el.setText(item.text);
  }
}

class AssistantCell implements Cell<"assistant"> {
  readonly kind = "assistant";
  readonly el: HTMLElement;
  private thinkingEl: HTMLDetailsElement | undefined;
  private thinkingTextEl: HTMLElement | undefined;
  private readonly textEl: HTMLElement;
  private markdownRendered = false;
  private userToggledThinking = false;
  private autoOpenedThinking = false;

  constructor(
    private readonly app: App,
    private readonly component: Component,
    item: ItemOf<"assistant">
  ) {
    this.el = createDiv({ cls: "ys-agent-cell ys-agent-assistant" });
    this.textEl = this.el.createDiv({ cls: "ys-agent-text" });
    this.update(item);
  }

  update(item: ItemOf<"assistant">): void {
    this.updateThinking(item);
    if (item.complete) {
      if (!this.markdownRendered) {
        this.markdownRendered = true;
        this.textEl.empty();
        this.textEl.addClass("ys-agent-md");
        void MarkdownRenderer.render(this.app, item.text, this.textEl, "", this.component);
      }
      return;
    }
    this.textEl.setText(item.text.length === 0 && item.thinking.length > 0 ? "" : `${item.text}▌`);
  }

  private updateThinking(item: ItemOf<"assistant">): void {
    if (item.thinking.length === 0) return;
    if (this.thinkingEl === undefined || this.thinkingTextEl === undefined) {
      const details = this.el.createEl("details", { cls: "ys-agent-thinking" });
      details.createEl("summary", { text: "Thinking" });
      this.thinkingTextEl = details.createDiv({ cls: "ys-agent-thinking-text" });
      this.el.prepend(details);
      // Auto-open while thinking streams ahead of any answer text; close
      // again when text arrives unless the user has toggled it themselves.
      if (!item.complete && item.text.length === 0) {
        details.open = true;
        this.autoOpenedThinking = true;
      }
      details.addEventListener("toggle", () => {
        if (!this.autoOpenedThinking) this.userToggledThinking = true;
        this.autoOpenedThinking = false;
      });
      this.thinkingEl = details;
    }
    this.thinkingTextEl.setText(item.thinking);
    const shouldAutoClose = item.complete || item.text.length > 0;
    if (shouldAutoClose && this.thinkingEl.open && !this.userToggledThinking) {
      this.autoOpenedThinking = true;
      this.thinkingEl.open = false;
    }
  }
}

class ToolCell implements Cell<"tool"> {
  readonly kind = "tool";
  readonly el: HTMLDetailsElement;
  private readonly statusEl: HTMLElement;
  private readonly outputEl: HTMLElement;
  private lastOutput: string | undefined;

  constructor(item: ItemOf<"tool">) {
    this.el = createEl("details", { cls: "ys-agent-cell ys-agent-tool" });
    const summary = this.el.createEl("summary", { cls: "ys-agent-tool-summary" });
    summary.createSpan({ cls: "ys-agent-tool-name", text: item.toolName });
    const argSummary = summarizeArgs(item.args);
    if (argSummary.length > 0) {
      summary.createSpan({ cls: "ys-agent-tool-args-summary", text: argSummary });
    }
    this.statusEl = summary.createSpan({ cls: "ys-agent-tool-status" });

    const body = this.el.createDiv({ cls: "ys-agent-tool-body" });
    if (Object.keys(item.args).length > 0) {
      body.createDiv({ cls: "ys-agent-tool-label", text: "Arguments" });
      body.createEl("pre", {
        cls: "ys-agent-tool-args",
        text: JSON.stringify(item.args, null, 2),
      });
    }
    body.createDiv({ cls: "ys-agent-tool-label", text: "Output" });
    this.outputEl = body.createEl("pre", { cls: "ys-agent-tool-output" });
    this.update(item);
  }

  update(item: ItemOf<"tool">): void {
    this.el.toggleClass("is-running", !item.done);
    this.el.toggleClass("is-error", item.done && item.isError);
    this.el.toggleClass("is-done", item.done && !item.isError);
    this.statusEl.setText(item.done ? (item.isError ? "failed" : "done") : "running…");
    if (item.output !== this.lastOutput) {
      this.lastOutput = item.output;
      this.outputEl.setText(item.output.length === 0 ? "(no output)" : clampOutput(item.output));
    }
  }
}

class ErrorCell implements Cell<"error"> {
  readonly kind = "error";
  readonly el: HTMLElement;

  constructor(item: ItemOf<"error">) {
    this.el = createDiv({ cls: "ys-agent-cell ys-agent-error", text: item.message });
  }

  update(item: ItemOf<"error">): void {
    this.el.setText(item.message);
  }
}

interface Slot {
  item: TranscriptItem;
  cell: Cell;
}

/**
 * Keyed incremental transcript renderer. Transcript items are immutable and
 * only appended or replaced in place, so the array index is a stable key:
 * unchanged references are skipped, changed items update their existing
 * cell, and a shorter list (session reset) drops trailing cells. Reusing
 * elements keeps `<details>` open state and scroll position stable while
 * deltas stream.
 */
export class TranscriptRenderer {
  private readonly slots: Slot[] = [];
  private readonly placeholderEl: HTMLElement;

  constructor(
    private readonly app: App,
    private readonly component: Component,
    private readonly container: HTMLElement,
    placeholderText: string
  ) {
    this.placeholderEl = container.createDiv({ cls: "ys-agent-placeholder", text: placeholderText });
  }

  render(items: readonly TranscriptItem[]): void {
    this.placeholderEl.toggleClass("is-hidden", items.length > 0);
    while (this.slots.length > items.length) {
      this.slots.pop()?.cell.el.remove();
    }
    items.forEach((item, index) => {
      const slot = this.slots[index];
      if (slot === undefined) {
        const cell = this.createCell(item);
        this.container.appendChild(cell.el);
        this.slots.push({ item, cell });
        return;
      }
      if (slot.item === item) return;
      if (slot.cell.kind !== item.kind) {
        const cell = this.createCell(item);
        slot.cell.el.replaceWith(cell.el);
        this.slots[index] = { item, cell };
        return;
      }
      this.updateCell(slot.cell, item);
      slot.item = item;
    });
  }

  private createCell(item: TranscriptItem): Cell {
    switch (item.kind) {
      case "user":
        return new UserCell(item);
      case "assistant":
        return new AssistantCell(this.app, this.component, item);
      case "tool":
        return new ToolCell(item);
      case "error":
        return new ErrorCell(item);
      default: {
        const _exhaustive: never = item;
        throw new Error(`Unknown transcript item: ${String(_exhaustive)}`);
      }
    }
  }

  private updateCell(cell: Cell, item: TranscriptItem): void {
    // `render` guarantees kinds match before calling; narrow per kind here.
    switch (item.kind) {
      case "user":
        (cell as UserCell).update(item);
        return;
      case "assistant":
        (cell as AssistantCell).update(item);
        return;
      case "tool":
        (cell as ToolCell).update(item);
        return;
      case "error":
        (cell as ErrorCell).update(item);
        return;
      default: {
        const _exhaustive: never = item;
        void _exhaustive;
      }
    }
  }
}
