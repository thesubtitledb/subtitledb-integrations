/**
 * Draws subtitles over a video without touching the player.
 *
 * An overlay rather than a text track, because the players that matter most (Netflix,
 * Prime Video, Disney+, Max) hide every track they did not add themselves. The overlay
 * is a fixed box laid over the video's rectangle, moved inside the fullscreen element
 * when the page goes fullscreen so it stays in the top layer. When the <video> itself
 * is the fullscreen element nothing can sit over it, so the same cues go on a native
 * text track for exactly that time.
 */
import type { Cue } from '@subtitledb/core';
import { cueLines, cuesAt } from './cues.js';
import type { Style } from './shared.js';

const CSS = `
:host{all:initial}
.wrap{position:absolute;left:0;right:0;display:flex;flex-direction:column;align-items:center;
  gap:.06em;padding:0 5%;pointer-events:none;
  font-family:"Archivo","Helvetica Neue",Arial,system-ui,sans-serif;font-weight:500;line-height:1.25}
.line{padding:.04em .34em;border-radius:.14em;text-align:center;white-space:pre-wrap;
  text-shadow:0 0 .1em rgba(0,0,0,.85),0 .04em .1em rgba(0,0,0,.85);
  -webkit-box-decoration-break:clone;box-decoration-break:clone}
.wrap[hidden]{display:none}
`;

export class Overlay {
  readonly host: HTMLElement;
  private readonly wrap: HTMLDivElement;
  private raf = 0;
  private shown = '';
  private placed = '';
  private track: TextTrack | null = null;
  private trackOffset = Number.NaN;
  private readonly src: string;

  constructor(
    readonly video: HTMLVideoElement,
    private cues: Cue[],
    private style: Style,
    private offsetMs = 0,
    private hidden = false,
    private readonly language = '',
    private readonly onGone: () => void = () => {},
  ) {
    this.host = document.createElement('tsdb-subtitles');
    const root = this.host.attachShadow({ mode: 'closed' });
    const sheet = document.createElement('style');
    sheet.textContent = CSS;
    this.wrap = document.createElement('div');
    this.wrap.className = 'wrap';
    root.append(sheet, this.wrap);
    this.src = video.currentSrc;
    video.addEventListener('emptied', this.emptied);
    this.tick();
  }

  setOffset(ms: number): void {
    this.offsetMs = ms;
    this.shown = '';
  }

  setStyle(s: Style): void {
    this.style = s;
    this.placed = '';
    this.shown = '';
  }

  setHidden(h: boolean): void {
    this.hidden = h;
    this.shown = '';
  }

  /** The text on screen now, for the popup's state and for tests. */
  text(): string {
    return this.hidden || this.wrap.hidden ? '' : (this.wrap.textContent ?? '');
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.video.removeEventListener('emptied', this.emptied);
    this.host.remove();
    if (this.track) {
      this.track.mode = 'disabled';
      for (const c of Array.from(this.track.cues ?? [])) this.track.removeCue(c);
    }
  }

  /** A new source in the same element (the next video on a page that reuses it). */
  private readonly emptied = () => {
    if (this.src && this.video.currentSrc !== this.src) this.onGone();
  };

  private readonly tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    const fs = fullscreenElement();
    const native = fs === this.video;
    this.syncTrack(native);
    const rect = this.video.getBoundingClientRect();
    const visible =
      !native &&
      !this.hidden &&
      this.video.isConnected &&
      rect.width > 1 &&
      rect.height > 1 &&
      (!fs || contains(fs, this.video));
    if (!visible) {
      if (this.host.isConnected) this.host.remove();
      return;
    }
    const parent = fs ?? document.body ?? document.documentElement;
    if (this.host.parentNode !== parent) parent.appendChild(this.host);
    this.place(rect);
    this.paint(rect.height);
  };

  private place(r: DOMRect): void {
    const fs = Math.max(11, (r.height * this.style.size) / 100);
    const key = `${r.left},${r.top},${r.width},${r.height},${fs}`;
    if (key === this.placed) return;
    this.placed = key;
    this.host.style.cssText = [
      'all:initial',
      'position:fixed',
      `left:${r.left}px`,
      `top:${r.top}px`,
      `width:${r.width}px`,
      `height:${r.height}px`,
      'pointer-events:none',
      'z-index:2147483647',
      'display:block',
      'overflow:hidden',
      `font-size:${fs.toFixed(1)}px`,
    ].join(';');
    this.wrap.style.bottom = `${((r.height * this.style.bottom) / 100).toFixed(1)}px`;
  }

  private paint(height: number): void {
    const active = cuesAt(this.cues, this.video.currentTime * 1000, this.offsetMs);
    const key = `${active.map((c) => `${c.start}-${c.end}`).join(',')}|${height > 0}`;
    if (key === this.shown) return;
    this.shown = key;
    const lines = active.flatMap((c) => cueLines(c.text));
    this.wrap.replaceChildren(
      ...lines.map((spans) => {
        const line = document.createElement('div');
        line.className = 'line';
        line.style.color = this.style.color;
        line.style.background = `rgba(0,0,0,${this.style.box})`;
        for (const s of spans) {
          let node: Node = document.createTextNode(s.text);
          for (const tag of ['u', 'i', 'b'] as const) {
            if (!s[tag]) continue;
            const el = document.createElement(tag);
            el.append(node);
            node = el;
          }
          line.append(node);
        }
        return line;
      }),
    );
    this.wrap.hidden = lines.length === 0;
  }

  /** The native track exists only once the video itself has been fullscreen. */
  private syncTrack(native: boolean): void {
    if (!native) {
      if (this.track && this.track.mode !== 'disabled') this.track.mode = 'disabled';
      return;
    }
    if (!this.track) this.track = this.video.addTextTrack('subtitles', 'TSDB', this.language);
    if (this.trackOffset !== this.offsetMs) {
      for (const c of Array.from(this.track.cues ?? [])) this.track.removeCue(c);
      for (const c of this.cues) {
        const s = (c.start + this.offsetMs) / 1000;
        const e = (c.end + this.offsetMs) / 1000;
        if (e > 0) this.track.addCue(new VTTCue(Math.max(0, s), e, c.text));
      }
      this.trackOffset = this.offsetMs;
    }
    const want = this.hidden ? 'disabled' : 'showing';
    if (this.track.mode !== want) this.track.mode = want;
  }
}

function fullscreenElement(): Element | null {
  const d = document as Document & { webkitFullscreenElement?: Element | null };
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

/** contains() that also looks through shadow roots. */
function contains(outer: Element, inner: Node): boolean {
  let n: Node | null = inner;
  while (n) {
    if (n === outer) return true;
    n = n.parentNode ?? (n instanceof ShadowRoot ? n.host : null);
  }
  return false;
}
