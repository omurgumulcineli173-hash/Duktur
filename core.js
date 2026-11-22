// Forum çekirdeği: Cloudflare Durable Object (veya test için herhangi bir storage) üzerinde çalışır.
const ROLE_ADMIN_LEVEL = 14;   // rol verme/alma: sadece 15 ve 14
const MOD_LEVEL = 4;           // kilitle, sabitle, durum değiştir, taşı
const DELETE_LEVEL = 8;        // konu silme

const ROLES = [
  [15, 'Project Producer'], [14, 'The Project Manager'], [13, 'Project Staff Manager'],
  [12, 'Minister Admin'], [11, 'Responsible Admin'], [10, 'The Chef Admin'],
  [9, 'The Vice Chief Admin'], [8, 'Manager Admin'], [7, 'Rising Admin'],
  [6, 'Advanced Admin'], [5, 'Server Admin'], [4, 'Admin Asistan'],
  [2, 'Organizasyon Lideri'], [1, 'Member'],
].map(([level, name]) => ({ level, name }));

const PREFIXES = {
  pending: 'İnceleme Bekliyor', consideration: 'Değerlendiriliyor', approved: 'Onaylandı',
  rejected: 'Reddedildi', important: 'Önemli', interesting: 'İlginç',
};

// ---- Başlangıç forum yapısı (içerik YOK, sadece iskelet) ----
function seed() {
  const out = []; let n = 0;
  const add = (o) => {
    const f = Object.assign({
      id: 'f' + (++n), parentId: null, title: '', desc: '', order: n, canPost: true,
      postMinLevel: 1, manageMinLevel: 14, fields: [], autoPending: false,
      lockOnCreate: false, isServer: false, movePrefix: null,
    }, o);
    out.push(f); return f.id;
  };
  const playerFields = [
    { key: 'nick', label: 'Kendi Nick-Adınız', type: 'text' },
    { key: 'staticId', label: 'Static ID\'niz', type: 'number' },
    { key: 'suspect', label: 'Şüpheli Nick-Adı', type: 'text' },
    { key: 'date', label: 'Tarih', type: 'date' },
    { key: 'time', label: 'Saat', type: 'time' },
    { key: 'proof', label: 'Kanıt (link)', type: 'text' },
  ];
  const adminFields = playerFields.map(f => f.key === 'suspect' ? { key: 'admin', label: 'Yönetici Nick-Adı', type: 'text' } : f);
  const archive = (parentId) => add({ parentId, title: 'Arşiv', canPost: false, postMinLevel: MOD_LEVEL });
  const staffOnly = { postMinLevel: 12, manageMinLevel: 12, lockOnCreate: true };

  const tr1 = add({ title: 'Server | TR #1', desc: 'TR#1 sunucusunun ana bölümü. [Türkiye]', isServer: true, canPost: false });
  add({ parentId: tr1, title: 'Sunucu Kuralları', desc: 'TR#1 sunucusuna ait tüm kuralların listesi.', ...staffOnly });

  const sik = add({ parentId: tr1, title: 'Şikayetler', canPost: false });
  const ysik = add({ parentId: sik, title: 'Yöneticiler ve Yardımcılar Hakkındaki Şikayetler', fields: adminFields, autoPending: true });
  archive(ysik);
  const osik = add({ parentId: sik, title: 'Oyuncular Hakkındaki Şikayetler', fields: playerFields, autoPending: true });
  archive(osik);

  const bas = add({ parentId: tr1, title: 'Başvurular', canPost: false });
  const ybas = add({ parentId: bas, title: 'Yöneticiler için Başvuru', autoPending: true });
  archive(ybas);
  const lbas = add({ parentId: bas, title: 'Liderler için Başvuru', autoPending: true });
  archive(lbas);

  const dev = add({ parentId: tr1, title: 'Devlet Kurumları', canPost: false, ...staffOnly });
  ['Hastane', 'Ordu', 'Şehir Polisi', 'FBI', 'Medya', 'Belediye'].forEach(t => add({ parentId: dev, title: t, ...staffOnly }));

  const get = add({ parentId: tr1, title: 'Getto', canPost: false, ...staffOnly });
  ['Los Nómadas', 'Liberty', 'Inferno', 'Vipers'].forEach(t => add({ parentId: get, title: t, ...staffOnly }));

  const bio = add({ parentId: tr1, title: 'Rol Yapma Biyografileri', autoPending: true });
  add({ parentId: bio, title: 'Onaylanmış Biyografiler', canPost: false, postMinLevel: MOD_LEVEL, movePrefix: 'approved' });
  add({ parentId: bio, title: 'Reddedilmiş Biyografiler', canPost: false, postMinLevel: MOD_LEVEL, movePrefix: 'rejected' });
  return out;
}

// ---- Kripto yardımcıları (WebCrypto) ----
const enc = new TextEncoder();
const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randHex = n => toHex(crypto.getRandomValues(new Uint8Array(n)));
async function hashPw(pw, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return toHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256));
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const str = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max ? v.trim() : null;
const json = (c, d, headers = {}) => new Response(JSON.stringify(d), {
  status: c, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});

const NAMES = ['users', 'sessions', 'forums', 'threads', 'posts', 'meta'];
const CHUNK = 40000;

export function createCore(storage, siteName = 'DUKTUR') {
  const st = storage;
  let db = null, dirty = false;
  const cache = {}, counts = {};
  const hits = new Map();
  const save = () => { dirty = true; };

  // ---- Depolama: her koleksiyon JSON olarak parçalara bölünüp saklanır ----
  async function init() {
    const ns = await st.get(NAMES.map(n => 'n:' + n));
    db = {};
    let fresh = true;
    for (const n of NAMES) {
      const cnt = ns.get('n:' + n);
      if (cnt == null) continue;
      fresh = false;
      const keys = []; for (let i = 0; i < cnt; i++) keys.push(`c:${n}:${i}`);
      let s = '';
      for (let i = 0; i < keys.length; i += 100) {
        const part = keys.slice(i, i + 100), m = await st.get(part);
        for (const k of part) s += m.get(k) || '';
      }
      cache[n] = s; counts[n] = cnt; db[n] = JSON.parse(s);
    }
    if (fresh) {
      db = { users: [], sessions: {}, forums: seed(), threads: [], posts: [], meta: { seq: 1000 } };
      dirty = true; await persist(); dirty = false;
    }
  }
  async function persist() {
    for (const n of NAMES) {
      const s = JSON.stringify(db[n]);
      if (s === cache[n]) continue;
      const chunks = []; for (let i = 0; i < s.length; i += CHUNK) chunks.push(s.slice(i, i + CHUNK));
      if (!chunks.length) chunks.push('');
      for (let i = 0; i < chunks.length; i += 100) {
        const obj = {}; chunks.slice(i, i + 100).forEach((c, j) => { obj[`c:${n}:${i + j}`] = c; });
        await st.put(obj);
      }
      await st.put('n:' + n, chunks.length);
      const old = counts[n] || 0;
      if (old > chunks.length) { const del = []; for (let i = chunks.length; i < old; i++) del.push(`c:${n}:${i}`); await st.delete(del); }
      cache[n] = s; counts[n] = chunks.length;
    }
  }

  // ---- Veri yardımcıları ----
  const F = id => db.forums.find(f => f.id === id);
  const U = id => db.users.find(u => u.id === id);
  const nextId = () => ++db.meta.seq;
  const roleName = l => (ROLES.find(r => r.level === l) || { name: 'Member' }).name;
  const pub = u => u && { id: u.id, username: u.username, level: u.level, role: roleName(u.level) };
  const now = () => Date.now();

  function descIds(id) {
    const out = [id];
    for (const f of db.forums) if (f.parentId === id) out.push(...descIds(f.id));
    return out;
  }
  function crumbs(f) {
    const a = []; let c = f;
    while (c) { a.unshift({ id: c.id, title: c.title, isServer: c.isServer }); c = c.parentId && F(c.parentId); }
    return a;
  }
  function stats(id) {
    const ids = new Set(descIds(id));
    let threads = 0, messages = 0, last = null;
    for (const t of db.threads) {
      if (!ids.has(t.forumId)) continue;
      threads++; messages += 1 + t.replies;
      if (!last || t.lastAt > last.lastAt) last = t;
    }
    return {
      threads, messages,
      last: last && { threadId: last.id, title: last.title, prefix: last.prefix, by: (U(last.lastBy) || {}).username || '?', at: last.lastAt },
    };
  }
  const forumOut = f => ({ id: f.id, title: f.title, desc: f.desc, isServer: f.isServer, canPost: f.canPost, fields: f.fields, autoPending: f.autoPending });
  const canPostIn = (u, f) => f.canPost && !f.isServer && u.level >= f.postMinLevel;
  const canManage = (u, f) => u.level >= f.manageMinLevel;
  function moveTargets(f) {
    const par = f.parentId && F(f.parentId);
    return db.forums.filter(x => !x.isServer && x.id !== f.id && (
      x.parentId === f.id || x.id === f.parentId ||
      (par && !par.isServer && x.parentId === f.parentId)));
  }
  function threadOut(t) {
    return {
      id: t.id, forumId: t.forumId, title: t.title, prefix: t.prefix, locked: t.locked, pinned: t.pinned,
      replies: t.replies, views: t.views, author: pub(U(t.authorId)), createdAt: t.createdAt,
      lastAt: t.lastAt, lastBy: (U(t.lastBy) || {}).username,
    };
  }
  function limited(key, max, win) {
    const t = now(), a = (hits.get(key) || []).filter(x => t - x < win);
    a.push(t); hits.set(key, a); return a.length > max;
  }

  // ---- API ----
  async function api(req, url) {
    const send = json;
    const fail = (c, m) => json(c, { error: m });
    const p = url.pathname, m = req.method;
    const ip = req.headers.get('cf-connecting-ip') || 'local';

    let body = {};
    if (m !== 'GET') {
      if (!(req.headers.get('content-type') || '').includes('application/json')) return fail(415, 'Geçersiz istek');
      const text = await req.text();
      if (text.length > 100000) return fail(413, 'İstek çok büyük');
      try { body = text ? JSON.parse(text) : {}; } catch { return fail(400, 'Geçersiz istek'); }
      if (body === null || typeof body !== 'object') return fail(400, 'Geçersiz istek');
    }

    const cookies = {};
    for (const part of (req.headers.get('cookie') || '').split(';')) {
      const i = part.indexOf('='); if (i > 0) cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    const sid = cookies.sid;
    const me = sid && db.sessions[sid] ? U(db.sessions[sid]) : null;
    const cookie = (tok, age) => `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}` + (url.protocol === 'https:' ? '; Secure' : '');
    const startSession = (u) => {
      const tok = randHex(32);
      db.sessions[tok] = u.id; save();
      return { 'Set-Cookie': cookie(tok, 2592000) };
    };

    if (p === '/api/config' && m === 'GET') return send(200, { siteName, roles: ROLES, prefixes: PREFIXES });
    if (p === '/api/me' && m === 'GET') return send(200, { user: pub(me), canManageRoles: !!me && me.level >= ROLE_ADMIN_LEVEL, modLevel: MOD_LEVEL });

    if (p === '/api/register' && m === 'POST') {
      if (limited('reg' + ip, 10, 3600000)) return fail(429, 'Çok fazla deneme, daha sonra tekrar dene');
      const username = str(body.username, 3, 24), pw = body.password;
      if (!username || !/^[\p{L}\p{N}_ .-]+$/u.test(username)) return fail(400, 'Kullanıcı adı 3-24 karakter olmalı (harf, rakam, boşluk, _ . -)');
      if (typeof pw !== 'string' || pw.length < 6 || pw.length > 100) return fail(400, 'Şifre en az 6 karakter olmalı');
      if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) return fail(409, 'Bu kullanıcı adı alınmış');
      const salt = randHex(16), hash = await hashPw(pw, salt);
      // await sonrası tekrar kontrol (eşzamanlı kayıt yarışı)
      if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) return fail(409, 'Bu kullanıcı adı alınmış');
      // İlk kayıt olan hesap Project Producer (15) olur, diğerleri Member (1)
      const u = { id: nextId(), username, salt, hash, level: db.users.length === 0 ? 15 : 1, createdAt: now() };
      db.users.push(u);
      return send(200, { user: pub(u) }, startSession(u));
    }
    if (p === '/api/login' && m === 'POST') {
      if (limited('login' + ip, 15, 600000)) return fail(429, 'Çok fazla deneme, biraz bekle');
      const u = db.users.find(x => x.username.toLowerCase() === String(body.username || '').toLowerCase());
      if (!u || typeof body.password !== 'string' || body.password.length > 100) return fail(401, 'Kullanıcı adı veya şifre hatalı');
      if (!safeEq(await hashPw(body.password, u.salt), u.hash)) return fail(401, 'Kullanıcı adı veya şifre hatalı');
      return send(200, { user: pub(u) }, startSession(u));
    }
    if (p === '/api/logout' && m === 'POST') {
      if (sid && db.sessions[sid]) { delete db.sessions[sid]; save(); }
      return send(200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
    }

    if (!me) return fail(401, 'Giriş yapmalısın');
    let mt;

    if (p === '/api/servers' && m === 'GET') {
      return send(200, { servers: db.forums.filter(f => f.isServer).map(f => ({ ...forumOut(f), ...stats(f.id) })) });
    }

    if ((mt = p.match(/^\/api\/forum\/([\w-]+)$/)) && m === 'GET') {
      const f = F(mt[1]); if (!f) return fail(404, 'Forum bulunamadı');
      const children = db.forums.filter(x => x.parentId === f.id).sort((a, b) => a.order - b.order)
        .map(x => ({ ...forumOut(x), ...stats(x.id) }));
      const threads = db.threads.filter(t => t.forumId === f.id)
        .sort((a, b) => (b.pinned - a.pinned) || (b.lastAt - a.lastAt)).slice(0, 200).map(threadOut);
      return send(200, {
        forum: forumOut(f), crumbs: crumbs(f), children, threads,
        canPost: canPostIn(me, f), canManage: canManage(me, f),
        canDelete: canManage(me, f) && !f.isServer && !children.length && !threads.length,
      });
    }

    if (p === '/api/forum' && m === 'POST') {
      const par = F(body.parentId); if (!par) return fail(404, 'Üst forum yok');
      if (!canManage(me, par)) return fail(403, 'Alt forum açma yetkin yok');
      const title = str(body.title, 2, 80); if (!title) return fail(400, 'Başlık 2-80 karakter olmalı');
      const desc = typeof body.desc === 'string' ? body.desc.trim().slice(0, 200) : '';
      if (db.forums.filter(x => x.parentId === par.id).length >= 60) return fail(400, 'Çok fazla alt forum');
      const f = {
        id: 'f' + nextId(), parentId: par.id, title, desc, order: nextId(), canPost: true,
        postMinLevel: par.postMinLevel, manageMinLevel: par.manageMinLevel, fields: [], autoPending: false,
        lockOnCreate: par.lockOnCreate, isServer: false, movePrefix: null,
      };
      db.forums.push(f); save();
      return send(200, { forum: forumOut(f) });
    }
    if ((mt = p.match(/^\/api\/forum\/([\w-]+)$/)) && m === 'DELETE') {
      const f = F(mt[1]); if (!f || f.isServer) return fail(404, 'Forum bulunamadı');
      if (!canManage(me, f)) return fail(403, 'Yetkin yok');
      if (db.forums.some(x => x.parentId === f.id) || db.threads.some(t => t.forumId === f.id)) return fail(400, 'Forum boş değil');
      db.forums = db.forums.filter(x => x.id !== f.id); save();
      return send(200, { ok: true, parent: f.parentId });
    }

    if ((mt = p.match(/^\/api\/thread\/(\d+)$/)) && m === 'GET') {
      const t = db.threads.find(x => x.id === +mt[1]); if (!t) return fail(404, 'Konu bulunamadı');
      const f = F(t.forumId);
      t.views++; // bellekte; bir sonraki yazmada kaydedilir
      const posts = db.posts.filter(x => x.threadId === t.id).sort((a, b) => a.createdAt - b.createdAt)
        .map(x => ({ id: x.id, body: x.body, createdAt: x.createdAt, author: pub(U(x.authorId)) }));
      const isMod = me.level >= MOD_LEVEL;
      return send(200, {
        thread: { ...threadOut(t), body: t.body, fields: t.fields }, forum: forumOut(f), crumbs: crumbs(f), posts,
        canReply: !t.locked || isMod, canMod: isMod, canDelete: me.level >= DELETE_LEVEL,
        moveTargets: isMod ? moveTargets(f).map(x => ({ id: x.id, title: x.title })) : [],
      });
    }

    if (p === '/api/thread' && m === 'POST') {
      const f = F(body.forumId);
      if (!f) return fail(404, 'Forum bulunamadı');
      if (!canPostIn(me, f)) return fail(403, 'Bu bölüme yazma yetkin yok');
      if (limited('thr' + me.id, 10, 600000)) return fail(429, 'Çok hızlı konu açıyorsun');
      const title = str(body.title, 3, 120), text = str(body.body, 1, 10000);
      if (!title) return fail(400, 'Başlık 3-120 karakter olmalı');
      if (!text) return fail(400, 'Mesaj boş olamaz');
      const fields = {};
      for (const d of f.fields) {
        const v = str(String(body.fields && body.fields[d.key] != null ? body.fields[d.key] : ''), 1, 300);
        if (!v) return fail(400, `"${d.label}" alanı zorunlu`);
        if (d.type === 'number' && !/^\d{1,12}$/.test(v)) return fail(400, `"${d.label}" sayı olmalı`);
        fields[d.key] = v;
      }
      let prefix = null;
      if (f.autoPending) prefix = 'pending';
      else if (me.level >= MOD_LEVEL && PREFIXES[body.prefix]) prefix = body.prefix;
      const t2 = {
        id: nextId(), forumId: f.id, title, prefix, authorId: me.id, createdAt: now(), body: text, fields,
        locked: !!f.lockOnCreate, pinned: false, views: 0, replies: 0, lastAt: now(), lastBy: me.id,
      };
      db.threads.push(t2); save();
      return send(200, { id: t2.id });
    }

    if ((mt = p.match(/^\/api\/thread\/(\d+)\/reply$/)) && m === 'POST') {
      const t = db.threads.find(x => x.id === +mt[1]); if (!t) return fail(404, 'Konu bulunamadı');
      if (t.locked && me.level < MOD_LEVEL) return fail(403, 'Bu konu kilitli');
      if (limited('rep' + me.id, 20, 600000)) return fail(429, 'Çok hızlı yazıyorsun');
      const text = str(body.body, 1, 10000); if (!text) return fail(400, 'Mesaj boş olamaz');
      db.posts.push({ id: nextId(), threadId: t.id, authorId: me.id, body: text, createdAt: now() });
      t.replies++; t.lastAt = now(); t.lastBy = me.id; save();
      return send(200, { ok: true });
    }

    if ((mt = p.match(/^\/api\/thread\/(\d+)\/mod$/)) && m === 'POST') {
      const t = db.threads.find(x => x.id === +mt[1]); if (!t) return fail(404, 'Konu bulunamadı');
      if (me.level < MOD_LEVEL) return fail(403, 'Yetkin yok');
      const v = body.value;
      switch (body.action) {
        case 'lock': t.locked = true; break;
        case 'unlock': t.locked = false; break;
        case 'pin': t.pinned = true; break;
        case 'unpin': t.pinned = false; break;
        case 'prefix':
          if (v === '' || v === null) t.prefix = null;
          else if (PREFIXES[v]) t.prefix = v; else return fail(400, 'Geçersiz durum');
          break;
        case 'move': {
          const target = moveTargets(F(t.forumId)).find(x => x.id === v);
          if (!target) return fail(400, 'Geçersiz hedef forum');
          t.forumId = target.id; if (target.movePrefix) t.prefix = target.movePrefix;
          break;
        }
        case 'delete':
          if (me.level < DELETE_LEVEL) return fail(403, 'Silme yetkin yok');
          db.threads = db.threads.filter(x => x.id !== t.id);
          db.posts = db.posts.filter(x => x.threadId !== t.id);
          save(); return send(200, { ok: true, forumId: t.forumId });
        default: return fail(400, 'Geçersiz işlem');
      }
      save(); return send(200, { ok: true });
    }

    // ---- Rol yönetimi: sadece Level 14 ve 15 ----
    if (p === '/api/users' && m === 'GET') {
      if (me.level < ROLE_ADMIN_LEVEL) return fail(403, 'Yetkin yok');
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const users = db.users.filter(u => u.username.toLowerCase().includes(q)).slice(0, 50)
        .map(u => ({ ...pub(u), editable: u.level < me.level }));
      return send(200, { users, assignable: ROLES.filter(r => r.level < me.level) });
    }
    if (p === '/api/role' && m === 'POST') {
      if (me.level < ROLE_ADMIN_LEVEL) return fail(403, 'Rol verme/alma yetkin yok');
      const target = U(body.userId), level = +body.level;
      if (!target) return fail(404, 'Kullanıcı bulunamadı');
      if (!ROLES.some(r => r.level === level)) return fail(400, 'Geçersiz rol');
      if (target.level >= me.level) return fail(403, 'Kendi seviyendeki veya üstündeki birinin rolünü değiştiremezsin');
      if (level >= me.level) return fail(403, 'Kendi seviyende veya üstünde rol veremezsin');
      target.level = level; save();
      return send(200, { user: pub(target) });
    }

    return fail(404, 'Bulunamadı');
  }

  async function handle(request) {
    const url = new URL(request.url);
    let res;
    try { res = await api(request, url); }
    catch (e) { console.error(e); res = json(500, { error: 'Sunucu hatası' }); }
    if (dirty) { dirty = false; await persist(); }
    return res;
  }

  return { init, handle };
}
