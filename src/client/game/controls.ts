// Controls, phones first.
// - Touch: a thumbstick appears where the left thumb lands (left half of the screen) and moves the character;
//   a drag on the right half turns the camera. Both at once work: each finger is tracked by its own id.
//   The Jump button sits at the bottom right.
// - Computer: WASD or the arrow keys move, Space jumps, a mouse drag anywhere turns the camera.
// - Leaving the page (another tab or window, a pop-up, Cmd+Tab, another app on a phone) lets everything go. The
//   browser sends a key's "up" only to the window that has the focus, so a key that is down when you leave would
//   otherwise stay down and the character would walk on by itself when you come back. `releaseWhenLost` from the
//   kit (`@nano133/nanoterra/input`) does it: at each leave it calls `release`, and it drops key repeats until a key
//   goes down again.

import { releaseWhenLost, swallowsKeyup } from "@nano133/nanoterra/input";

const STICK_RADIUS = 56;
const TOUCH_LOOK = 0.0062;
const MOUSE_LOOK = 0.0045;

export class Controls {
  /** -1..1: x to the right, y forward. */
  readonly move = { x: 0, y: 0 };
  private look = { x: 0, y: 0 };
  private jumpQueued = false;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private stickVec = { x: 0, y: 0 };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private keys = new Set<string>();
  enabled = true;

  constructor(
    private readonly area: HTMLElement,
    private readonly stick: HTMLElement,
    private readonly knob: HTMLElement,
    jumpButton: HTMLElement,
  ) {
    area.addEventListener("pointerdown", this.down);
    area.addEventListener("pointermove", this.moveEvent);
    area.addEventListener("pointerup", this.up);
    area.addEventListener("pointercancel", this.up);
    area.addEventListener("lostpointercapture", this.up);
    area.addEventListener("contextmenu", (e) => e.preventDefault());
    jumpButton.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.jumpQueued = true;
    });
    window.addEventListener("keydown", this.key);
    window.addEventListener("keyup", this.key);
    // A blur, a focus, a page hide, a hidden tab, the Cmd key: let go of everything. After a leave a key repeat is dropped
    // until a key goes down again (the key's "up" went to the other window; a late repeat would put it back).
    releaseWhenLost(() => this.release());
  }

  private down = (e: PointerEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    const touchLike = e.pointerType !== "mouse";
    if (touchLike && this.stickId === null && e.clientX < window.innerWidth / 2) {
      this.stickId = e.pointerId;
      this.stickOrigin = { x: e.clientX, y: e.clientY };
      this.stickVec = { x: 0, y: 0 };
      this.stick.style.left = `${e.clientX}px`;
      this.stick.style.top = `${e.clientY}px`;
      this.knob.style.transform = "translate(-50%, -50%)";
      this.stick.hidden = false;
    } else if (this.lookId === null && (touchLike || e.button === 0)) {
      this.lookId = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
    } else return;
    try {
      this.area.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that already ended cannot be captured.
    }
  };

  private moveEvent = (e: PointerEvent) => {
    if (e.pointerId === this.stickId) {
      let dx = e.clientX - this.stickOrigin.x;
      let dy = e.clientY - this.stickOrigin.y;
      const d = Math.hypot(dx, dy);
      if (d > STICK_RADIUS) (dx *= STICK_RADIUS / d), (dy *= STICK_RADIUS / d);
      this.stickVec = { x: dx / STICK_RADIUS, y: -dy / STICK_RADIUS };
      this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    } else if (e.pointerId === this.lookId) {
      const k = e.pointerType === "mouse" ? MOUSE_LOOK : TOUCH_LOOK;
      this.look.x += (e.clientX - this.lookLast.x) * k;
      this.look.y += (e.clientY - this.lookLast.y) * k;
      this.lookLast = { x: e.clientX, y: e.clientY };
    }
  };

  private up = (e: PointerEvent) => {
    if (e.pointerId === this.stickId) {
      this.stickId = null;
      this.stickVec = { x: 0, y: 0 };
      this.stick.hidden = true;
    }
    if (e.pointerId === this.lookId) this.lookId = null;
  };

  private key = (e: KeyboardEvent) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const known = ["w", "a", "s", "d", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "];
    if (!known.includes(k)) return;
    // Keys belong to the game only while no dialog is open.
    if ((e.target as HTMLElement | null)?.closest?.("dialog[open], input, textarea, select")) return;
    if (e.type === "keyup") {
      this.keys.delete(k);
      e.preventDefault();
      return;
    }
    // A browser shortcut (Cmd+W, Cmd+A) is not a move; a card over the game (`enabled` off) takes no key.
    if (swallowsKeyup(e) || !this.enabled) return;
    e.preventDefault();
    if (k === " " && !e.repeat) this.jumpQueued = true;
    this.keys.add(k);
  };

  /** Lets go of everything (a dialog opened, or the page was left). */
  release() {
    this.keys.clear();
    this.jumpQueued = false;
    this.look = { x: 0, y: 0 };
    this.stickId = null;
    this.lookId = null;
    this.stickVec = { x: 0, y: 0 };
    this.stick.hidden = true;
  }

  /** Called once per frame: the move vector, the camera turn since the last frame, and a jump. */
  read(): { x: number; y: number; lookX: number; lookY: number; jump: boolean } {
    let x = this.stickVec.x;
    let y = this.stickVec.y;
    if (this.keys.has("a") || this.keys.has("ArrowLeft")) x -= 1;
    if (this.keys.has("d") || this.keys.has("ArrowRight")) x += 1;
    if (this.keys.has("w") || this.keys.has("ArrowUp")) y += 1;
    if (this.keys.has("s") || this.keys.has("ArrowDown")) y -= 1;
    const len = Math.hypot(x, y);
    if (len > 1) (x /= len), (y /= len);
    this.move.x = x;
    this.move.y = y;
    const out = { x, y, lookX: this.look.x, lookY: this.look.y, jump: this.jumpQueued };
    this.look = { x: 0, y: 0 };
    this.jumpQueued = false;
    return out;
  }
}
