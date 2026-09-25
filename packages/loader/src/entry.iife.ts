/**
 * The `<script src>` build. Defines `window.SubtitleDB` and nothing else.
 *
 * No `import.meta` anywhere in this file's graph: an IIFE has none, and esbuild
 * rewrites it to something that is not a URL rather than failing, which would send
 * every chunk request to the wrong place with no error. The base comes from
 * `document.currentScript` instead, which base.ts reads on import.
 */
import { attach, preload } from './attach.js';
import { setBasePath } from './base.js';

declare const __SDB_VERSION__: string;

export { attach, preload, setBasePath };
export const version = __SDB_VERSION__;
