/**
 * The `<script type="module">` and `import` build.
 *
 * The only difference from the IIFE entry is where the chunk base comes from.
 * `import.meta.url` is exact and survives being re-hosted, moved behind a proxy or
 * renamed, none of which `document.currentScript` survives, and in a module
 * `currentScript` is null anyway.
 */
import type { AttachOptions } from '@subtitledb/players';
import { attach as run, preload as warm } from './attach.js';
import { setBasePath } from './base.js';
import type { DeferredHandle } from './deferred.js';

declare const __SDB_VERSION__: string;

const here = import.meta.url;

export function attach(target: unknown, options?: AttachOptions): DeferredHandle {
  return run(target, options, here);
}

export function preload(): Promise<unknown> {
  return warm(here);
}

export type { DeferredHandle };
export { setBasePath };
export const version = __SDB_VERSION__;
