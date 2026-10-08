/* Rock Solid service worker: keeps the app opening offline, and shows reminder notifications. */
const CACHE = 'rs-shell-v1'
const FONT_CACHE = 'rs-fonts-v1'

async function precache() {
  const cache = await caches.open(CACHE)
  const res = await fetch('/', { cache: 'no-store' })
  const html = await res.clone().text()
  await cache.put('/index.html', res)
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
  await cache.addAll(['/manifest.webmanifest', '/icon.svg', ...assets])
}

self.addEventListener('install', (e) => {
  e.waitUntil(precache().catch(() => {}).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // The app page: try the network so updates show up, fall back to the saved copy offline.
  if (req.mode === 'navigate' && url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put('/index.html', res.clone()))
          return res
        })
        .catch(() => caches.match('/index.html')),
    )
    return
  }

  // App code and images: file names change with every version, so a saved copy is always right.
  if (url.origin === location.origin && (url.pathname.startsWith('/assets/') || url.pathname === '/icon.svg' || url.pathname === '/manifest.webmanifest')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()))
        return res
      })),
    )
    return
  }

  // Fonts: use the saved copy, refresh it in the background.
  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    e.respondWith(
      caches.open(FONT_CACHE).then((c) => c.match(req).then((hit) => {
        const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res }).catch(() => hit)
        return hit || net
      })),
    )
  }
  // Everything else (the database) goes straight to the network; the app keeps its own offline copy.
})

// ---------- Reminder notifications ----------
self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { d = { body: e.data && e.data.text() } }
  e.waitUntil(
    self.registration.showNotification(d.title || 'Rock Solid', {
      body: d.body || '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: d.tag || 'rock-solid',
      data: { url: d.url || '/' },
    }),
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const target = (e.notification.data && e.notification.data.url) || '/'
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) { c.navigate(target).catch(() => {}); return c.focus() }
      return self.clients.openWindow(target)
    }),
  )
})
