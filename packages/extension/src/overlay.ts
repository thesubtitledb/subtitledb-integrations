/**
 * Draws subtitles over a video without touching the player.
 *
 * An overlay rather than a text track, because the players that matter most (Netflix,
 * Prime Video, Disney+, Max) hide every track they did not add themselves. The overlay
 * is a fixed box laid over the video's rectangle, moved inside the fullscreen element
 * when the page goes fullscreen so it stays in the top layer. When the <video> itself
 * is the fullscreen element nothing can sit over it, so the same cues go on a native
 * text track for exactly that time.
 *
 * The box also holds the control bar: a small pill at the top of the video that
 * appears while the pointer moves over it, to move the lines, resize them, hide them
 * or take them off without opening the popup.
 */
import type { Cue } from '@subtitledb/core';
import { cueLines, cuesAt } from './cues.js';
import { withoutHearingImpaired } from './hi.js';
import type { BarText, Edge, Font, Style } from './shared.js';

const CSS = `
:host{all:initial}
.wrap{position:absolute;left:0;right:0;display:flex;flex-direction:column;align-items:center;
  gap:.06em;padding:0 5%;pointer-events:none;line-height:1.25}
.line{padding:.04em .34em;border-radius:.14em;text-align:center;white-space:pre-wrap;
  -webkit-box-decoration-break:clone;box-decoration-break:clone}
.wrap[hidden]{display:none}
.bar{position:absolute;top:12px;left:50%;transform:translate(-50%,-6px);display:flex;align-items:center;
  gap:2px;padding:4px;border-radius:999px;background:rgba(44,44,46,.86);color:#fff;
  -webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);
  box-shadow:0 0 0 .5px rgba(255,255,255,.12),0 6px 20px rgba(0,0,0,.35);
  font:500 13px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;
  opacity:0;pointer-events:none;transition:opacity .35s ease,transform .35s ease;white-space:nowrap;
  font-variant-numeric:tabular-nums}
.bar.on{opacity:1;transform:translate(-50%,0);pointer-events:auto;transition-duration:.15s}
.bar button{all:unset;box-sizing:border-box;height:30px;min-width:30px;padding:0 10px;border-radius:999px;
  display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:inherit}
.bar button:hover{background:rgba(255,255,255,.14)}
.bar button:active{background:rgba(255,255,255,.24)}
.bar button:focus-visible{outline:2px solid #0a84ff;outline-offset:1px}
.bar output{min-width:52px;text-align:center;color:rgba(235,235,245,.6)}
.bar i{width:1px;height:16px;background:rgba(255,255,255,.18);margin:0 3px}
.bar svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
@media (prefers-reduced-motion:reduce){.bar{transition:none}}
`;

/** The bar fades this long after the pointer last moved over the video. */
const BAR_IDLE_MS = 2500;
/** And this long after the pointer leaves the bar or the video. */
const BAR_LEAVE_MS = 600;

export const FAMILY: Record<Font, string> = {
  system:
    '-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",Arial,system-ui,sans-serif',
  serif: '"New York",ui-serif,Georgia,"Times New Roman",serif',
  rounded: 'ui-rounded,"SF Pro Rounded","Arial Rounded MT Bold",Nunito,system-ui,sans-serif',
  mono: 'ui-monospace,"SF Mono",Menlo,Consolas,monospace',
};

/** The text edge as a text-shadow, in em so it scales with the text. */
export function edgeShadow(edge: Edge): string {
  const k = 'rgba(0,0,0,.92)';
  switch (edge) {
    case 'outline':
      return [
        [-1, -1],
        [0, -1],
        [1, -1],
        [-1, 0],
        [1, 0],
        [-1, 1],
        [0, 1],
        [1, 1],
      ]
        .map(([x, y]) => `${(x as number) * 0.045}em ${(y as number) * 0.045}em 0 ${k}`)
        .join(',');
    case 'shadow':
      return `0 0 .1em ${k},0 .04em .14em ${k}`;
    case 'raised':
      return `.05em .05em 0 ${k},.07em .07em .04em rgba(0,0,0,.5)`;
    case 'depressed':
      return `-.04em -.04em 0 ${k},.03em .03em 0 rgba(255,255,255,.35)`;
    default:
      return 'none';
  }
}

function rgba(hex: string, a: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export interface OverlayOptions {
  style: Style;
  offsetMs?: number;
  hidden?: boolean;
  language?: string;
  removeHi?: boolean;
  /** The bar's labels, or null for no bar. */
  bar?: BarText | null;
  rtl?: boolean;
  onGone?: () => void;
  /** What the bar's buttons do; the content script owns the state. */
  actions?: {
    shift(deltaMs: number): void;
    size(delta: number): void;
    hide(): void;
    remove(): void;
  };
}

/** Icon paths; built with createElementNS, as pages with Trusted Types refuse innerHTML. */
const ICON: Record<'earlier' | 'later' | 'hide' | 'show' | 'remove', string[]> = {
  earlier: ['M8 5 3 10l5 5M3 10h11'],
  later: ['M12 5l5 5-5 5M17 10H6'],
  hide: ['M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6Z', 'M12.5 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z'],
  show: [
    'M3 3l14 14',
    'M8.5 4.2A8 8 0 0 1 10 4c5 0 8 6 8 6a14 14 0 0 1-2.6 3.3',
    'M5.6 6.1C3.4 7.6 2 10 2 10s3 6 8 6a7.6 7.6 0 0 0 3.6-.9',
  ],
  remove: ['M5 5l10 10M15 5 5 15'],
};

const SVG = 'http://www.w3.org/2000/svg';

function icon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** "A" with a small minus or plus. */
function letter(sign: string): HTMLSpanElement {
  const s = document.createElement('span');
  const small = document.createElement('small');
  small.textContent = sign;
  s.append('A', small);
  return s;
}

export class Overlay {
  readonly host: HTMLElement;
  private readonly wrap: HTMLDivElement;
  private readonly bar: HTMLDivElement | null = null;
  private readonly readout: HTMLOutputElement | null = null;
  private readonly hideBtn: HTMLButtonElement | null = null;
  private raf = 0;
  private shown = '';
  private placed = '';
  private track: TextTrack | null = null;
  private trackOffset = Number.NaN;
  private barUntil = 0;
  private overBar = false;
  private rect: DOMRect | null = null;
  private readonly src: string;
  private style: Style;
  private offsetMs: number;
  private hidden: boolean;
  private removeHi: boolean;

  constructor(
    readonly video: HTMLVideoElement,
    private cues: Cue[],
    private readonly o: OverlayOptions,
  ) {
    this.style = o.style;
    this.offsetMs = o.offsetMs ?? 0;
    this.hidden = o.hidden ?? false;
    this.removeHi = o.removeHi ?? false;
    this.host = document.createElement('tsdb-subtitles');
    const root = this.host.attachShadow({ mode: 'closed' });
    const sheet = document.createElement('style');
    sheet.textContent = CSS;
    this.wrap = document.createElement('div');
    this.wrap.className = 'wrap';
    root.append(sheet, this.wrap);
    if (o.bar && o.actions) {
      const a = o.actions;
      const t = o.bar;
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', t.label);
      if (o.rtl) bar.dir = 'rtl';
      const btn = (label: string, face: Node, fn: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.title = label;
        b.setAttribute('aria-label', label);
        b.append(face);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          fn();
        });
        return b;
      };
      const readout = document.createElement('output');
      readout.dir = 'ltr';
      this.readout = readout;
      this.hideBtn = btn(t.hide, icon(ICON.hide), () => a.hide());
      bar.append(
        btn(t.earlier, icon(ICON.earlier), () => a.shift(-500)),
        readout,
        btn(t.later, icon(ICON.later), () => a.shift(500)),
        document.createElement('i'),
        btn(t.smaller, letter('−'), () => a.size(-0.4)),
        btn(t.bigger, letter('+'), () => a.size(0.4)),
        document.createElement('i'),
        this.hideBtn,
        btn(t.remove, icon(ICON.remove), () => a.remove()),
      );
      for (const ev of ['pointerdown', 'mousedown', 'dblclick'] as const) {
        // The player under the bar must not take these as a pause or fullscreen.
        bar.addEventListener(ev, (e) => e.stopPropagation());
      }
      bar.addEventListener('pointerenter', () => {
        this.overBar = true;
      });
      bar.addEventListener('pointerleave', () => {
        this.overBar = false;
        this.barUntil = performance.now() + BAR_LEAVE_MS;
      });
      root.append(bar);
      this.bar = bar;
      document.addEventListener('pointermove', this.moved, { capture: true, passive: true });
      this.syncBar();
    }
    this.src = video.currentSrc;
    video.addEventListener('emptied', this.emptied);
    this.tick();
  }

  setOffset(ms: number): void {
    this.offsetMs = ms;
    this.shown = '';
    this.syncBar();
  }

  setStyle(s: Style): void {
    this.style = s;
    this.placed = '';
    this.shown = '';
  }

  setHidden(h: boolean): void {
    this.hidden = h;
    this.shown = '';
    this.syncBar();
  }

  setRemoveHi(on: boolean): void {
    this.removeHi = on;
    this.shown = '';
    this.trackOffset = Number.NaN;
  }

  /** The text on screen now, for the popup's state and for tests. */
  text(): string {
    return this.hidden || this.wrap.hidden ? '' : (this.wrap.textContent ?? '');
  }

  /** True while the bar is showing. For tests. */
  barShown(): boolean {
    return this.bar?.classList.contains('on') ?? false;
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.video.removeEventListener('emptied', this.emptied);
    document.removeEventListener('pointermove', this.moved, { capture: true });
    this.host.remove();
    if (this.track) {
      this.track.mode = 'disabled';
      for (const c of Array.from(this.track.cues ?? [])) this.track.removeCue(c);
    }
  }

  private readonly moved = (e: PointerEvent) => {
    const r = this.rect;
    if (!r) return;
    if (
      e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom
    ) {
      this.barUntil = performance.now() + BAR_IDLE_MS;
    } else {
      // Off the video: fade soon, as a player's own controls do.
      this.barUntil = Math.min(this.barUntil, performance.now() + BAR_LEAVE_MS);
    }
  };

  private syncBar(): void {
    if (!this.readout || !this.hideBtn || !this.o.bar) return;
    const s = this.offsetMs / 1000;
    this.readout.textContent = `${s > 0 ? '+' : s < 0 ? '−' : ''}${Math.abs(s).toFixed(1)} s`;
    const label = this.hidden ? this.o.bar.show : this.o.bar.hide;
    this.hideBtn.title = label;
    this.hideBtn.setAttribute('aria-label', label);
    this.hideBtn.setAttribute('aria-pressed', String(this.hidden));
    this.hideBtn.replaceChildren(icon(this.hidden ? ICON.show : ICON.hide));
  }

  /** A new source in the same element (the next video on a page that reuses it). */
  private readonly emptied = () => {
    if (this.src && this.video.currentSrc !== this.src) this.o.onGone?.();
  };

  private readonly tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    const fs = fullscreenElement();
    const native = fs === this.video;
    this.syncTrack(native);
    const rect = this.video.getBoundingClientRect();
    const visible =
      !native &&
      this.video.isConnected &&
      rect.width > 1 &&
      rect.height > 1 &&
      (!fs || contains(fs, this.video));
    // Hidden subtitles keep the box while there is a bar to bring them back.
    if (!visible || (this.hidden && !this.bar)) {
      this.rect = null;
      if (this.host.isConnected) this.host.remove();
      return;
    }
    this.rect = rect;
    const parent = fs ?? document.body ?? document.documentElement;
    if (this.host.parentNode !== parent) parent.appendChild(this.host);
    this.place(rect);
    this.paint(rect.height);
    this.bar?.classList.toggle(
      'on',
      // A button reached with the keyboard keeps the bar up while it has focus.
      this.overBar || performance.now() < this.barUntil || this.bar.matches(':focus-within'),
    );
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
    this.wrap.style.fontFamily = FAMILY[this.style.font];
    this.wrap.style.fontWeight = String(this.style.weight);
  }

  private paint(height: number): void {
    const active = this.hidden
      ? []
      : cuesAt(this.cues, this.video.currentTime * 1000, this.offsetMs);
    const key = `${active.map((c) => `${c.start}-${c.end}`).join(',')}|${height > 0}`;
    if (key === this.shown) return;
    this.shown = key;
    const lines = active.flatMap((c) =>
      cueLines(this.removeHi ? withoutHearingImpaired(c.text) : c.text),
    );
    const shadow = edgeShadow(this.style.edge);
    const box = rgba(this.style.boxColor, this.style.box);
    this.wrap.replaceChildren(
      ...lines.map((spans) => {
        const line = document.createElement('div');
        line.className = 'line';
        line.style.color = this.style.color;
        line.style.background = box;
        line.style.textShadow = shadow;
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
    if (!this.track)
      this.track = this.video.addTextTrack('subtitles', 'TSDB', this.o.language ?? '');
    if (this.trackOffset !== this.offsetMs) {
      for (const c of Array.from(this.track.cues ?? [])) this.track.removeCue(c);
      for (const c of this.cues) {
        const s = (c.start + this.offsetMs) / 1000;
        const e = (c.end + this.offsetMs) / 1000;
        const text = this.removeHi ? withoutHearingImpaired(c.text) : c.text;
        if (e > 0 && text) this.track.addCue(new VTTCue(Math.max(0, s), e, text));
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
