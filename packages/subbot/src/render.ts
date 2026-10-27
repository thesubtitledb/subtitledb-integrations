/**
 * Cues on screen, through the element's own text track.
 *
 * The browser renders a TextTrack in `showing` mode itself, on every element, under
 * every player that leaves native tracks alone. The html5 adapter adds a `<track>`
 * with no src for the transcription row before anything is selected; its TextTrack
 * is the one used when it exists, so the row the viewer picked is the row that
 * fills, and when the complete file is handed over as its `src` later the browser
 * swaps the cues in place. Without one, a track is added to the element.
 *
 * Once a second the track is looked at. Still showing: nothing to do. Another track
 * showing: the viewer picked a different subtitle, so nothing is drawn, and the
 * transcription carries on behind it. Nothing showing: a player that owns captions
 * turned the native track off, and an overlay takes over.
 */
import type { Cue } from './cues.js';

declare const VTTCue: new (start: number, end: number, text: string) => TextTrackCue;

const CHECK_MS = 1000;

export class TrackRenderer {
  private track: TextTrack | null = null;
  /** True when this renderer added the track, so it must take it away again. */
  private owned = false;
  private live = new Map<Cue, TextTrackCue>();
  private overlay: HTMLDivElement | null = null;
  private statusEl: HTMLDivElement | null = null;
  private cues: Cue[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private checkTimer: ReturnType<typeof setInterval> | undefined;
  private handedOver = false;

  constructor(
    private readonly media: HTMLMediaElement,
    private readonly label: string,
    private readonly language: string,
    private readonly showStatus: boolean,
  ) {}

  private open(): TextTrack | null {
    if (this.track) return this.track;
    if (typeof VTTCue !== 'function') return null;
    for (const el of Array.from(this.media.querySelectorAll('track'))) {
      if (el.label === this.label && !el.getAttribute('src') && el.track) {
        this.track = el.track;
        break;
      }
    }
    if (!this.track && typeof this.media.addTextTrack === 'function') {
      this.track = this.media.addTextTrack('subtitles', this.label, this.language);
      this.owned = true;
    }
    if (this.track) {
      this.track.mode = 'showing';
      clearInterval(this.checkTimer);
      this.checkTimer = setInterval(() => this.check(), CHECK_MS);
    }
    return this.track;
  }

  private otherShowing(): boolean {
    const tracks = this.media.textTracks;
    if (!tracks) return false;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t && t !== this.track && t.mode === 'showing') return true;
    }
    return false;
  }

  private check(): void {
    if (this.handedOver || !this.track) return;
    if (this.track.mode === 'showing') {
      if (this.overlay) this.overlay.style.display = 'none';
      return;
    }
    if (this.otherShowing()) {
      if (this.overlay) this.overlay.style.display = 'none';
      return;
    }
    // Nothing on screen and the viewer did not choose that: draw it ourselves.
    this.track.mode = 'hidden';
    if (!this.overlay) this.showOverlay();
    else this.overlay.style.display = '';
  }

  apply(added: Cue[], removed: Cue[]): void {
    this.cues = this.cues.filter((c) => !removed.includes(c)).concat(added);
    const track = this.open();
    if (!track) {
      if (!this.overlay) this.showOverlay();
      return;
    }
    for (const c of removed) {
      const live = this.live.get(c);
      if (!live) continue;
      try {
        track.removeCue(live);
      } catch {
        // Already gone.
      }
      this.live.delete(c);
    }
    for (const c of added) {
      if (c.end <= c.start) continue;
      const cue = new VTTCue(c.start, c.end, c.text);
      try {
        track.addCue(cue);
        this.live.set(c, cue);
      } catch {
        // A cue the browser rejects is dropped, not fatal.
      }
    }
  }

  private container(): HTMLElement | null {
    const parent = this.media.parentElement;
    if (!parent) return null;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    return parent;
  }

  private showOverlay(): void {
    const parent = this.container();
    if (!parent) return;
    const div = document.createElement('div');
    div.setAttribute('data-subtitledb-overlay', '');
    div.style.cssText =
      'position:absolute;left:0;right:0;bottom:8%;text-align:center;pointer-events:none;' +
      'font:600 clamp(14px,2.6vw,28px)/1.3 sans-serif;color:#fff;' +
      'text-shadow:0 0 4px #000,0 0 8px #000;white-space:pre-wrap;z-index:2147483000;';
    parent.append(div);
    this.overlay = div;
    const tick = () => {
      const t = this.media.currentTime;
      const text = this.cues
        .filter((c) => c.start <= t && t < c.end)
        .map((c) => c.text)
        .join('\n');
      if (div.textContent !== text) div.textContent = text;
    };
    this.media.addEventListener('timeupdate', tick);
    this.timer = setInterval(tick, 250);
  }

  /** A short line in the corner while something is downloading or warming up. */
  status(text: string | null): void {
    if (!this.showStatus) return;
    if (!text) {
      this.statusEl?.remove();
      this.statusEl = null;
      return;
    }
    if (!this.statusEl) {
      const parent = this.container();
      if (!parent) return;
      const div = document.createElement('div');
      div.setAttribute('data-subtitledb-status', '');
      div.style.cssText =
        'position:absolute;left:12px;top:12px;padding:4px 10px;border-radius:4px;pointer-events:none;' +
        'font:500 13px/1.4 sans-serif;color:#fff;background:rgba(0,0,0,.6);z-index:2147483000;';
      parent.append(div);
      this.statusEl = div;
    }
    if (this.statusEl.textContent !== text) this.statusEl.textContent = text;
  }

  /**
   * The complete file is now the adapter's to show. A `<track>` that was found gets
   * its `src` set by the adapter and the browser replaces the cues itself; a track
   * this renderer added is taken away once the adapter's own track is showing.
   */
  handover(): void {
    this.handedOver = true;
    clearInterval(this.checkTimer);
    this.status(null);
    if (!this.owned && !this.overlay) return;
    const started = Date.now();
    const poll = () => {
      if (this.otherShowing() || Date.now() - started > 15_000) {
        this.dispose();
        return;
      }
      setTimeout(poll, 250);
    };
    poll();
  }

  dispose(): void {
    clearInterval(this.checkTimer);
    clearInterval(this.timer);
    this.overlay?.remove();
    this.overlay = null;
    this.status(null);
    if (this.track) {
      for (const cue of this.live.values()) {
        try {
          this.track.removeCue(cue);
        } catch {
          // Already gone.
        }
      }
      this.live.clear();
      if (this.owned) this.track.mode = 'disabled';
    }
    this.cues = [];
  }
}
