// Miu canvas renderer contract.

import type { BotEmoteName, BotStateName } from "../core/layout";

export type CharacterEmote = BotEmoteName | "greeting";

export interface BodyCircle {
  /** Centre and radius in canvas-local CSS pixels. */
  cx: number;
  cy: number;
  r: number;
}

export interface CharacterRenderer {
  readonly canvas: HTMLCanvasElement;
  /** Canvas size in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** The clickable body, canvas-local. */
  body(): BodyCircle;
  /**
   * Gap between the bottom of the body and the bottom of the canvas, so the
   * widget can stand the character on the edge of the window.
   */
  readonly footGap: number;

  /** Body size in CSS pixels. */
  setSize(bodySize: number): void;
  setState(state: BotStateName): void;
  playEmote(emote: CharacterEmote): void;
  /** Where the character looks, -1…1 on each axis (0 = straight ahead). */
  setLook(x: number, y: number): void;
  /** A click on the body that should not change any task state. */
  poke(): void;
  /** The user is dragging the character around (optional "held" pose). */
  setDragged?(on: boolean): void;
  /** A file is being dragged over the widget / was dropped on it. */
  setDropHover(on: boolean): void;
  swallow(): void;

  /** The longer hello for launch and for switching to this character (falls back to the "greeting" emote). */
  playIntro?(): void;
  /** Music is playing: dance along. */
  setDancing?(on: boolean): void;

  setReducedMotion(on: boolean): void;
  pause(): void;
  resume(): void;
  destroy(): void;
}
