/**
 * sw-viewer.ts — Viewer-specific service worker
 *
 * Strategy: Cache First
 *   1. On first visit, resources (including remote CDN files) are fetched from
 *      the network and stored in the Cache Storage.
 *   2. On subsequent visits, the cached copy is returned immediately —
 *      no network round-trip required for large .sog / .bin scene files.
 *
 * The cache is keyed by the full request URL, so different scenes don't
 * collide.  Bump CACHE_VERSION to force a fresh download of everything.
 */

declare let self: ServiceWorkerGlobalScope;

const CACHE_VERSION = 1;
const CACHE_NAME = `supersplat-viewer-v${CACHE_VERSION}`;

// Install: take control immediately (no waiting for old SW to die)
self.addEventListener('install', () => {
    self.skipWaiting();
});

// Activate: claim all open viewer tabs right away and prune stale caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            caches.keys().then(names =>
                Promise.all(
                    names
                        .filter(n => n !== CACHE_NAME)
                        .map(n => caches.delete(n))
                )
            )
        ])
    );
});

// Fetch: Cache First with network fallback
self.addEventListener('fetch', (event) => {
    const fe = event as FetchEvent;
    const { request } = fe;

    // Only intercept GET requests; let POST/etc. pass through untouched
    if (request.method !== 'GET') return;

    // Only cache http(s) requests — chrome-extension:// etc. are not cacheable
    if (!request.url.startsWith('http')) return;

    fe.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            const cached = await cache.match(request);
            if (cached) {
                console.log(`[sw-viewer] cache hit: ${request.url}`);
                return cached;
            }

            // Cache miss — fetch from network
            const response = await fetch(request);
            // Cache only complete (200) responses — 206 Partial Content (range
            // requests for large .sog / .bin files from R2) is not cacheable.
            if (response.ok && response.status === 200) {
                cache.put(request, response.clone());
            }
            return response;
        })
    );
});
