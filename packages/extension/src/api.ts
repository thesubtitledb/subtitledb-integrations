/**
 * How the extension names itself to the API: `client` on every lookup and download,
 * and a User-Agent token on its own requests.
 *
 * Firefox lets an extension set User-Agent on a fetch. Chrome drops it silently, so
 * there a session rule rewrites the header on the extension's own requests to the API
 * host and nothing else (tabIds -1 is requests made outside any tab).
 */

declare const __TARGET__: 'chrome' | 'firefox';
declare const __VERSION__: string;

export const TARGET = __TARGET__;
export const VERSION = __VERSION__;
export const CLIENT = `${TARGET}-extension`;
export const API_HOST = 'api.thesubtitledb.org';

export function userAgent(base: string = navigator.userAgent): string {
  return `${base} TheSubtitleDB-Extension/${VERSION} (${TARGET})`;
}

export const apiFetch: typeof fetch = (input, init) => {
  if (TARGET !== 'firefox') return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set('User-Agent', userAgent());
  return fetch(input, { ...init, headers });
};

const RULE_ID = 1;

/** Chrome only: the session rule that sets User-Agent. Best effort. */
export async function tagRequests(): Promise<void> {
  const dnr = (chrome as unknown as { declarativeNetRequest?: Dnr }).declarativeNetRequest;
  if (TARGET !== 'chrome' || !dnr?.updateSessionRules) return;
  try {
    await dnr.updateSessionRules({
      removeRuleIds: [RULE_ID],
      addRules: [
        {
          id: RULE_ID,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'user-agent', operation: 'set', value: userAgent() }],
          },
          condition: {
            requestDomains: [API_HOST],
            tabIds: [-1],
            initiatorDomains: [chrome.runtime.id],
          },
        },
      ],
    });
  } catch {
    // The header is a courtesy. A lookup without it still works.
  }
}

interface Dnr {
  updateSessionRules(o: { removeRuleIds: number[]; addRules: unknown[] }): Promise<void>;
}
