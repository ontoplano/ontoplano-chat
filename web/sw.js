/*
 * The shell, kept: the page opens from the home screen even before the
 * server answers. Nothing under /api is ever cached — a turn is a turn.
 * `__VERSION__` is written in by the server, so a new build is a new cache.
 */
const VERSION = '__VERSION__';
const CACHE = `onto-${VERSION}`;
const SHELL = [
	'/',
	'/index.html',
	'/app.js',
	'/strings.js',
	'/style.css',
	'/manifest.webmanifest',
	'/icons/icon-192.png',
	'/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((c) => c.addAll(SHELL))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
	// Network first, so a new build shows up; the cache answers when the server is away.
	event.respondWith(
		fetch(event.request)
			.then((res) => {
				const copy = res.clone();
				caches.open(CACHE).then((c) => c.put(event.request, copy));
				return res;
			})
			.catch(() => caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || caches.match('/')))
	);
});
