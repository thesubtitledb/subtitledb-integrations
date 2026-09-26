/**
 * The two identifiers every call from this loader carries.
 *
 * Both are query parameters rather than headers, so no request pays for a CORS
 * preflight, and both name the page or the release, never the visitor.
 */
declare const __SDB_VERSION__: string;

/**
 * Names CDN traffic in the API logs, so a page served the loader from the CDN is
 * distinguishable from one that bundled the packages itself. Identifies the release.
 */
export const CLIENT = `cdn/${__SDB_VERSION__}`;

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
