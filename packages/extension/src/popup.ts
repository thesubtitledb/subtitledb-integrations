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
  type LookupTitle,
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
import { byFit, type Fit, fit } from './fit.js';
import {
  bcp47,
  isRtl,
  LOCALES,
  languageLabel,
  loadMessages,
  localize,
  num,
  pickLocale,
  t,
} from './i18n.js';
import { edgeShadow, FAMILY } from './overlay.js';
import {
  type AiStart,
  type AiStatus,
  type BarText,
  BOX_COLORS,
  DEFAULT_STYLE,
  type FrameScan,
  KEY_LANG,
  KEY_SETTINGS,
  KEY_STYLE,
  type Loaded,
  type LoadRequest,
  PRESETS,
  type Preset,
  presetOf,
  readSettings,
  readStyle,
  type Settings,
  type Style,
  TEXT_COLORS,
} from './shared.js';
import { shorterTitles } from './sites.js';
import { posterUrl, type Season, type Suggestion, seasons, suggest } from './titles.js';

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
const COLOR_NAMES: Record<string, string> = {
  '#ffffff': 'color.white',
  '#ffd60a': 'color.yellow',
  '#64d2ff': 'color.cyan',
  '#30d158': 'color.green',
  '#ff9f0a': 'color.orange',
  '#ff6482': 'color.pink',
  '#000000': 'color.black',
  '#1c1c1e': 'color.graphite',
  '#0b1f4d': 'color.navy',
  '#3b0a2a': 'color.plum',
};

type Frame = FrameScan & { frameId: number; ai: AiStatus | null };
interface Target {
  frameId: number;
  vid: number;
}
/** A title picked from the suggestions: its ids stand while the box still shows its name. */
interface Chosen {
  name: string;
  imdbId?: string;
  seriesImdbId?: string;
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
const input = (id: string) => $<HTMLInputElement>(id);

let tabId = 0;
let frames: Frame[] = [];
let target: Target | null = null;
let loaded: Loaded | null = null;
let detected: MediaHint & { site?: string } = {};
let chosen: Chosen | null = null;
let result: QueryResult | null = null;
let shown = PAGE;
let searchRun = 0;
let lang = 'en';
let style: Style = DEFAULT_STYLE;
let settings: Settings = readSettings(null);
let quality: AiStart['quality'] = 'balanced';
let aiTimer: ReturnType<typeof setInterval> | undefined;
let tree: { imdb: string; seasons: Season[] } | null = null;
const posters = new Map<string, string | null>();

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
    const tsdb = globalThis.__tsdb;
    return tsdb ? { scan: tsdb.scan(), ai: globalThis.__tsdbAi?.status() ?? null } : null;
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
    .get([KEY_LANG, KEY_STYLE, KEY_SETTINGS])
    .catch(() => ({}) as Record<string, unknown>);
  settings = readSettings(saved[KEY_SETTINGS]);
  applyTheme();
  await loadMessages(settings.ui || pickLocale(chrome.i18n.getUILanguage()));
  localize();
  lang =
    typeof saved[KEY_LANG] === 'string'
      ? (saved[KEY_LANG] as string)
      : (localeLanguages()[0] ?? 'en');
  style = readStyle(saved[KEY_STYLE]);
  wireStatic();

  const tab = await targetTab();
  if (!tab?.id || !/^(https?|file):/i.test(tab.url ?? 'https:')) {
    return notice(t('notice.notHere.title'), t('notice.notHere.text'));
  }
  tabId = tab.id;
  if (!(await chrome.permissions.contains({ origins: ALL }))) {
    return notice(
      t('notice.allow.title'),
      t('notice.allow.text'),
      t('notice.allow.button'),
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
    return notice(t('notice.notHere.title'), t('notice.blocked.text'));
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
    notice(t('notice.none.title'), t('notice.none.text'), t('notice.none.button'), async () => {
      $('notice').hidden = true;
      $('boot').hidden = false;
      await scan().catch(() => {});
      render();
    });
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
  detected = { ...(best?.hint ?? {}), ...(best?.site ? { site: best.site } : {}) };
  return detected;
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
        el('span', { cls: 'vthumb' }),
        el('b', {}, t('videos.item', i + 1)),
        el('span', {}, `${v.width} × ${v.height}${v.top ? '' : `, ${t('videos.embedded')}`}`),
        el(
          'small',
          {},
          v.duration ? clock(v.duration) : v.paused ? t('videos.paused') : t('videos.playing'),
        ),
      );
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(on));
      b.onmouseenter = () =>
        void run([v.frameId], (id: number) => globalThis.__tsdb?.flash(id), [v.vid]);
      b.onclick = () => {
        target = { frameId: v.frameId, vid: v.vid };
        renderVideos();
        renderAi(currentAi);
        if (result) renderResults();
      };
      return b;
    }),
  );
}

function targetVideo() {
  return allVideos().find((v) => v.frameId === target?.frameId && v.vid === target?.vid);
}

// ------------------------------------------------------------------ search form

function fillForm(h: MediaHint & { site?: string }): void {
  input('q').value = h.title ?? '';
  input('year').value = h.year ? String(h.year) : '';
  input('season').value = h.season !== undefined ? String(h.season) : '';
  input('episode').value = h.episode !== undefined ? String(h.episode) : '';
  $('from').textContent = h.imdbId
    ? t('from.id', h.imdbId)
    : h.site
      ? t('from.site', h.site)
      : h.title
        ? t('from.page')
        : '';
  fillLanguages(null);
}

function fillLanguages(counts: Record<string, number> | null): void {
  const sel = $<HTMLSelectElement>('lang');
  const codes = counts
    ? Object.keys(counts).sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))
    : [...COMMON];
  if (!codes.includes(lang)) codes.unshift(lang);
  sel.replaceChildren(
    ...codes.map((c) =>
      el('option', {
        value: c,
        textContent: counts ? `${languageLabel(c)} (${num(counts[c] ?? 0)})` : languageLabel(c),
        selected: c === lang,
      }),
    ),
  );
}

function formHint(): MediaHint {
  const v = (id: string) => input(id).value.trim();
  const n = (id: string) => (/^\d+$/.test(v(id)) ? Number(v(id)) : undefined);
  const h: MediaHint = {};
  const title = v('q');
  const ttMatch = /\btt\d{6,9}\b/.exec(title);
  if (ttMatch) h.imdbId = ttMatch[0];
  else if (title) h.title = title;
  if (!ttMatch && chosen && title === chosen.name) {
    if (chosen.imdbId) h.imdbId = chosen.imdbId;
    if (chosen.seriesImdbId) h.seriesImdbId = chosen.seriesImdbId;
  } else if (!ttMatch && title === (detected.title ?? '')) {
    // The id the page gave is kept while the title is the one it came with.
    if (detected.imdbId) h.imdbId = detected.imdbId;
    if (detected.seriesImdbId) h.seriesImdbId = detected.seriesImdbId;
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

/** Search mode shows the field; title mode shows the title's hero in its place. */
function titleMode(on: boolean): void {
  $('search').hidden = on;
  $('hero').hidden = !on;
  if (!on) {
    $('eps').hidden = true;
    closeSuggest();
  }
}

// ------------------------------------------------------------------ suggestions

let suggestTimer: ReturnType<typeof setTimeout> | undefined;
let suggestAbort: AbortController | null = null;
let suggestions: Suggestion[] = [];
let active = -1;

function onType(): void {
  const q = input('q').value.trim();
  const go = $<HTMLButtonElement>('go');
  if (go.disabled) {
    // A search still running is for the old text: drop it.
    searchRun++;
    go.disabled = false;
    $('list').replaceChildren();
  }
  if (q !== (detected.title ?? '') && q !== chosen?.name) {
    // A new title: what the page said about the old one no longer applies.
    chosen = null;
    input('year').value = '';
    input('season').value = '';
    input('episode').value = '';
    $('from').textContent = '';
  }
  clearTimeout(suggestTimer);
  if (q.length < 2 || /^tt\d+$/.test(q)) {
    closeSuggest();
    return;
  }
  suggestTimer = setTimeout(() => void loadSuggest(q), 160);
}

async function loadSuggest(q: string): Promise<void> {
  suggestAbort?.abort();
  const ac = new AbortController();
  suggestAbort = ac;
  try {
    const got = await suggest(q, ac.signal);
    if (ac.signal.aborted || input('q').value.trim() !== q) return;
    suggestions = got;
    active = -1;
    renderSuggest();
  } catch {
    // Suggestions are a convenience: Search still works without them.
  }
}

function renderSuggest(): void {
  const list = $('suggest');
  const box = input('q');
  if (!suggestions.length) {
    closeSuggest();
    return;
  }
  list.replaceChildren(
    ...suggestions.map((s, i) => {
      const poster = el('span', { cls: 'poster' });
      const url = posterUrl(s.poster);
      if (url) poster.style.backgroundImage = `url("${url}")`;
      const kind = s.series
        ? `${s.series.name} · ${t('hero.episode', s.season ?? 0, s.episode ?? 0)}`
        : s.tv
          ? t('sugg.series')
          : t('sugg.film');
      const li = el(
        'li',
        { id: `sg${i}` },
        poster,
        el(
          'div',
          {},
          el('b', {}, s.name),
          el(
            'small',
            {},
            [s.year, kind, t('sugg.files', num(s.files))].filter(Boolean).join(' · '),
          ),
        ),
      );
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      li.onmousedown = (e) => e.preventDefault();
      li.onclick = () => choose(s);
      return li;
    }),
  );
  list.hidden = false;
  box.setAttribute('aria-expanded', 'true');
  if (active >= 0) box.setAttribute('aria-activedescendant', `sg${active}`);
  else box.removeAttribute('aria-activedescendant');
}

function closeSuggest(): void {
  clearTimeout(suggestTimer);
  suggestAbort?.abort();
  suggestions = [];
  active = -1;
  $('suggest').hidden = true;
  input('q').setAttribute('aria-expanded', 'false');
  input('q').removeAttribute('aria-activedescendant');
}

function choose(s: Suggestion): void {
  closeSuggest();
  input('year').value = s.year ? String(s.year) : '';
  if (s.series) {
    chosen = { name: s.series.name, seriesImdbId: s.series.imdb };
    input('q').value = s.series.name;
    input('year').value = '';
    input('season').value = String(s.season ?? '');
    input('episode').value = String(s.episode ?? '');
  } else if (s.tv) {
    chosen = { name: s.name, seriesImdbId: s.imdb };
    input('q').value = s.name;
    // A show picked by name: its episodes come next, the page's numbers if it named them.
    const same = detected.title && detected.title === s.name;
    input('season').value = same && detected.season !== undefined ? String(detected.season) : '';
    input('episode').value = same && detected.episode !== undefined ? String(detected.episode) : '';
  } else {
    chosen = { name: s.name, imdbId: s.imdb };
    input('q').value = s.name;
    input('season').value = '';
    input('episode').value = '';
  }
  posters.set(s.series?.imdb ?? s.imdb, s.series ? (posters.get(s.series.imdb) ?? null) : s.poster);
  $('from').textContent = '';
  void search();
}

function suggestKeys(e: KeyboardEvent): void {
  if ($('suggest').hidden || !suggestions.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const d = e.key === 'ArrowDown' ? 1 : -1;
    active = (active + d + suggestions.length) % suggestions.length;
    renderSuggest();
  } else if (e.key === 'Enter' && active >= 0) {
    e.preventDefault();
    const s = suggestions[active];
    if (s) choose(s);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSuggest();
  }
}

// ------------------------------------------------------------------ search

async function search(): Promise<void> {
  const mine = ++searchRun;
  closeSuggest();
  const hint = formHint();
  if (!isResolvableForm()) {
    $('q').focus();
    return;
  }
  // A show with no episode picked yet: find it, then ask for the episode.
  const pickFirst = Boolean(hint.seriesImdbId) && hint.episode === undefined;
  $('results').hidden = false;
  $('list').replaceChildren(...[0, 1, 2].map(() => el('li', {}, el('div', { cls: 'skel' }))));
  setState(null);
  $<HTMLButtonElement>('go').disabled = true;
  const lookup = (h: MediaHint) =>
    query({
      hint: h,
      lang,
      limit: 100,
      clientName: CLIENT,
      downloadClient: CLIENT,
      fetch: apiFetch,
      removeWatermark: true,
      convertTo: 'vtt',
      cues: true,
    });
  try {
    let got: QueryResult;
    try {
      got = await lookup(hint);
    } catch (err) {
      // A video's title often carries more than the film's: try it shorter.
      const shorter =
        hint.title && !hint.imdbId && !hint.seriesImdbId ? shorterTitles(hint.title) : [];
      if ((err as SubtitleDbError)?.code !== 'not_found' || !shorter.length) throw err;
      got = await firstFound(
        shorter.map((title) => () => lookup({ ...hint, title })),
        err,
      );
      if (mine !== searchRun) return;
      const used = got.hint.title;
      if (used) input('q').value = used;
    }
    if (mine !== searchRun) return;
    result = got;
    shown = PAGE;
    renderTitle();
    if (pickFirst) {
      $('list').replaceChildren();
      setState(t('eps.pick'));
    } else renderResults();
  } catch (err) {
    if (mine !== searchRun) return;
    result = null;
    titleMode(false);
    $('list').replaceChildren();
    const e = err as SubtitleDbError;
    if (e?.code === 'not_found') {
      setState(t('res.noTitle', hint.title ?? hint.imdbId ?? hint.seriesImdbId ?? ''));
    } else {
      setState(t('res.down', e?.message ?? 'network error'), true);
    }
    aiLead(true);
  } finally {
    if (mine === searchRun) $<HTMLButtonElement>('go').disabled = false;
  }
}

/** The first lookup that finds a title, in order; `notFound` if none does. */
async function firstFound(tries: (() => Promise<QueryResult>)[], notFound: unknown) {
  for (const tr of tries) {
    try {
      return await tr();
    } catch (err) {
      if ((err as SubtitleDbError)?.code !== 'not_found') throw err;
    }
  }
  throw notFound;
}

function setState(text: string | null, bad = false): void {
  const p = $('rstate');
  p.hidden = !text;
  p.textContent = text ?? '';
  p.classList.toggle('bad', bad);
}

// ------------------------------------------------------------------ the title

function isShow(ti: LookupTitle | null): boolean {
  return (
    ti?.media_type === 'tv' ||
    formHint().seriesImdbId !== undefined ||
    formHint().season !== undefined
  );
}

function renderTitle(): void {
  const ti = result?.title ?? null;
  if (!ti || ti.partial || !ti.name) {
    titleMode(false);
    return;
  }
  titleMode(true);
  const h = result?.hint ?? {};
  const ep =
    h.season !== undefined && h.episode !== undefined
      ? `${t('hero.episode', h.season, h.episode)} · `
      : '';
  const langs = Object.keys(ti.subtitle_languages ?? {}).length;
  const total = Object.values(ti.subtitle_languages ?? {}).reduce((a, b) => a + b, 0);
  const b = $('match').querySelector('b') as HTMLElement;
  const small = $('match').querySelector('small') as HTMLElement;
  b.textContent = `${ti.name}${ti.year ? ` (${ti.year})` : ''}`;
  small.textContent = `${ep}${t('hero.files', num(total), num(langs))}`;
  ($('site') as HTMLAnchorElement).href =
    `${SITE}/${ti.media_type === 'tv' ? 'tv' : 'movie'}/${ti.imdb}`;
  void paintPoster(ti);
  fillLanguages(ti.subtitle_languages ?? null);
  if (isShow(ti)) void renderEps(ti.imdb);
  else $('eps').hidden = true;
}

/** The poster: from the lookup when it has one, else from the suggestions for its name. */
async function paintPoster(ti: LookupTitle): Promise<void> {
  const set = (path: string | null) => {
    const small = posterUrl(path, 'w185');
    $('heroPoster').style.backgroundImage = small ? `url("${small}")` : '';
    $('heroBg').style.setProperty('--img', small ? `url("${small}")` : 'none');
  };
  if (ti.poster_path !== undefined) posters.set(ti.imdb, ti.poster_path);
  if (posters.has(ti.imdb) && posters.get(ti.imdb)) return set(posters.get(ti.imdb) ?? null);
  set(null);
  try {
    const got = await suggest(ti.name);
    const hit = got.find((s) => s.imdb === ti.imdb || s.series?.imdb === ti.imdb);
    const path = hit?.series ? null : (hit?.poster ?? null);
    posters.set(ti.imdb, path);
    if (result?.title?.imdb === ti.imdb) set(path);
  } catch {
    // No poster is fine.
  }
}

async function renderEps(seriesImdb: string): Promise<void> {
  if (tree?.imdb !== seriesImdb) {
    try {
      tree = { imdb: seriesImdb, seasons: await seasons(seriesImdb) };
    } catch {
      $('eps').hidden = true;
      return;
    }
  }
  if (result?.title?.imdb !== seriesImdb) return;
  const all = tree.seasons;
  if (!all.length) {
    $('eps').hidden = true;
    return;
  }
  $('eps').hidden = false;
  const sNow = input('season').value;
  const eNow = input('episode').value;
  $('seasonChips').replaceChildren(
    ...all.map((s) => {
      const b = chip(t('eps.seasonShort', s.season), String(s.season) === sNow);
      b.title = t('eps.season', s.season);
      b.onclick = () => {
        if (input('season').value === String(s.season)) return;
        input('season').value = String(s.season);
        input('episode').value = '';
        void renderEps(seriesImdb);
        $('list').replaceChildren();
        setState(t('eps.pick'));
      };
      return b;
    }),
  );
  const season = all.find((s) => String(s.season) === sNow);
  $('episodeChips').hidden = !season;
  if (!season) return;
  let current: HTMLButtonElement | null = null;
  $('episodeChips').replaceChildren(
    ...season.episodes.map((e) => {
      const on = String(e.episode) === eNow;
      const b = chip(on && e.name ? `${num(e.episode)} · ${e.name}` : num(e.episode), on);
      b.title = e.name ? `${t('eps.episode', e.episode)}: ${e.name}` : t('eps.episode', e.episode);
      b.onclick = () => {
        input('episode').value = String(e.episode);
        void search();
      };
      if (on) current = b;
      return b;
    }),
  );
  (current as HTMLButtonElement | null)?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function chip(label: string, on: boolean): HTMLButtonElement {
  const b = el('button', { type: 'button' }, label);
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-checked', String(on));
  return b;
}

// ------------------------------------------------------------------ results

function fitOf(r: QuerySubtitle): Fit | null {
  const v = targetVideo();
  return fit(
    { durationS: r.subtitle.duration_s, release: r.release },
    { duration: v?.duration ?? 0, file: v?.file, site: detected.site },
  );
}

function renderResults(): void {
  if (!result) return;
  const rows = byFit(result.results, fitOf);
  // When no file comes close (a trailer, a different cut), a row of zeros says nothing.
  const scored = rows.some((r) => (fitOf(r)?.score ?? 0) >= 20);
  $('rcount').textContent = t('sugg.files', num(rows.length));
  $('list').replaceChildren(...rows.slice(0, shown).map((r) => el('li', {}, resultRow(r, scored))));
  if (rows.length > shown) {
    const more = el('button', {
      cls: 'more',
      type: 'button',
      textContent: t('res.more', num(Math.min(PAGE, rows.length - shown))),
    });
    more.onclick = () => {
      shown += PAGE;
      renderResults();
    };
    $('list').append(el('li', {}, more));
  }
  if (!rows.length) {
    setState(t('res.noneLang', languageLabel(lang)));
    aiLead(true);
  } else {
    setState(null);
    aiLead(false);
  }
}

function fitText(f: Fit): string {
  switch (f.why) {
    case 'same':
      return t('fit.same');
    case 'longer':
      return f.minutes ? t('fit.longer', num(f.minutes)) : t('fit.nearly');
    case 'shorter':
      return f.minutes ? t('fit.shorter', num(f.minutes)) : t('fit.nearly');
    case 'release':
      return t('fit.release');
    default:
      return '';
  }
}

function resultRow(r: QuerySubtitle, scored: boolean): HTMLButtonElement {
  const s = r.subtitle;
  const f = scored ? fitOf(r) : null;
  const meta: (Node | string)[] = [el('span', { cls: 'chip' }, s.format.toUpperCase())];
  if (r.hearingImpaired) meta.push(el('span', { cls: 'chip' }, t('res.hi')));
  const bits = [t('res.lines', num(s.cues))];
  if (s.duration_s) bits.push(clock(s.duration_s));
  meta.push(bits.join(' · '));
  const kids: Node[] = [];
  if (f) {
    const ring = el(
      'span',
      { cls: `ring ${f.score >= 80 ? 'good' : f.score >= 55 ? 'fair' : 'poor'}` },
      String(f.score),
    );
    ring.style.setProperty('--p', String(f.score));
    const why = fitText(f);
    ring.title = why ? `${t('fit.score', f.score)}. ${why}` : t('fit.score', f.score);
    ring.setAttribute('aria-label', ring.title);
    kids.push(ring);
  }
  kids.push(
    el(
      'span',
      { cls: 'res-t' },
      el('span', { cls: 'rn' }, r.release || r.label),
      el('span', { cls: 'rm' }, ...meta),
    ),
    el('span', { cls: 'ra' }, loaded?.id === r.id ? t('res.on') : t('res.show')),
  );
  const b = el('button', { cls: 'res', type: 'button', title: r.release || r.label }, ...kids);
  if (loaded?.id === r.id) b.setAttribute('aria-current', 'true');
  b.onclick = () => void pick(b, r);
  return b;
}

async function pick(b: HTMLButtonElement, r: QuerySubtitle): Promise<void> {
  if (!target) return;
  b.setAttribute('aria-busy', 'true');
  (b.querySelector('.ra') as HTMLElement).textContent = t('res.loading');
  try {
    const got = await r.load();
    const cues = got.cues ?? parseVtt(got.text);
    await show({ cues, label: r.release || r.label, language: r.language, id: r.id });
    // Read by the e2e suite, which needs a line it knows the time of.
    (window as { __tsdbLast?: unknown }).__tsdbLast = { id: r.id, first: sortCues(cues)[0] };
    void chrome.storage.sync.set({ [KEY_LANG]: lang });
  } catch (err) {
    setState(t('res.loadFail', (err as Error)?.message ?? 'error'), true);
  } finally {
    b.removeAttribute('aria-busy');
    renderResults();
  }
}

function barText(): BarText {
  return {
    earlier: t('bar.earlier'),
    later: t('bar.later'),
    smaller: t('bar.smaller'),
    bigger: t('bar.bigger'),
    hide: t('bar.hide'),
    show: t('bar.show'),
    remove: t('bar.remove'),
    label: t('bar.label'),
  };
}

/** Put cues on the target video, and take any other subtitle off every other frame. */
async function show(req: Omit<LoadRequest, 'vid' | 'bar' | 'rtl'>): Promise<void> {
  if (!target) return;
  const tg = target;
  const others = frames.map((f) => f.frameId).filter((id) => id !== tg.frameId);
  if (others.length) await run(others, () => globalThis.__tsdb?.clear(), []).catch(() => {});
  const [res] = await run([tg.frameId], (r: LoadRequest) => globalThis.__tsdb?.load(r) ?? null, [
    { ...req, vid: tg.vid, cues: sortCues(req.cues), bar: barText(), rtl: isRtl() },
  ]);
  if (!res?.result) throw new Error(t('res.gone'));
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
  $('nowMeta').textContent = [
    t('now.meta', languageLabel(loaded.language), num(loaded.count)),
    ...(loaded.id ? [] : [t('now.fromFile')]),
  ].join(' · ');
  $('nowOffset').textContent = formatOffset(loaded.offsetMs);
  $('nowReset').hidden = !loaded.offsetMs;
  const hide = $('nowHide');
  hide.setAttribute('aria-pressed', String(loaded.hidden));
  const label = loaded.hidden ? t('now.show') : t('now.hide');
  hide.title = label;
  hide.setAttribute('aria-label', label);
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

/** ai-check and ai.ts name their reasons by message key; anything else is shown as is. */
function said(message: string): string {
  return /^ai\.[a-zA-Z.]+$/.test(message) ? t(message) : message;
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
  const why = v.aiBlocked ? said(v.aiBlocked) : null;
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
        text = t('ai.model', mb(s.loaded), mb(s.total));
      } else text = s.step === 'audio' ? t('ai.audio') : t('ai.engine');
      break;
    case 'listening':
      text = t('ai.listening');
      break;
    case 'live':
      pct = s.duration ? s.covered / s.duration : null;
      text = s.language
        ? t('ai.liveIn', languageLabel(s.language), clock(s.covered), clock(s.duration))
        : t('ai.live', clock(s.covered), clock(s.duration));
      break;
    case 'paused':
      text = t('ai.paused');
      break;
    case 'complete':
      pct = 1;
      text = t('ai.done', num(s.lines));
      break;
    case 'identified':
      pct = 1;
      text = t('ai.identified', s.subId, languageLabel(s.lang));
      break;
    case 'error':
      text = said(s.message);
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
  const tg = target;
  renderAi({ phase: 'loading', step: 'engine', loaded: 0, total: 0, quality });
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [tg.frameId] },
      files: ['ai.js'],
    });
    const spoken = $<HTMLSelectElement>('spoken').value;
    const req: AiStart = { vid: tg.vid, quality, spoken, languages: [lang] };
    const [res] = await run([tg.frameId], (r: AiStart) => globalThis.__tsdbAi?.start(r) ?? null, [
      req,
    ]);
    loaded = null;
    renderNow();
    renderAi(res?.result ?? { phase: 'error', message: 'ai.noStart' });
    pollAi();
  } catch (err) {
    renderAi({
      phase: 'error',
      message: t('ai.noStartWhy', (err as Error)?.message ?? 'error'),
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

// ------------------------------------------------------------------ pages

type PageName = 'look' | 'settings';
let page: PageName | null = null;

function openPage(p: PageName | null): void {
  page = p;
  document.body.classList.toggle('paged', Boolean(p));
  $('main').hidden = Boolean(p);
  $('foot').hidden = Boolean(p);
  $('look').hidden = p !== 'look';
  $('settings').hidden = p !== 'settings';
  $('backBtn').hidden = !p;
  $('navTitle').textContent =
    p === 'look' ? t('style.title') : p === 'settings' ? t('settings.title') : t('title');
  $('lookBtn').setAttribute('aria-expanded', String(p === 'look'));
  $('setBtn').setAttribute('aria-expanded', String(p === 'settings'));
  if (p === 'look') renderLook();
  if (p === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ style

function renderLook(): void {
  const set = (id: string, v: number, text: string) => {
    const r = input(id);
    r.value = String(v);
    const lo = Number(r.min);
    const hi = Number(r.max);
    r.style.setProperty('--fill-pct', `${((v - lo) / (hi - lo)) * 100}%`);
    $(`${id}Out`).textContent = text;
  };
  set('lkSize', style.size, `${style.size.toFixed(1)}%`);
  set('lkBottom', style.bottom, `${style.bottom}%`);
  set('lkBox', style.box, `${Math.round(style.box * 100)}%`);
  $<HTMLSelectElement>('lkFont').value = style.font;
  $<HTMLSelectElement>('lkEdge').value = style.edge;
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=weight]')) {
    r.checked = Number(r.value) === style.weight;
  }
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=color]')) {
    r.checked = r.value === style.color;
  }
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=boxColor]')) {
    r.checked = r.value === style.boxColor;
  }
  const p = presetOf(style);
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
    b.setAttribute('aria-pressed', String(b.dataset.preset === p));
  }
  const s = $('lkSample');
  s.style.color = style.color;
  s.style.fontFamily = FAMILY[style.font];
  s.style.fontWeight = String(style.weight);
  s.style.textShadow = edgeShadow(style.edge);
  s.style.fontSize = `${Math.max(12, ((92 * style.size) / 100) * 2.2).toFixed(1)}px`;
  const n = Number.parseInt(style.boxColor.slice(1), 16);
  s.style.background = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${style.box})`;
}

function saveStyle(next: Partial<Style>): void {
  style = readStyle({ ...style, ...next });
  renderLook();
  // Every frame's content script listens for this key and redraws.
  void chrome.storage.sync.set({ [KEY_STYLE]: style });
}

function swatches(id: string, name: string, colors: readonly string[]): void {
  const box = el('div');
  for (const c of colors) {
    const r = el('input', { type: 'radio', name, value: c });
    r.setAttribute('aria-label', t(COLOR_NAMES[c] ?? c));
    r.onchange = () => saveStyle({ [name]: c });
    const l = el('label', { title: t(COLOR_NAMES[c] ?? c) }, r);
    l.style.setProperty('--sw', c);
    box.append(l);
  }
  $(id).append(box);
}

// ------------------------------------------------------------------ settings

function applyTheme(): void {
  document.documentElement.dataset.theme = settings.theme;
}

function saveSettings(next: Partial<Settings>): void {
  settings = readSettings({ ...settings, ...next });
  void chrome.storage.sync.set({ [KEY_SETTINGS]: settings });
}

function renderSettings(): void {
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=theme]')) {
    r.checked = r.value === settings.theme;
  }
  $<HTMLSelectElement>('uiLang').value = settings.ui;
  $<HTMLSelectElement>('hiMode').value = settings.hi;
  input('barOn').checked = settings.bar;
}

/** Each interface language named in itself, as a language menu does. */
function endonym(l: string): string {
  try {
    const n = new Intl.DisplayNames([bcp47(l)], { type: 'language' }).of(bcp47(l)) ?? l;
    return n.charAt(0).toLocaleUpperCase(bcp47(l)) + n.slice(1);
  } catch {
    return l;
  }
}

// ------------------------------------------------------------------ files

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
    if (!cues.length) throw new Error(t('file.noLines'));
    await show({ cues, label: f.name, language: corpusLanguage(lang), id: 0 });
  } catch (err) {
    $('results').hidden = false;
    setState(t('file.fail', f.name, (err as Error)?.message ?? t('file.notSub')), true);
  }
}

// ------------------------------------------------------------------ wiring

function wireStatic(): void {
  $('search').addEventListener('submit', (e) => {
    e.preventDefault();
    void search();
  });
  input('q').addEventListener('input', onType);
  input('q').addEventListener('keydown', suggestKeys);
  input('q').addEventListener('blur', () => setTimeout(closeSuggest, 120));
  $('heroBack').onclick = () => {
    titleMode(false);
    $('q').focus();
    input('q').select();
  };
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

  // Pages.
  $('lookBtn').onclick = () => openPage(page === 'look' ? null : 'look');
  $('setBtn').onclick = () => openPage(page === 'settings' ? null : 'settings');
  $('backBtn').onclick = () => openPage(null);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && page) {
      e.preventDefault();
      openPage(null);
    }
  });

  // Style.
  const slider = (id: string, key: 'size' | 'bottom' | 'box') =>
    input(id).addEventListener('input', () => saveStyle({ [key]: Number(input(id).value) }));
  slider('lkSize', 'size');
  slider('lkBottom', 'bottom');
  slider('lkBox', 'box');
  swatches('lkColors', 'color', TEXT_COLORS);
  swatches('lkBoxColors', 'boxColor', BOX_COLORS);
  $('lkFont').addEventListener('change', () =>
    saveStyle({ font: $<HTMLSelectElement>('lkFont').value as Style['font'] }),
  );
  $('lkEdge').addEventListener('change', () =>
    saveStyle({ edge: $<HTMLSelectElement>('lkEdge').value as Style['edge'] }),
  );
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=weight]')) {
    r.onchange = () => saveStyle({ weight: Number(r.value) as Style['weight'] });
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
    b.onclick = () => saveStyle(PRESETS[b.dataset.preset as Preset]);
  }
  $('lkReset').onclick = () => saveStyle(DEFAULT_STYLE);

  // Settings.
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=theme]')) {
    r.onchange = () => {
      saveSettings({ theme: r.value as Settings['theme'] });
      applyTheme();
    };
  }
  const ui = $<HTMLSelectElement>('uiLang');
  ui.replaceChildren(
    el('option', { value: '', textContent: t('settings.uiAuto') }),
    ...LOCALES.map((l) => el('option', { value: l, textContent: endonym(l) })),
  );
  ui.onchange = async () => {
    saveSettings({ ui: ui.value });
    await chrome.storage.sync.set({ [KEY_SETTINGS]: settings });
    location.reload();
  };
  $('hiMode').onchange = () =>
    saveSettings({ hi: $<HTMLSelectElement>('hiMode').value === 'remove' ? 'remove' : 'show' });
  input('barOn').onchange = () => saveSettings({ bar: input('barOn').checked });

  // AI.
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=q]')) {
    r.onchange = () => {
      quality = r.value as AiStart['quality'];
      renderAi(currentAi);
    };
  }
  const spoken = $<HTMLSelectElement>('spoken');
  spoken.replaceChildren(
    el('option', { value: '', textContent: t('ai.detect') }),
    ...COMMON.filter((c) => !['ea', 'pb', 'zt'].includes(c)).map((c) =>
      el('option', { value: c, textContent: languageLabel(c) }),
    ),
  );
  $('aiStart').onclick = () => void startAi();
  $('aiStop').onclick = async () => {
    stopAiPoll();
    if (target) await run([target.frameId], () => globalThis.__tsdbAi?.stop(), []).catch(() => {});
    renderAi({ phase: 'idle' });
  };

  $('file').addEventListener('change', () => {
    const f = input('file').files?.[0];
    if (f) void loadFile(f);
  });
}

// ------------------------------------------------------------------ formatting

function clock(s: number): string {
  const total = Math.max(0, Math.round(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function mb(bytes: number): string {
  return `${num(Math.round(bytes / 1_000_000))} MB`;
}

main().catch((err) => notice(t('notice.error.title'), String((err as Error)?.message ?? err)));
