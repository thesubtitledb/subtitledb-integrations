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
 * On every track change, and once a second, the track is looked at. Still showing:
 * nothing to do. Another track showing: the viewer picked a different subtitle, so
 * nothing is drawn, and the transcription carries on behind it. Nothing showing on an
 * element with the browser's own controls: the viewer chose Off in its captions menu,
 * so nothing is drawn and the transcription pauses until the row is picked again.
 * Nothing showing under a player of its own: that player turned the native track off
 * to draw captions itself, and an overlay takes over.
 */
import { type Cue, held } from './cues.js';
import { Notice } from './notice.js';

declare const VTTCue: new (start: number, end: number, text: string) => TextTrackCue;

const CHECK_MS = 1000;

export class TrackRenderer {
  private track: TextTrack | null = null;
  /** True while the adapter's track loads its empty file: cues added now would be lost. */
  private loading = false;
  /** True when this renderer added the track, so it must take it away again. */
  private owned = false;
  private live = new Map<Cue, TextTrackCue>();
  private overlay: HTMLDivElement | null = null;
  private readonly notice: Notice | null;
  private cues: Cue[] = [];
  /** When each cue leaves the screen: see held(). */
  private shown = new Map<Cue, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private checkTimer: ReturnType<typeof setInterval> | undefined;
  private handedOver = false;
  private off = false;
  private readonly onChange = (): void => this.check();

  constructor(
    private readonly media: HTMLMediaElement,
    private readonly label: string,
    private readonly language: string,
    showStatus: boolean,
    /** Told when the viewer turns captions off in the browser's menu, and on again. */
    private readonly onOff: (off: boolean) => void = () => {},
  ) {
    this.notice = showStatus ? new Notice(() => this.container()) : null;
  }

  private open(): TextTrack | null {
    if (this.track) return this.track;
    if (typeof VTTCue !== 'function') return null;
    let found: HTMLTrackElement | null = null;
    for (const el of Array.from(this.media.querySelectorAll('track'))) {
      if (el.label === this.label && el.track) {
        found = el;
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
      // Shown, the adapter's track loads its empty file and replaces its cues with
      // none. Hold the cues until it has.
      if (found?.getAttribute('src') && found.readyState !== 2) {
        this.loading = true;
        const done = () => {
          this.loading = false;
          this.apply([], []);
        };
        found.addEventListener('load', done, { once: true });
        found.addEventListener('error', done, { once: true });
      }
      clearInterval(this.checkTimer);
      this.checkTimer = setInterval(() => this.check(), CHECK_MS);
      this.media.textTracks?.addEventListener?.('change', this.onChange);
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
      this.setOff(false);
      return;
    }
    if (this.otherShowing()) {
      if (this.overlay) this.overlay.style.display = 'none';
      return;
    }
    if (this.media.controls) {
      if (this.overlay) this.overlay.style.display = 'none';
      this.setOff(true);
      return;
    }
    // Nothing on screen and the viewer did not choose that: draw it ourselves.
    this.track.mode = 'hidden';
    if (!this.overlay) this.showOverlay();
    else this.overlay.style.display = '';
  }

  private setOff(off: boolean): void {
    if (off === this.off) return;
    this.off = off;
    this.onOff(off);
  }

  apply(added: Cue[], removed: Cue[]): void {
    this.cues = this.cues
      .filter((c) => !removed.includes(c))
      .concat(added)
      .sort((a, b) => a.start - b.start);
    const shown = held(this.cues);
    this.shown = new Map(this.cues.map((c, i) => [c, shown[i]?.end ?? c.end]));
    const track = this.open();
    if (!track) {
      if (!this.overlay) this.showOverlay();
      return;
    }
    if (this.loading) return;
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
    // A line that lands next to one on screen moves where that one leaves.
    for (const [c, cue] of this.live) {
      const end = this.shown.get(c);
      if (end !== undefined && cue.endTime !== end) cue.endTime = end;
    }
    // Every cue not yet on the track: the new ones, and any held while it loaded.
    for (const c of this.cues) {
      if (this.live.has(c)) continue;
      const end = this.shown.get(c) ?? c.end;
      if (end <= c.start) continue;
      const cue = new VTTCue(c.start, end, c.text);
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
        .filter((c) => c.start <= t && t < (this.shown.get(c) ?? c.end))
        .map((c) => c.text)
        .join('\n');
      if (div.textContent !== text) div.textContent = text;
    };
    this.media.addEventListener('timeupdate', tick);
    this.timer = setInterval(tick, 250);
  }

  /**
   * The notice in the corner: what SubBot is doing and how far along, `progress`
   * 0 to 1 or null when there is nothing to measure. `null` text takes it away.
   */
  status(text: string | null, progress: number | null = null): void {
    if (!this.notice) return;
    if (text === null) this.notice.remove();
    else this.notice.show(text, progress);
  }

  /** The last word on the notice before it fades. */
  finish(text: string): void {
    this.notice?.finish(text);
  }

  /**
   * The complete file is now the adapter's to show. A `<track>` that was found gets
   * its `src` set by the adapter and the browser replaces the cues itself; a track
   * this renderer added is taken away once the adapter's own track is showing.
   */
  handover(word = 'Ready'): void {
    this.handedOver = true;
    clearInterval(this.checkTimer);
    this.media.textTracks?.removeEventListener?.('change', this.onChange);
    this.finish(word);
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
    this.media.textTracks?.removeEventListener?.('change', this.onChange);
    clearInterval(this.timer);
    this.overlay?.remove();
    this.overlay = null;
    // After a handover the notice is finishing on its own and fades when done.
    if (!this.handedOver) this.status(null);
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
