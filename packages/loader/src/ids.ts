/**
 * The two identifiers every call from this loader carries.
 *
 * Both are query parameters rather than headers, so no request pays for a CORS
 * preflight, and both name the loader or the page load, never the visitor.
 */

/**
 * Names the loader on every lookup and every download, so the API can tell its traffic
 * from a page that bundled the packages itself. The API records a download under one
 * of a closed list of names, one per integration, and this is the loader's.
 */
export const CLIENT = 'loader';

/**
 * One id per page load, minted when this module is first imported. It rides every API
 * request and the subtitle download as `antispam_id`, so a page-load's searches and
 * downloads can be correlated server-side: many downloads under an id with no matching
 * searches reads as a scraper. Regenerated on every load, never persisted, so it is a
 * page-load id and not a visitor id.
 */
export const ANTISPAM_ID = randomId();

function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // A page served over plain http, or an old engine, has no crypto.randomUUID. This
  // only has to be unique within one page load, so a non-cryptographic v4-shaped id
  // is enough where the real one is unavailable.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
