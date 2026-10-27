/**
 * The notice on the video while SubBot works: a small frosted pill in the top
 * corner with a progress ring, one word and the percentage, and an x that hides it
 * for the rest of the run.
 *
 * Inline styles only, so it needs no stylesheet and the host page's CSS does not
 * reach it. Only the x takes a click. `transcribe: { status: false }` turns it off.
 */

const FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",system-ui,sans-serif';
const SVG = 'http://www.w3.org/2000/svg';
const FADE_MS = 240;
/** How long the last word stays before the pill fades. */
const HOLD_MS = 1500;
/** The ring's circumference: radius 5. */
const RING = 2 * Math.PI * 5;

// Size and place are all set here: a host rule such as `.stage > * { width: 100% }`
// would otherwise stretch the pill across the player.
const ROOT =
  'position:absolute;top:10px;right:10px;bottom:auto;left:auto;margin:0;z-index:2147483000;' +
  'pointer-events:none;width:auto;min-width:0;max-width:calc(100% - 20px);height:22px;' +
  'min-height:0;max-height:22px;float:none;transform:none;overflow:hidden;' +
  'display:inline-flex;align-items:center;gap:5px;box-sizing:border-box;' +
  'padding:0 3px 0 7px;border-radius:11px;white-space:nowrap;' +
  'background:rgba(28,28,30,.55);-webkit-backdrop-filter:saturate(180%) blur(16px);' +
  'backdrop-filter:saturate(180%) blur(16px);' +
  'box-shadow:inset 0 0 0 .5px rgba(255,255,255,.14),0 2px 8px rgba(0,0,0,.18);' +
  `color:rgba(255,255,255,.9);font:500 11px/1 ${FONT};letter-spacing:-.005em;` +
  `opacity:0;transition:opacity ${FADE_MS}ms ease;`;
const PCT = 'font-variant-numeric:tabular-nums;color:rgba(255,255,255,.55);';
const CLOSE =
  'pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;' +
  'width:16px;height:16px;margin:0;padding:0;border:0;border-radius:50%;cursor:pointer;' +
  'background:transparent;color:rgba(255,255,255,.55);';

function still(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function svg(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

export class Notice {
  private root: HTMLDivElement | null = null;
  private label: HTMLSpanElement | null = null;
  private pct: HTMLSpanElement | null = null;
  private arc: SVGElement | null = null;
  private spin: Animation | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The viewer closed it: nothing more is drawn for this run. */
  private closed = false;

  constructor(private readonly host: () => HTMLElement | null) {}

  private build(): boolean {
    if (this.root) return true;
    const parent = this.host();
    if (!parent) return false;
    const root = document.createElement('div');
    root.setAttribute('data-subtitledb-status', '');
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.style.cssText = ROOT;

    const ring = svg('svg', {
      width: '12',
      height: '12',
      viewBox: '0 0 12 12',
      'aria-hidden': 'true',
    });
    ring.style.cssText = 'flex:none;transform:rotate(-90deg);';
    ring.append(
      svg('circle', {
        cx: '6',
        cy: '6',
        r: '5',
        fill: 'none',
        stroke: 'rgba(255,255,255,.25)',
        'stroke-width': '1.6',
      }),
    );
    const arc = svg('circle', {
      cx: '6',
      cy: '6',
      r: '5',
      fill: 'none',
      stroke: '#fff',
      'stroke-width': '1.6',
      'stroke-linecap': 'round',
      'stroke-dasharray': `0 ${RING}`,
    });
    arc.style.cssText = 'transition:stroke-dasharray .4s ease;transform-origin:6px 6px;';
    ring.append(arc);

    const label = document.createElement('span');
    const pct = document.createElement('span');
    pct.style.cssText = PCT;

    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Hide');
    close.style.cssText = CLOSE;
    const x = svg('svg', { width: '8', height: '8', viewBox: '0 0 8 8', 'aria-hidden': 'true' });
    x.append(
      svg('path', {
        d: 'M1 1l6 6M7 1L1 7',
        stroke: 'currentColor',
        'stroke-width': '1.4',
        'stroke-linecap': 'round',
      }),
    );
    close.append(x);
    close.addEventListener('mouseenter', () => {
      close.style.color = '#fff';
    });
    close.addEventListener('mouseleave', () => {
      close.style.color = 'rgba(255,255,255,.55)';
    });
    // The player under it must not see this click as a play or pause.
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dblclick']) {
      close.addEventListener(type, (e) => e.stopPropagation());
    }
    close.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.closed = true;
      this.remove(true);
    });

    root.append(ring, label, pct, close);
    parent.append(root);
    Object.assign(this, { root, label, pct, arc });
    requestAnimationFrame(() => {
      root.style.opacity = '1';
    });
    return true;
  }

  /** `progress` is 0 to 1, or null while there is nothing to measure. */
  show(text: string, progress: number | null): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    if (!this.build()) return;
    const { root, label, pct, arc } = this;
    if (!root || !label || !pct || !arc) return;
    root.style.opacity = '1';
    if (label.textContent !== text) label.textContent = text;
    if (progress === null) {
      if (pct.textContent) pct.textContent = '';
      pct.style.display = 'none';
      arc.setAttribute('stroke-dasharray', `${RING * 0.25} ${RING}`);
      if (!this.spin && !still() && typeof arc.animate === 'function') {
        this.spin = arc.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
          duration: 900,
          iterations: Number.POSITIVE_INFINITY,
        });
      }
      return;
    }
    this.spin?.cancel();
    this.spin = null;
    const n = Math.max(0, Math.min(100, Math.round(progress * 100)));
    pct.style.display = '';
    const text2 = `${n}%`;
    if (pct.textContent !== text2) pct.textContent = text2;
    arc.setAttribute('stroke-dasharray', `${(RING * n) / 100} ${RING}`);
  }

  /** Ends on `text` with the ring full, holds a moment, and fades out. */
  finish(text: string): void {
    if (!this.root || this.closed) return;
    this.show(text, 1);
    if (this.pct) {
      this.pct.textContent = '';
      this.pct.style.display = 'none';
    }
    this.timer = setTimeout(() => this.remove(true), HOLD_MS);
  }

  /** Takes the pill away, faded when `fade` and motion is allowed. */
  remove(fade = false): void {
    clearTimeout(this.timer);
    const root = this.root;
    if (!root) return;
    this.spin?.cancel();
    this.spin = null;
    this.root = this.label = this.pct = this.arc = null;
    if (!fade || still()) {
      root.remove();
      return;
    }
    root.style.opacity = '0';
    setTimeout(() => root.remove(), FADE_MS);
  }
}
