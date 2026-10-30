/**
 * The toolbar popup. It finds the videos in the tab, guesses what is playing, asks the
 * API through the same core client every other integration uses, and hands the chosen
 * file's cues to the frame that holds the video. Every lookup and download is named
 * `<browser>-extension`.
 *
 * Nothing persists here but settings: what is on screen lives in the tab's content
 * script, so closing the popup changes nothing and reopening it reads it back.
 */
import {
  type Cue,
  corpusLanguage,
  createClient,
  languageName,
  localeLanguages,
  type MediaHint,
  parseVtt,
  type QueryResult,
  type QuerySubtitle,
  query,
  type SubtitleDbError,
  toVtt,
} from '@subtitledb/core';
import { apiFetch, CLIENT, tagRequests } from './api.js';
import { formatOffset, sortCues } from './cues.js';
import {
  type AiStart,
  type AiStatus,
  DEFAULT_STYLE,
  type FrameScan,
  KEY_LANG,
  KEY_STYLE,
  type Loaded,
  type LoadRequest,
  readStyle,
  type Style,
} from './shared.js';

const SITE = 'https://thesubtitledb.org';
const ALL = ['<all_urls>'];
/** Languages offered before a title says which it has. Corpus codes. */
const COMMON = [
  'en',
  'es',
  'ea',
  'fr',
  'de',
  'it',
  'pt',
  'pb',
  'nl',
  'pl',
  'ru',
  'tr',
  'ar',
  'he',
  'el',
  'sv',
  'no',
  'da',
  'fi',
  'cs',
  'hu',
  'ro',
  'bg',
  'hr',
  'sr',
  'uk',
  'zh',
  'zt',
  'ja',
  'ko',
  'vi',
  'th',
  'id',
  'ms',
  'hi',
  'fa',
];
const PAGE = 30;

type Frame = FrameScan & { frameId: number; ai: AiStatus | null };
interface Target {
  frameId: number;
  vid: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {},
  ...kids: (Node | string)[]
) => {
  const n = document.createElement(tag);
  const { cls, ...rest } = props;
  if (cls) n.className = cls;
  Object.assign(n, rest);
  n.append(...kids);
  return n;
};

let tabId = 0;
let frames: Frame[] = [];
let target: Target | null = null;
let loaded: Loaded | null = null;
let detected: MediaHint = {};
let result: QueryResult | null = null;
let shown = PAGE;
let searchRun = 0;
let lang = 'en';
let style: Style = DEFAULT_STYLE;
let quality: AiStart['quality'] = 'balanced';
let aiTimer: ReturnType<typeof setInterval> | undefined;
const client = createClient({
  client: CLIENT,
  downloadClient: CLIENT,
  fetch: apiFetch,
  removeWatermark: true,
});

// ------------------------------------------------------------------ talking to the tab

async function run<A extends unknown[], T>(
  frameIds: number[] | 'all',
  func: (...args: A) => T,
  args: A,
): Promise<{ frameId: number; result?: Awaited<T> }[]> {
  return chrome.scripting.executeScript({
    target: frameIds === 'all' ? { tabId, allFrames: true } : { tabId, frameIds },
    func,
    args,
  });
}

async function scan(): Promise<void> {
  const got = await run('all', () => {
    const t = globalThis.__tsdb;
    return t ? { scan: t.scan(), ai: globalThis.__tsdbAi?.status() ?? null } : null;
  }, []);
  frames = got
    .filter((g) => g.result)
    .map((g) => ({
      ...(g.result?.scan as FrameScan),
      ai: g.result?.ai ?? null,
      frameId: g.frameId,
    }));
}

function allVideos() {
  return frames.flatMap((f) => f.videos.map((v) => ({ ...v, frameId: f.frameId, top: f.top })));
}

// ------------------------------------------------------------------ start

async function main(): Promise<void> {
  void tagRequests();
  const saved = await chrome.storage.sync
    .get([KEY_LANG, KEY_STYLE])
    .catch(() => ({}) as Record<string, unknown>);
  lang =
    typeof saved[KEY_LANG] === 'string'
      ? (saved[KEY_LANG] as string)
      : (localeLanguages()[0] ?? 'en');
  style = readStyle(saved[KEY_STYLE]);
  wireStatic();

  const tab = await targetTab();
  if (!tab?.id || !/^(https?|file):/i.test(tab.url ?? 'https:')) {
    return notice(
      'Not on this page',
      'Browsers do not let extensions add anything to their own pages or to extension stores. Open a page with a video.',
    );
  }
  tabId = tab.id;
  if (!(await chrome.permissions.contains({ origins: ALL }))) {
    return notice(
      'Allow TSDB on websites',
      'TSDB needs to read the pages you open it on to find the video and show subtitles over it. It reads nothing until you open it.',
      'Allow',
      async () => {
        if (await chrome.permissions.request({ origins: ALL })) location.reload();
      },
    );
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
    await scan();
  } catch {
    return notice('Not on this page', 'This page does not allow extensions to run on it.');
  }
  render();
}

/** The tab the popup belongs to. `?tab=<id>` points it elsewhere, for the e2e suite. */
async function targetTab(): Promise<chrome.tabs.Tab | undefined> {
  const id = Number(new URLSearchParams(location.search).get('tab'));
  if (id) return chrome.tabs.get(id);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function notice(title: string, text: string, action?: string, fn?: () => void): void {
  $('boot').hidden = true;
  $('noticeTitle').textContent = title;
  $('noticeText').textContent = text;
  const b = $<HTMLButtonElement>('noticeBtn');
  b.hidden = !action;
  if (action && fn) {
    b.textContent = action;
    b.onclick = fn;
  }
  $('notice').hidden = false;
}

function render(): void {
  $('boot').hidden = true;
  const videos = allVideos();
  if (!videos.length) {
    notice(
      'No video here yet',
      'Start the video, then open TSDB again. Videos smaller than a thumbnail are left out.',
      'Look again',
      async () => {
        $('notice').hidden = true;
        $('boot').hidden = false;
        await scan().catch(() => {});
        render();
      },
    );
    return;
  }
  $('notice').hidden = true;
  const withSub = frames.find((f) => f.loaded);
  const withAi = frames.find((f) => f.ai && f.ai.phase !== 'idle');
  if (withSub?.loaded) {
    target = { frameId: withSub.frameId, vid: withSub.loaded.vid };
    loaded = withSub.loaded;
  } else if (withAi?.videos[0]) {
    target = { frameId: withAi.frameId, vid: withAi.videos[0].vid };
  } else {
    const playing = videos.find((v) => !v.paused) ?? videos[0];
    if (playing) target = { frameId: playing.frameId, vid: playing.vid };
  }
  renderVideos();
  renderNow();
  fillForm(bestHint());
  $('search').hidden = false;
  $('fileBtn').hidden = false;
  renderAi(withAi?.ai ?? { phase: 'idle' });
  if (withAi?.ai) pollAi();
  if (isResolvableForm()) void search();
  else $('q').focus();
}

/** The strongest guess any frame made; the top frame wins a tie. */
function bestHint(): MediaHint & { site?: string } {
  const best = [...frames].sort(
    (a, b) => b.strength - a.strength || Number(b.top) - Number(a.top),
  )[0];
  detected = best?.hint ?? {};
  return { ...detected, ...(best?.site ? { site: best.site } : {}) };
}

// ------------------------------------------------------------------ videos

function renderVideos(): void {
  const videos = allVideos();
  $('videos').hidden = videos.length < 2;
  if (videos.length < 2) return;
  $('vlist').replaceChildren(
    ...videos.map((v, i) => {
      const on = target?.frameId === v.frameId && target.vid === v.vid;
      const b = el(
        'button',
        { cls: 'vrow', type: 'button' },
        el('span', { cls: 'vthumb' }, '▶'),
        el('b', {}, `Video ${i + 1}`),
        el('span', {}, `${v.width} × ${v.height}${v.top ? '' : ', embedded'}`),
        el('small', {}, v.duration ? clock(v.duration) : v.paused ? 'paused' : 'playing'),
      );
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(on));
      b.onmouseenter = () =>
        void run([v.frameId], (id: number) => globalThis.__tsdb?.flash(id), [v.vid]);
      b.onclick = () => {
        target = { frameId: v.frameId, vid: v.vid };
        renderVideos();
        renderAi(currentAi);
      };
      return b;
    }),
  );
}

function targetVideo() {
  return allVideos().find((v) => v.frameId === target?.frameId && v.vid === target?.vid);
}

// ------------------------------------------------------------------ search

function fillForm(h: MediaHint & { site?: string }): void {
  ($('q') as HTMLInputElement).value = h.title ?? '';
  ($('year') as HTMLInputElement).value = h.year ? String(h.year) : '';
  ($('season') as HTMLInputElement).value = h.season !== undefined ? String(h.season) : '';
  ($('episode') as HTMLInputElement).value = h.episode !== undefined ? String(h.episode) : '';
  $('from').textContent = h.imdbId
    ? `Found on the page: ${h.imdbId}`
    : h.site
      ? `From ${h.site}`
      : h.title
        ? 'From the page'
        : '';
  fillLanguages(null);
}

function fillLanguages(counts: Record<string, number> | null): void {
  const sel = $<HTMLSelectElement>('lang');
  const codes = counts
    ? Object.keys(counts).sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))
    : COMMON;
  if (!codes.includes(lang)) codes.unshift(lang);
  sel.replaceChildren(
    ...codes.map((c) =>
      el('option', {
        value: c,
        textContent: counts ? `${languageName(c)} (${counts[c] ?? 0})` : languageName(c),
        selected: c === lang,
      }),
    ),
  );
}

function formHint(): MediaHint {
  const v = (id: string) => ($(id) as HTMLInputElement).value.trim();
  const n = (id: string) => (/^\d+$/.test(v(id)) ? Number(v(id)) : undefined);
  const h: MediaHint = {};
  const title = v('q');
  const ttMatch = /\btt\d{6,9}\b/.exec(title);
  if (ttMatch) h.imdbId = ttMatch[0];
  else if (title) h.title = title;
  // The id the page gave is kept while the title is the one it came with.
  if (!ttMatch && detected.imdbId && title === (detected.title ?? '')) h.imdbId = detected.imdbId;
  if (!ttMatch && detected.seriesImdbId && title === (detected.title ?? '')) {
    h.seriesImdbId = detected.seriesImdbId;
  }
  const year = n('year');
  const season = n('season');
  const episode = n('episode');
  if (year) h.year = year;
  if (season !== undefined) h.season = season;
  if (episode !== undefined) h.episode = episode;
  return h;
}

function isResolvableForm(): boolean {
  const h = formHint();
  return Boolean(h.imdbId || h.seriesImdbId || (h.title && h.title.length > 1));
}

async function search(): Promise<void> {
  const mine = ++searchRun;
  const hint = formHint();
  if (!isResolvableForm()) {
    $('q').focus();
    return;
  }
  $('results').hidden = false;
  $('match').replaceChildren();
  $('list').replaceChildren(...[0, 1, 2].map(() => el('li', {}, el('div', { cls: 'skel' }))));
  setState(null);
  $<HTMLButtonElement>('go').disabled = true;
  try {
    const got = await query({
      hint,
      lang,
      limit: 100,
      clientName: CLIENT,
      downloadClient: CLIENT,
      fetch: apiFetch,
      removeWatermark: true,
      convertTo: 'vtt',
      cues: true,
    });
    if (mine !== searchRun) return;
    result = got;
    shown = PAGE;
    renderResults();
  } catch (err) {
    if (mine !== searchRun) return;
    result = null;
    $('list').replaceChildren();
    const e = err as SubtitleDbError;
    if (e?.code === 'not_found') {
      setState(
        `No title matched “${hint.title ?? hint.imdbId ?? ''}”. Check the spelling, or add the year.`,
      );
    } else {
      setState(
        `TSDB did not answer (${e?.message ?? 'network error'}). Try again in a moment.`,
        true,
      );
    }
    aiLead(true);
  } finally {
    if (mine === searchRun) $<HTMLButtonElement>('go').disabled = false;
  }
}

function setState(text: string | null, bad = false): void {
  const p = $('rstate');
  p.hidden = !text;
  p.textContent = text ?? '';
  p.classList.toggle('bad', bad);
}

function renderResults(): void {
  if (!result) return;
  const t = result.title;
  if (t && !t.partial && t.name) {
    const poster = client.posterUrl(t.poster_path, 'w92');
    const total = Object.values(t.subtitle_languages ?? {}).reduce((a, b) => a + b, 0);
    const ep =
      result.hint.season !== undefined && result.hint.episode !== undefined
        ? `S${result.hint.season} E${result.hint.episode} · `
        : '';
    $('match').replaceChildren(
      ...(poster ? [el('img', { src: poster, alt: '' })] : []),
      el(
        'div',
        {},
        el('b', {}, `${t.name}${t.year ? ` (${t.year})` : ''}`),
        el(
          'small',
          {},
          `${ep}${total.toLocaleString()} files in ${Object.keys(t.subtitle_languages ?? {}).length} languages`,
        ),
      ),
    );
    ($('site') as HTMLAnchorElement).href =
      `${SITE}/${t.media_type === 'tv' ? 'tv' : 'movie'}/${t.imdb}`;
    fillLanguages(t.subtitle_languages ?? null);
  }
  const rows = result.results.slice(0, shown);
  $('list').replaceChildren(...rows.map((r) => el('li', {}, resultRow(r))));
  if (result.results.length > shown) {
    const more = el('button', {
      cls: 'link more',
      type: 'button',
      textContent: `Show ${Math.min(PAGE, result.results.length - shown)} more`,
    });
    more.onclick = () => {
      shown += PAGE;
      renderResults();
    };
    $('list').append(el('li', {}, more));
  }
  if (!result.results.length) {
    setState(
      `No ${languageName(lang)} subtitles for this yet. Pick another language, or make AI subtitles below.`,
    );
    aiLead(true);
  } else {
    setState(null);
    aiLead(false);
  }
}

function resultRow(r: QuerySubtitle): HTMLButtonElement {
  const s = r.subtitle;
  const meta: (Node | string)[] = [el('span', { cls: 'chip' }, s.format.toUpperCase())];
  if (r.hearingImpaired) meta.push(el('span', { cls: 'chip' }, 'HI'));
  meta.push(`${languageName(r.language)} · ${s.cues.toLocaleString()} lines`);
  if (s.duration_s) meta.push(` · ${clock(s.duration_s)}`);
  const b = el(
    'button',
    { cls: 'res', type: 'button', title: r.release || r.label },
    el('span', { cls: 'rn' }, r.release || r.label),
    el('span', { cls: 'rm' }, ...meta),
    el('span', { cls: 'ra' }, loaded?.id === r.id ? 'On screen' : 'Show'),
  );
  if (loaded?.id === r.id) b.setAttribute('aria-current', 'true');
  b.onclick = () => void pick(b, r);
  return b;
}

async function pick(b: HTMLButtonElement, r: QuerySubtitle): Promise<void> {
  if (!target) return;
  b.setAttribute('aria-busy', 'true');
  (b.querySelector('.ra') as HTMLElement).textContent = 'Loading';
  try {
    const got = await r.load();
    const cues = got.cues ?? parseVtt(got.text);
    await show({ cues, label: r.release || r.label, language: r.language, id: r.id });
    // Read by the e2e suite, which needs a line it knows the time of.
    (window as { __tsdbLast?: unknown }).__tsdbLast = { id: r.id, first: sortCues(cues)[0] };
    void chrome.storage.sync.set({ [KEY_LANG]: lang });
  } catch (err) {
    setState(`That file did not load (${(err as Error)?.message ?? 'error'}). Try another.`, true);
  } finally {
    b.removeAttribute('aria-busy');
    renderResults();
  }
}

/** Put cues on the target video, and take any other subtitle off every other frame. */
async function show(req: Omit<LoadRequest, 'vid'>): Promise<void> {
  if (!target) return;
  const t = target;
  const others = frames.map((f) => f.frameId).filter((id) => id !== t.frameId);
  if (others.length) await run(others, () => globalThis.__tsdb?.clear(), []).catch(() => {});
  const [res] = await run([t.frameId], (r: LoadRequest) => globalThis.__tsdb?.load(r) ?? null, [
    { ...req, vid: t.vid, cues: sortCues(req.cues) },
  ]);
  if (!res?.result) throw new Error('the video is gone; open TSDB again');
  loaded = res.result;
  stopAiPoll();
  renderAi({ phase: 'idle' });
  renderNow();
}

// ------------------------------------------------------------------ what is on screen

function renderNow(): void {
  $('now').hidden = !loaded;
  if (!loaded) return;
  $('nowLabel').textContent = loaded.label;
  $('nowMeta').textContent =
    `${languageName(loaded.language)} · ${loaded.count.toLocaleString()} lines${loaded.id ? '' : ' · from your computer'}`;
  $('nowOffset').textContent = formatOffset(loaded.offsetMs);
  $('nowReset').hidden = !loaded.offsetMs;
  const hide = $('nowHide');
  hide.setAttribute('aria-pressed', String(loaded.hidden));
  hide.title = loaded.hidden ? 'Show' : 'Hide';
}

async function onTarget<T>(fn: (arg: T) => Loaded | null | undefined, arg: T): Promise<void> {
  if (!target) return;
  const [res] = await run([target.frameId], fn, [arg]).catch(() => []);
  loaded = (res?.result as Loaded | null | undefined) ?? null;
  renderNow();
  if (result) renderResults();
}

// ------------------------------------------------------------------ AI subtitles

let currentAi: AiStatus = { phase: 'idle' };

function aiLead(on: boolean): void {
  const ai = $('ai');
  ai.classList.toggle('lead', on);
  // When nothing matched, AI subtitles are the next thing to try: right under the
  // message that says so, above any list.
  if (on) $('rstate').after(ai);
  else $('results').after(ai);
}

function renderAi(s: AiStatus): void {
  currentAi = s;
  const v = targetVideo();
  $('ai').hidden = !v;
  if (!v) return;
  const running = s.phase !== 'idle' && s.phase !== 'error';
  const done = s.phase === 'complete' || s.phase === 'identified';
  $('aiOpts').hidden = running && !done;
  $('aiRun').hidden = !(running || s.phase === 'error');
  const why = v.aiBlocked;
  $('aiWhy').hidden = !why;
  $('aiWhy').textContent = why ?? '';
  $<HTMLButtonElement>('aiStart').disabled = Boolean(why);
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=q]')) {
    r.checked = r.value === quality;
  }
  const bar = $('aiBar');
  const meter = bar.parentElement as HTMLElement;
  let pct: number | null = null;
  let text = '';
  switch (s.phase) {
    case 'loading':
      if (s.step === 'model') {
        pct = s.total ? s.loaded / s.total : null;
        text = `Downloading the speech model, ${mb(s.loaded)} of ${mb(s.total)}. Only the first time.`;
      } else text = s.step === 'audio' ? 'Opening the video’s audio' : 'Starting SubBot';
      break;
    case 'listening':
      text = 'Listening for the first lines';
      break;
    case 'live':
      pct = s.duration ? s.covered / s.duration : null;
      text = `Live${s.language ? ` in ${languageName(s.language)}` : ''}. ${clock(s.covered)} of ${clock(s.duration)} written.`;
      break;
    case 'paused':
      text = 'Paused while captions are off in the player';
      break;
    case 'complete':
      pct = 1;
      text = `Done: ${s.lines.toLocaleString()} lines, written on this device.`;
      break;
    case 'identified':
      pct = 1;
      text = `SubBot recognised this video and switched to TSDB file ${s.subId} (${languageName(s.lang)}).`;
      break;
    case 'error':
      text = s.message;
      break;
  }
  meter.hidden = s.phase === 'error';
  meter.classList.toggle('indet', pct === null && running && !done);
  bar.style.width = pct === null ? '' : `${Math.round(Math.min(1, pct) * 100)}%`;
  $('aiText').textContent = text;
  $('aiText').classList.toggle('bad', s.phase === 'error');
  $('aiStop').hidden = !running || done;
}

async function startAi(): Promise<void> {
  if (!target) return;
  const t = target;
  renderAi({ phase: 'loading', step: 'engine', loaded: 0, total: 0, quality });
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [t.frameId] },
      files: ['ai.js'],
    });
    const spoken = $<HTMLSelectElement>('spoken').value;
    const req: AiStart = { vid: t.vid, quality, spoken, languages: [lang] };
    const [res] = await run([t.frameId], (r: AiStart) => globalThis.__tsdbAi?.start(r) ?? null, [
      req,
    ]);
    loaded = null;
    renderNow();
    renderAi(res?.result ?? { phase: 'error', message: 'SubBot did not start.' });
    pollAi();
  } catch (err) {
    renderAi({
      phase: 'error',
      message: `SubBot did not start (${(err as Error)?.message ?? 'error'}).`,
    });
  }
}

function pollAi(): void {
  stopAiPoll();
  aiTimer = setInterval(async () => {
    if (!target) return;
    const [res] = await run(
      [target.frameId],
      () => globalThis.__tsdbAi?.status() ?? null,
      [],
    ).catch(() => []);
    const s = res?.result ?? { phase: 'idle' as const };
    renderAi(s);
    if (
      s.phase === 'idle' ||
      s.phase === 'error' ||
      s.phase === 'complete' ||
      s.phase === 'identified'
    )
      stopAiPoll();
  }, 600);
}

function stopAiPoll(): void {
  clearInterval(aiTimer);
  aiTimer = undefined;
}

// ------------------------------------------------------------------ appearance and files

function renderLook(): void {
  const set = (id: string, v: number, text: string) => {
    ($(id) as HTMLInputElement).value = String(v);
    $(`${id}Out`).textContent = text;
  };
  set('lkSize', style.size, `${style.size.toFixed(1)}%`);
  set('lkBottom', style.bottom, `${style.bottom}%`);
  set('lkBox', style.box, `${Math.round(style.box * 100)}%`);
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=color]')) {
    r.checked = r.value === style.color;
  }
}

function saveStyle(next: Partial<Style>): void {
  style = readStyle({ ...style, ...next });
  renderLook();
  // Every frame's content script listens for this key and redraws.
  void chrome.storage.sync.set({ [KEY_STYLE]: style });
}

async function loadFile(f: File): Promise<void> {
  try {
    const text = await f.text();
    const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1]?.toLowerCase() ?? '';
    const head = text.trimStart().slice(0, 16);
    const format = /^WEBVTT/.test(head)
      ? 'vtt'
      : /^\[Script Info\]/i.test(head)
        ? 'ass'
        : ['srt', 'vtt', 'ass', 'ssa'].includes(ext)
          ? ext
          : 'srt';
    const cues: Cue[] = parseVtt(toVtt(text, format));
    if (!cues.length) throw new Error('no subtitle lines in it');
    await show({ cues, label: f.name, language: corpusLanguage(lang), id: 0 });
  } catch (err) {
    $('results').hidden = false;
    setState(`${f.name} did not load: ${(err as Error)?.message ?? 'not a subtitle'}.`, true);
  }
}

function wireStatic(): void {
  $('search').addEventListener('submit', (e) => {
    e.preventDefault();
    void search();
  });
  $('lang').addEventListener('change', () => {
    lang = $<HTMLSelectElement>('lang').value;
    void chrome.storage.sync.set({ [KEY_LANG]: lang });
    if (isResolvableForm()) void search();
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-shift]')) {
    b.onclick = () =>
      void onTarget(
        (ms: number) => globalThis.__tsdb?.offset(ms),
        (loaded?.offsetMs ?? 0) + Number(b.dataset.shift),
      );
  }
  $('nowReset').onclick = () => void onTarget((ms: number) => globalThis.__tsdb?.offset(ms), 0);
  $('nowHide').onclick = () =>
    void onTarget((h: boolean) => globalThis.__tsdb?.hide(h), !loaded?.hidden);
  $('nowRemove').onclick = async () => {
    if (target) await run([target.frameId], () => globalThis.__tsdb?.clear(), []).catch(() => {});
    loaded = null;
    renderNow();
    if (result) renderResults();
  };

  const look = $('lookBtn');
  look.onclick = () => {
    const open = $('look').hidden;
    $('look').hidden = !open;
    look.setAttribute('aria-expanded', String(open));
    if (open) renderLook();
  };
  const slider = (id: string, key: keyof Style) =>
    $(id).addEventListener('input', () =>
      saveStyle({ [key]: Number(($(id) as HTMLInputElement).value) }),
    );
  slider('lkSize', 'size');
  slider('lkBottom', 'bottom');
  slider('lkBox', 'box');
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=color]')) {
    r.onchange = () => saveStyle({ color: r.value });
  }
  $('lkReset').onclick = () => saveStyle(DEFAULT_STYLE);

  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=q]')) {
    r.onchange = () => {
      quality = r.value as AiStart['quality'];
      renderAi(currentAi);
    };
  }
  const spoken = $<HTMLSelectElement>('spoken');
  spoken.replaceChildren(
    el('option', { value: '', textContent: 'Detect automatically' }),
    ...COMMON.filter((c) => !['ea', 'pb', 'zt'].includes(c)).map((c) =>
      el('option', { value: c, textContent: languageName(c) }),
    ),
  );
  $('aiStart').onclick = () => void startAi();
  $('aiStop').onclick = async () => {
    stopAiPoll();
    if (target) await run([target.frameId], () => globalThis.__tsdbAi?.stop(), []).catch(() => {});
    renderAi({ phase: 'idle' });
  };

  $('file').addEventListener('change', () => {
    const f = ($('file') as HTMLInputElement).files?.[0];
    if (f) void loadFile(f);
  });
}

// ------------------------------------------------------------------ formatting

function clock(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

main().catch((err) => notice('Something went wrong', String((err as Error)?.message ?? err)));
