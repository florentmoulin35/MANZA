/* Manza – service worker
   Rôles : 1) fonctionnement hors connexion, 2) vérification des rappels de santé en arrière-plan
   (Android, application installée), 3) ouverture de l'app au toucher d'une notification. */
const CACHE = 'manza-v3';
const CORE = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {})))));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Réseau d'abord (pour toujours avoir la dernière version), cache si hors connexion
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.search) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(async () => (await caches.match(req)) || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))
  );
});

/* ---------- Rappels ---------- */
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
function addInterval(key, n, unit) {
  const d = parseYmd(key);
  if (unit === 'jours') return ymd(addDays(d, n));
  if (unit === 'semaines') return ymd(addDays(d, n * 7));
  const r = new Date(d.getFullYear(), d.getMonth() + n, 1);
  r.setDate(Math.min(d.getDate(), new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate()));
  return ymd(r);
}
const nextOf = s => s.next || (s.last && s.every ? addInterval(s.last, s.every, s.unit) : null);
const fmtDate = k => parseYmd(k).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });

function dueReminders(soins, sent, remind) {
  const out = []; const tk = ymd(new Date());
  const offs = [...(remind && remind.length ? remind : [7, 1])].sort((a, b) => a - b);
  soins.forEach(s => {
    const n = nextOf(s); if (!n) return;
    const d = daysBetween(tk, n); let k, title;
    if (d < 0) { if (d < -30) return; k = 'late'; title = `En retard : ${s.name}`; }
    else {
      const o = offs.find(x => d <= x); if (o === undefined) return;
      k = 'j' + o; title = d === 0 ? `Aujourd’hui : ${s.name}` : d === 1 ? `Demain : ${s.name}` : `Dans ${d} jours : ${s.name}`;
    }
    const key = `${s.id}|${n}|${k}`;
    if (!sent.includes(key)) out.push({ key, title, body: `Manza : prévu le ${fmtDate(n)}.` });
  });
  return out;
}

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('manza-carnet');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function idb(db, store, mode, fn) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, mode); const q = fn(tx.objectStore(store));
    tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error);
  });
}

async function checkReminders() {
  let db;
  try {
    db = await openDB();
    if (!db.objectStoreNames.contains('soins') || !db.objectStoreNames.contains('meta')) return;
    const soins = await idb(db, 'soins', 'readonly', o => o.getAll());
    const row = await idb(db, 'meta', 'readonly', o => o.get('notifSent'));
    const sent = (row && row.value) || [];
    const prefs = await idb(db, 'meta', 'readonly', o => o.get('settings'));
    const due = dueReminders(soins, sent, prefs && prefs.value && prefs.value.remind);
    for (const r of due) {
      await self.registration.showNotification(r.title, { body: r.body, tag: r.key, icon: 'icon-192.png', badge: 'icon-192.png', lang: 'fr', data: { url: './#sante' } });
      sent.push(r.key);
    }
    if (due.length) await idb(db, 'meta', 'readwrite', o => o.put({ id: 'notifSent', value: sent.slice(-300) }));
  } catch (e) { /* rien : nouvel essai au prochain passage */ }
  finally { if (db) db.close(); }
}

self.addEventListener('periodicsync', e => { if (e.tag === 'manza-rappels') e.waitUntil(checkReminders()); });
self.addEventListener('message', e => { if (e.data === 'check-reminders') e.waitUntil(checkReminders()); });

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) { if ('focus' in c) { await c.focus(); if ('navigate' in c) c.navigate(target); return; } }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
