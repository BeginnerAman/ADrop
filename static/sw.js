/**
 * sw.js — ADrop V2 Service Worker
 *
 * Provides offline capability and fast cache-first loading for static assets.
 * Does NOT cache file uploads/downloads (those must always hit the server).
 *
 * Cache Strategy:
 *  - Static assets (HTML, CSS, JS, icons): Cache-first with network fallback
 *  - API routes (/files, /upload, /download-all, etc.): Network-only (never cache)
 *  - Offline fallback: Shows a minimal offline notice if network fails for navigation
 */

const CACHE_NAME = 'adrop-v2-cache-v1';

// Static assets to cache on install
const PRECACHE_ASSETS = [
    '/',
    '/static/style.css',
    '/static/app.js',
    '/static/upload-worker.js',
    '/static/logo.png',
    '/static/favicon.ico',
    '/static/manifest.json',
];

// API paths that must NEVER be cached (always network)
const NETWORK_ONLY_PREFIXES = [
    '/upload',
    '/download',
    '/download-all',
    '/preview',
    '/delete',
    '/files',
    '/share-text',
    '/transfers',
    '/progress',
    '/info',
    '/qr',
    '/ws',
];

// ─── Install: Pre-cache static assets ─────────────────────────────────────
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(PRECACHE_ASSETS);
        }).then(() => {
            // Skip waiting so the new SW activates immediately
            return self.skipWaiting();
        })
    );
});

// ─── Activate: Delete old caches ──────────────────────────────────────────
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            );
        }).then(() => {
            // Take control of all open clients immediately
            return self.clients.claim();
        })
    );
});

// ─── Fetch: Cache-first for static, network-only for API ──────────────────
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const pathname = url.pathname;

    // Skip non-GET requests (POST uploads, DELETE, etc.)
    if (event.request.method !== 'GET') return;

    // Skip WebSocket upgrades
    if (event.request.headers.get('upgrade') === 'websocket') return;

    // API routes: always go to network, never cache
    const isNetworkOnly = NETWORK_ONLY_PREFIXES.some(prefix => pathname.startsWith(prefix));
    if (isNetworkOnly) {
        // Network-only: just pass through
        return;
    }

    // Static assets: cache-first strategy
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                // Return cached version and update cache in background
                const fetchPromise = fetch(event.request).then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        const responseClone = networkResponse.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, responseClone);
                        });
                    }
                    return networkResponse;
                }).catch(() => {/* network failed — cached response already returned */});
                return cachedResponse;
            }

            // Not in cache: fetch from network and cache it
            return fetch(event.request).then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }
                return networkResponse;
            }).catch(() => {
                // Offline and not in cache — return minimal fallback for navigation
                if (event.request.mode === 'navigate') {
                    return new Response(
                        '<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0a1a;color:#fff">' +
                        '<h1>ADrop</h1><p>You are offline. Please connect to the local network.</p></body></html>',
                        { headers: { 'Content-Type': 'text/html' } }
                    );
                }
            });
        })
    );
});
