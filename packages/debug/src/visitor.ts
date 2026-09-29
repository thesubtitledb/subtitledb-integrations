/**
 * A random id for this browser, so plays on one site can be counted by viewer.
 *
 * Eight random bytes, written only once a page has turned the debugger on, and
 * replaced after a year. It carries nothing about the viewer. The receiving side
 * never stores it as sent: it is combined with the site's name first, so the same
 * browser on two sites is two unrelated viewers.
 */
import { localStore, VISITOR } from './send.js';

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export function randomHex(bytes: number): string {
  const out = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(out);
  else for (let i = 0; i < bytes; i++) out[i] = Math.floor(Math.random() * 256);
  return Array.from(out, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/** The id, or undefined where storage is blocked, in which case none is sent. */
export function visitorId(
  storage: Storage | null = localStore(),
  now: number = Date.now(),
): string | undefined {
  if (!storage) return undefined;
  try {
    const [id, at] = (storage.getItem(VISITOR) ?? '').split('.');
    if (id && /^[0-9A-F]{16}$/.test(id) && now - Number(at) < YEAR_MS) return id;
    const fresh = randomHex(8);
    storage.setItem(VISITOR, `${fresh}.${now}`);
    return fresh;
  } catch {
    return undefined;
  }
}
