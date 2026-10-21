// One sheet (a <dialog>) for the looks, the sign-in and the pay screen. It traps focus, Escape closes it,
// and on a phone it rises from the bottom.

import { h } from "./dom";

export class Sheet {
  readonly dialog: HTMLDialogElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private cleanups: (() => void)[] = [];
  onOpenChange: (open: boolean) => void = () => {};

  constructor(root: HTMLElement) {
    this.title = h("h2", { id: "sheet-title" });
    this.body = h("div", { class: "sheet-body" });
    const close = h("button", { class: "btn btn-ghost sheet-close", type: "button", "aria-label": "Close", onclick: () => this.close() }, "Close");
    this.dialog = h("dialog", { class: "sheet", "aria-labelledby": "sheet-title" }, h("div", { class: "sheet-head" }, this.title, close), this.body);
    this.dialog.addEventListener("close", () => this.closed());
    this.dialog.addEventListener("click", (e) => {
      if (e.target === this.dialog) this.close();
    });
    root.append(this.dialog);
  }

  /** Shows `content` under `title`. `cleanup` runs when the sheet closes or shows something else. */
  show(title: string, content: Node, cleanup?: () => void) {
    this.runCleanups();
    if (cleanup) this.cleanups.push(cleanup);
    this.title.textContent = title;
    this.body.replaceChildren(content);
    if (!this.dialog.open) {
      this.dialog.showModal();
      this.onOpenChange(true);
    }
    this.body.scrollTop = 0;
  }

  onClose(fn: () => void) {
    this.cleanups.push(fn);
  }

  get open() {
    return this.dialog.open;
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  private runCleanups() {
    const list = this.cleanups;
    this.cleanups = [];
    for (const fn of list) fn();
  }

  private closed() {
    this.runCleanups();
    this.onOpenChange(false);
  }
}
