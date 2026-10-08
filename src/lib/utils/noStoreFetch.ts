/**
 * `fetch` that bypasses the browser HTTP cache.
 *
 * Storage APIs often answer reads without `Cache-Control` (S3) or with a short `max-age`
 * (GitHub), so the browser may serve a cached copy instead of asking the server. For sync state
 * like `/sync.lock` that means a client can keep seeing a lock that was already deleted, and stay
 * locked out until the cached copy expires. Every backend read must reflect the server right now.
 *
 * `fetch` is looked up on each call, so tests that replace `globalThis.fetch` still apply.
 */
export const noStoreFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: 'no-store' });
