/**
 * The `<script type="module">` and `import` build.
 *
 * The only difference from the IIFE entry is where the chunk base comes from.
 * `import.meta.url` is exact and survives being re-hosted, moved behind a proxy or
 * renamed, none of which `document.currentScript` survives, and in a module
 * `currentScript` is null anyway.
 */
import type { QueryOptions } from '@subtitledb/core';
import { type LoaderAttachOptions, attach as run, preload as warm } from './attach.js';
import { setBasePath } from './base.js';
import { type DebugHandle, type DebugOptions, debug as watchAll } from './debug.js';
import type { DeferredHandle } from './deferred.js';
import {
  type GotSubtitle,
  get as runGet,
  query as runQuery,
  toBlobUrl,
  toTrack,
  type WiredResult,
  type WiredSubtitle,
} from './query.js';

declare const __SDB_VERSION__: string;

const here = import.meta.url;

export function attach(target: unknown, options?: LoaderAttachOptions): DeferredHandle {
  return run(target, options, here);
}

export function debug(key: string, options?: DebugOptions): DebugHandle {
  return watchAll(key, options, here);
}

export function preload(): Promise<unknown> {
  return warm(here);
}

export function query(options: QueryOptions): Promise<WiredResult> {
  return runQuery(options, here);
}

export function get(options: QueryOptions): Promise<GotSubtitle | null> {
  return runGet(options, here);
}

export type { LoadedQuery, QueryOptions, QueryResult, QuerySubtitle } from '@subtitledb/core';
export type {
  DebugHandle,
  DebugOptions,
  DeferredHandle,
  GotSubtitle,
  LoaderAttachOptions,
  WiredResult,
  WiredSubtitle,
};
export { setBasePath, toBlobUrl, toTrack };
export const version = __SDB_VERSION__;
