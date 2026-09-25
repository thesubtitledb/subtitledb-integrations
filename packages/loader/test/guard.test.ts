/**
 * One copy of the integration per page.
 *
 * The invariant being defended is not "tidy globals". `PUBLISHED` in bindings.ts and
 * `HANDLES` in registry.ts are module-level WeakMaps, so two copies of this code do
 * not share the map that makes one player mean one handle. A CMS where the theme and
 * a plugin both paste the snippet is the ordinary case, and the symptom there is a
 * doubled captions menu and doubled API traffic that neither party can explain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claim, mismatch } from '../src/guard.js';

function clear() {
  Reflect.deleteProperty(globalThis, '__subtitledb__');
}

const stub = (version: string) => ({
  version,
  // biome-ignore lint/suspicious/noExplicitAny: the return value is never read here
  attach: vi.fn(() => ({ version }) as any),
});

describe('claim', () => {
  beforeEach(clear);

  it('the first copy gets the page', () => {
    expect(claim(stub('1.0.0'))).toBeUndefined();
  });

  it('the second is told who has it', () => {
    const first = stub('1.0.0');
    claim(first);
    const held = claim(stub('1.0.0'));
    expect(held?.version).toBe('1.0.0');
    expect(held?.attach).toBe(first.attach);
  });

  it('the first wins even when the second is newer', () => {
    claim(stub('1.0.0'));
    // Deferring to the older copy looks wrong and is not. It is the one holding live
    // handles, and handing the page to the newer copy would orphan every one of them.
    expect(claim(stub('2.0.0'))?.version).toBe('1.0.0');
  });

  it('leaves a slot the page cannot overwrite by accident', () => {
    claim(stub('1.0.0'));
    const slot = Object.getOwnPropertyDescriptor(globalThis, '__subtitledb__');
    expect(slot?.writable).toBe(false);
    // Not enumerable, so a page that iterates its own globals, and some analytics
    // scripts do, does not trip over ours.
    expect(slot?.enumerable).toBe(false);
  });

  it('ignores something else sitting in the slot that is not one of ours', () => {
    Object.defineProperty(globalThis, '__subtitledb__', {
      value: { version: 'not-ours' },
      configurable: true,
    });
    // No attach function, so it cannot be delegated to. Taking the page is better
    // than handing every attach to an object that cannot answer.
    expect(claim(stub('1.0.0'))).toBeUndefined();
  });

  it('does not throw when the slot cannot be defined at all', () => {
    Object.defineProperty(globalThis, '__subtitledb__', {
      value: 42,
      configurable: false,
      writable: false,
    });
    try {
      expect(() => claim(stub('1.0.0'))).not.toThrow();
    } finally {
      // Non-configurable, so it cannot be deleted. The suite runs one file per
      // worker, and this is the last test to touch the slot.
    }
  });
});

describe('what the second copy tells the page', () => {
  it('names both versions and says which one is handling the call', () => {
    const text = mismatch('2.0.0', '1.0.0');
    expect(text).toContain('2.0.0');
    expect(text).toContain('1.0.0');
    expect(text).toMatch(/first one handles this attach/i);
  });

  it('says why, because "loaded twice" reads as harmless and is not', () => {
    expect(mismatch('2.0.0', '1.0.0')).toMatch(/two sessions on the same video/i);
  });
});
