'use strict';
/* Lucky Nova server. Запуск: npm i ws && node server.js
   ENV: BOT_TOKEN (токен бота), ADMIN_PW (пароль админа), PORT, DB_FILE, ALLOW_DEV=1 (вход без Telegram: ?dev=имя) */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000, TOKEN = process.env.BOT_TOKEN || '', ADMIN_PW = process.env.ADMIN_PW || '', DEV = process.env.ALLOW_DEV == '1';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');
const rnd = n => Math.floor(Math.random() * n), rid = () => crypto.randomBytes(5).toString('hex');

/* ---------- база (JSON-файл) ---------- */
let db = { users: {}, orders: [], paid: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) {}
let dirty = 0;
const save = (now) => { dirty = 1; if (now) flush(); };
function flush() {
  if (!dirty) return; dirty = 0;
  const users = {};
  for (const id in db.users) { const { ws, room, dc, ...u } = db.users[id]; users[id] = u; }
  try { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify({ users, orders: db.orders, paid: db.paid })); fs.renameSync(DB_FILE + '.tmp', DB_FILE); } catch (e) { console.error('save', e.message); }
}
setInterval(flush, 5000);
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { save(1); process.exit(0); });

/* ---------- каталог ---------- */
const CAT = {};
const NAMES = { k1: 'Неон', k2: 'Золото', k4: 'Изумруд', k5: 'Рубин', k7: 'Лёд', k6: 'Обсидиан', k3: 'Бриллиант', k8: 'Космос', k9: 'Дракон', k10: 'Матрица', k11: 'Аврора', k12: 'Лава', k13: 'Сакура', k14: 'Глитч', k15: 'Мифик', bt1: 'Дерево', bt2: 'Мрамор', bt3: 'Неон', bt4: 'Лёд', bt5: 'Золото', bt6: 'Обсидиан', bt7: 'Лава', bt8: 'Сакура', bt9: 'Матрица' };
['k1', 'k2', 'k4', 'k5', 'k7', 'k6', 'k3', 'k8', 'k9', 'k10', 'k11', 'k12', 'k13', 'k14', 'k15'].forEach((k, i) => CAT[k] = { name: 'Скин карт «' + NAMES[k] + '»', rub: (i + 1) * 10 });
for (let i = 1; i <= 9; i++) CAT['bt' + i] = { name: 'Доска «' + NAMES['bt' + i] + '»', rub: i * 10 };
[['f1', 'Золотая рамка', 149], ['f2', 'Неоновая рамка', 249], ['f3', 'Изумрудная рамка', 349]].forEach(([k, n, r]) => CAT[k] = { name: n, rub: r, n: r });
[['p1', 99, 50, 1000], ['p2', 449, 230, 5000], ['p3', 1190, 600, 15000], ['p4', 3490, 1750, 50000]].forEach(([k, r, s, n]) => CAT[k] = { name: 'Игровая валюта: ' + n + ' ₽', rub: r, st: s, n, pack: 1 });
for (const k in CAT) CAT[k].st = CAT[k].st || Math.ceil(CAT[k].rub / 2);

/* ---------- пользователи и связь ---------- */
const usr = id => db.users[id];
function getU(id, name, un) {
  let u = db.users[id];
  if (!u) u = db.users[id] = { id, name, username: un || '', bal: 0, gb: null, skins: ['k0'], sel: 'k0', ban: 0, why: '', q: [] };
  u.name = name; u.username = un || u.username || ''; return u;
}
const tx = (u, o) => { if (u && u.ws && u.ws.readyState == 1) { u.ws.send(JSON.stringify(o)); return true } return false };
const deliver = (u, o) => { if (!tx(u, o)) { u.q.push(o); save() } };
const me = u => tx(u, { t: 'me', bal: u.bal, skins: u.skins, sel: u.sel, id: u.id, name: u.name });
const err = (u, m) => tx(u, { t: 'err', m });
const findU = q => { q = String(q || '').trim(); if (db.users[q]) return db.users[q]; const l = q.replace(/^@/, '').toLowerCase(); return Object.values(db.users).find(u => u.username && u.username.toLowerCase() == l) };
function grant(u, k) {
  const it = CAT[k]; if (!it) return;
  if (it.pack) deliver(u, { t: 'paid', k, n: it.n });
  else { if (!u.skins.includes(k)) u.skins.push(k); deliver(u, { t: 'paid', k, n: it.n || 0 }); me(u); }
  save();
}

/* ---------- Telegram: проверка входа, Stars ---------- */
function tgUser(init) {
  if (!init || !TOKEN) return null;
  const p = new URLSearchParams(init), h = p.get('hash'); p.delete('hash');
  const s = [...p.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => k + '=' + v).join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest(), c = crypto.createHmac('sha256', key).update(s).digest('hex');
  if (!h || h.length != c.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(c))) return null;
  try { return JSON.parse(p.get('user')) } catch (e) { return null }
}
async function api(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function poll() {
  if (!TOKEN) return console.log('BOT_TOKEN не задан: Stars отключены');
  try { await api('deleteWebhook', {}) } catch (e) {}
  let off = 0;
  for (;;) {
    try {
      const j = await api('getUpdates', { offset: off, timeout: 30, allowed_updates: ['pre_checkout_query', 'message'] });
      for (const up of j.result || []) {
        off = up.update_id + 1;
        const pq = up.pre_checkout_query;
        if (pq) { const [uid, k] = String(pq.invoice_payload).split('|'), ok = !!(usr(uid) && CAT[k] && pq.currency == 'XTR' && pq.total_amount == CAT[k].st); await api('answerPreCheckoutQuery', { pre_checkout_query_id: pq.id, ok, error_message: ok ? undefined : 'Товар недоступен' }); }
        const sp = up.message && up.message.successful_payment;
        if (sp) {
          const [uid, k] = String(sp.invoice_payload).split('|'), u = usr(uid), id = sp.telegram_payment_charge_id;
          if (u && CAT[k] && sp.currency == 'XTR' && sp.total_amount == CAT[k].st && !db.paid[id]) { db.paid[id] = { uid, k, t: Date.now() }; grant(u, k); }
        }
      }
    } catch (e) { console.error('poll', e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
}

/* ---------- комнаты ---------- */
const rooms = {}, EM = ['😊', '🤐', '😘', '😎', '🤡', '👍', '👎'];
const mkCode = () => { let c; do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[rnd(24)]).join('') } while (rooms[c]); return c };
const mkP = u => ({ id: u.id, name: u.name, skin: u.sel, hand: [], out: 0 });
const sendRoom = r => r.pl.forEach(p => tx(usr(p.id), { t: 'room', code: r.code, kind: r.kind, pl: r.pl.map(x => ({ id: x.id, name: x.name, skin: x.skin })), max: r.max, host: r.host, bet: r.bet }));
function closeRoom(r) { r.pl.forEach(p => { const u = usr(p.id); if (u) { u.room = null; me(u) } }); delete rooms[r.code]; save(); }
function leaveRoom(u) {
  const r = rooms[u.room]; if (!r) { u.room = null; return }
  if (r.started) { r.kind == 'durak' ? abandon(r, u.id) : boardEnd(r, { loser: u.id, left: 1 }); return }
  r.pl = r.pl.filter(p => p.id != u.id); u.bal += r.bet; u.room = null; me(u); tx(u, { t: 'room' });
  if (!r.pl.length) delete rooms[r.code]; else { if (r.host == u.id) r.host = r.pl[0].id; sendRoom(r) }
  save();
}
function mk(u, m) {
  if (u.room) return err(u, 'Ты уже за столом');
  const kind = ['durak', 'chess', 'checkers'].includes(m.kind) ? m.kind : 'durak', bet = Math.floor(+m.n);
  if (!(bet >= 1 && bet <= 1e12)) return err(u, 'Некорректная ставка');
  if (u.bal < bet) return err(u, 'Не хватает средств в банке');
  u.bal -= bet;
  const r = { code: mkCode(), kind, bet, max: kind == 'durak' ? Math.min(4, Math.max(2, +m.max || 2)) : 2, host: u.id, pl: [mkP(u)], started: 0 };
  rooms[r.code] = r; u.room = r.code; me(u); sendRoom(r);
}
function jn(u, m) {
  const r = rooms[String(m.code || '').toUpperCase()];
  if (u.room) return err(u, 'Ты уже за столом');
  if (!r || r.started || r.pl.length >= r.max) return err(u, 'Стол не найден или занят');
  if (u.bal < r.bet) return err(u, 'Не хватает средств в банке');
  u.bal -= r.bet; r.pl.push(mkP(u)); u.room = r.code; me(u); sendRoom(r);
  if (r.kind != 'durak' && r.pl.length == r.max) startBoard(r);
}

/* ---------- шахматы и шашки: сервер ретранслирует ходы ---------- */
function startBoard(r) {
  r.started = 1; r.over = 0; const f = rnd(2);
  r.pl.forEach((p, i) => { const o = r.pl[1 - i]; tx(usr(p.id), { t: 'gstart', kind: r.kind, side: (i == f) ? 'w' : 'b', opp: o.name, bet: r.bet }) });
}
function boardEnd(r, o) {
  if (r.over) return; r.over = 1;
  r.pl.forEach(p => {
    const u = usr(p.id); let win = 2, n = r.bet;
    if (!o.draw) { win = p.id == o.loser ? 0 : 1; n = win ? r.bet * 2 : 0 }
    u.bal += n; tx(u, { t: 'end', kind: r.kind, win, n, left: o.left ? 1 : undefined });
  });
  closeRoom(r);
}

/* ---------- дурак (подкидной) ---------- */
const rk = c => c % 9, su = c => Math.floor(c / 9), beats = (a, d, ts) => su(a) === su(d) ? rk(d) > rk(a) : su(d) === ts && su(a) !== ts;
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1);[a[i], a[j]] = [a[j], a[i]] } return a };
const alive = r => r.pl.filter(p => !p.out), nxt = (r, i) => { for (let k = 1; k <= r.pl.length; k++) { const j = (i + k) % r.pl.length; if (!r.pl[j].out) return j } return i };
const srt = (p, ts) => p.hand.sort((a, b) => (su(a) === ts) - (su(b) === ts) || su(a) - su(b) || rk(a) - rk(b));
function dStart(r) {
  r.started = 1;
  const deck = shuffle(Array.from({ length: 36 }, (_, i) => i)), ts = su(deck[0]);
  r.pl.forEach(p => { p.skin = usr(p.id).sel; p.out = 0; p.hand = deck.splice(deck.length - 6, 6) });
  let att = rnd(r.pl.length), best = 99;
  r.pl.forEach((p, i) => p.hand.forEach(c => { if (su(c) === ts && rk(c) < best) { best = rk(c); att = i } }));
  r.g = { deck, tc: deck[0], ts, tb: [], disc: [], att, def: 0, lim: 5, tk: 0, conf: { a: 0, d: 0 }, done: {}, bout: 1, sus: {}, cheats: {}, cb: {}, ab: {} };
  r.g.def = nxt(r, att); r.g.lim = Math.min(5, r.pl[r.g.def].hand.length);
  r.pl.forEach(p => srt(p, ts)); sendG(r);
}
function canThrow(r, i) {
  const g = r.g, p = r.pl[i];
  if (i === g.def || p.out || !p.hand.length) return false;
  if (!g.tb.length) return i === g.att;
  if (g.tb.length >= g.lim) return false;
  if (!g.tk && g.tb.filter(x => x.d == null).length >= r.pl[g.def].hand.length) return false;
  return p.hand.some(c => g.tb.some(x => rk(x.a) === rk(c) || (x.d != null && rk(x.d) === rk(c))));
}
function play(r, i, m) {
  const g = r.g, p = r.pl[i], c = p.hand[m.c], u = usr(p.id);
  if (c == null || p.out) return;
  if (i === g.def) {
    if (g.tk) return err(u, 'Ты уже берёшь карты');
    const t = Number.isInteger(m.tgt) && g.tb[m.tgt] && g.tb[m.tgt].d == null ? m.tgt : g.tb.findIndex(x => x.d == null && beats(x.a, c, g.ts));
    if (t < 0 || !g.tb[t] || g.tb[t].d != null || !beats(g.tb[t].a, c, g.ts)) return err(u, 'Этой картой не побить');
    g.tb[t].d = c; g.tb[t].ds = p.skin;
  } else {
    if (!canThrow(r, i)) return err(u, 'Сейчас подкидывать нельзя');
    if (g.tb.length && !g.tb.some(x => rk(x.a) === rk(c) || (x.d != null && rk(x.d) === rk(c)))) return err(u, 'Такого ранга нет на столе');
    g.tb.push({ a: c, as: p.skin, d: null });
  }
  p.hand.splice(m.c, 1); g.conf = { a: 0, d: 0 }; g.done = {}; settle(r);
}
function act(r, i) {
  const g = r.g, open = g.tb.some(x => x.d == null), beaten = g.tb.length && !open;
  if (i === g.def) { if (open && !g.tk) { g.tk = 1; g.done = {} } else if (beaten && g.conf.a && !g.conf.d) g.conf.d = 1 }
  else if (g.tk) g.done[i] = 1;
  else if (i === g.att && beaten && !g.conf.a) g.conf.a = 1;
  settle(r);
}
function settle(r) {
  const g = r.g;
  if (g.tk) {
    if (!r.pl.some((p, j) => j !== g.def && canThrow(r, j) && !g.done[j])) { const d = r.pl[g.def]; g.tb.forEach(x => { d.hand.push(x.a); if (x.d != null) d.hand.push(x.d) }); g.tb = []; return endBout(r, 1) }
  } else if (g.conf.a && g.conf.d && g.tb.length && g.tb.every(x => x.d != null)) { g.tb.forEach(x => g.disc.push(x.a, x.d)); g.tb = []; return endBout(r, 0) }
  sendG(r);
}
function endBout(r, took) {
  const g = r.g; g.tk = 0; g.conf = { a: 0, d: 0 }; g.done = {}; g.bout++;
  const ord = []; for (let k = 0; k < r.pl.length; k++) ord.push((g.att + k) % r.pl.length);
  ord.filter(j => j !== g.def).concat([g.def]).forEach(j => { const p = r.pl[j]; while (!p.out && p.hand.length < 6 && g.deck.length) p.hand.push(g.deck.pop()) });
  r.pl.forEach(p => { if (!p.out && !p.hand.length && !g.deck.length) p.out = 1; srt(p, g.ts) });
  const al = alive(r); if (al.length <= 1) return dFinish(r, al[0]);
  g.att = took || r.pl[g.def].out ? nxt(r, g.def) : g.def; g.def = nxt(r, g.att); g.lim = Math.min(6, r.pl[g.def].hand.length);
  sendG(r);
}
function dFinish(r, loser) {
  const n = r.pl.length, bonus = Math.floor(r.bet / (n - 1));
  r.pl.forEach(p => {
    const u = usr(p.id); let win = 2, amt = r.bet;
    if (loser && p.id === loser.id) { win = 0; amt = 0 } else if (loser) { win = 1; amt = r.bet + bonus }
    u.bal += amt; tx(u, { t: 'end', win, n: amt, durak: loser ? loser.name : '' });
  });
  closeRoom(r);
}
function abandon(r, id) {
  const n = r.pl.length, bonus = Math.floor(r.bet / (n - 1));
  r.pl.forEach(p => { const u = usr(p.id), mine = p.id === id, amt = mine ? 0 : r.bet + bonus; u.bal += amt; tx(u, { t: 'end', win: mine ? 0 : 1, n: amt, durak: usr(id).name, left: 1 }) });
  closeRoom(r);
}
function view(r, p) {
  const g = r.g, i = r.pl.indexOf(p), open = g.tb.filter(x => x.d == null).length, beaten = g.tb.length && !open, nm = j => r.pl[j].name;
  let a = null, tx_ = 'Смотришь за игрой';
  if (!p.out) {
    if (i === g.def) {
      if (g.tk) tx_ = 'Ты берёшь карты. Ждём подкидывающих';
      else if (open) { a = 'take'; tx_ = 'Отбивайся: перетащи карту на атакующую или нажми «Взять»' }
      else if (beaten && g.conf.a && !g.conf.d) { a = 'confirm'; tx_ = nm(g.att) + ' сказал «бито». Подтверди' }
      else if (beaten) tx_ = 'Отбито. Ждём: подкинут или скажут «бито»';
      else tx_ = 'Ходит ' + nm(g.att);
    } else if (g.tk) {
      if (canThrow(r, i) && !g.done[i]) { a = 'done'; tx_ = nm(g.def) + ' берёт. Подкинь ещё или нажми «Готово»' } else tx_ = 'Ждём остальных';
    } else if (i === g.att) {
      if (!g.tb.length) tx_ = 'Твой ход: перетащи карту на стол';
      else if (open) tx_ = 'Ждём, пока ' + nm(g.def) + ' отобьётся';
      else if (!g.conf.a) { a = 'bito'; tx_ = 'Подкинь ещё или нажми «Бито»' }
      else tx_ = 'Ждём подтверждения от ' + nm(g.def);
    } else tx_ = canThrow(r, i) ? 'Можешь подкинуть карту' : 'Ждёшь';
  }
  return {
    t: 'g', bet: r.bet, dn: g.deck.length, tc: g.tc, ts: g.ts, di: g.disc.length, tb: g.tb, tk: g.tk, h: p.hand, skin: p.skin, act: a, tx: tx_, me: p.id, out: p.out,
    pl: r.pl.map((x, j) => ({ id: x.id, name: x.name, skin: x.skin, n: x.hand.length, out: x.out, role: j === g.att ? 'a' : j === g.def ? 'd' : 't', ok: j === g.att ? g.conf.a : j === g.def ? g.conf.d : g.done[j] ? 1 : 0 })),
    ch: { can: g.disc.length > 0 && (g.cheats[p.id] || 0) < 2 && g.cb[p.id] !== g.bout && !p.out, sus: !!g.sus[p.id] }
  };
}
const sendG = r => r.pl.forEach(p => tx(usr(p.id), view(r, p)));
const dRoom = u => { const r = rooms[u.room]; return r && r.g && r.kind == 'durak' ? r : null };
const dEv = (r, m) => r.pl.forEach(p => tx(usr(p.id), { t: 'ev', m }));
function pay(from, to, n) { const a = Math.min(n, from.bal); from.bal -= a; to.bal += a; me(from); me(to); save(); return a }
function cheat(u) {
  const r = dRoom(u); if (!r) return; const g = r.g, p = r.pl.find(x => x.id === u.id);
  if (p.out || !g.disc.length) return err(u, 'Нечего подменять: бито пусто');
  if ((g.cheats[u.id] || 0) >= 2 || g.cb[u.id] === g.bout) return err(u, 'Шулерить можно не чаще раза за ход (2 раза за игру)');
  const c = g.disc.splice(rnd(g.disc.length), 1)[0];
  p.hand.push(c); srt(p, g.ts); g.cheats[u.id] = (g.cheats[u.id] || 0) + 1; g.cb[u.id] = g.bout; g.sus[u.id] = g.bout;
  tx(u, { t: 'ev', m: 'Карта из рукава у тебя! Не попадись', me: 1 }); sendG(r);
}
function accuse(u, m) {
  const r = dRoom(u); if (!r) return; const g = r.g, t = r.pl.find(x => x.id === m.to);
  if (!t || t.id === u.id) return;
  if (g.ab[u.id] === g.bout) return err(u, 'Обвинять можно раз за ход');
  g.ab[u.id] = g.bout;
  if (g.sus[t.id] && g.sus[t.id] >= g.bout - 1) {
    delete g.sus[t.id]; if (t.hand.length) g.disc.push(t.hand.splice(rnd(t.hand.length), 1)[0]);
    dEv(r, u.name + ' поймал шулера ' + t.name + '! Штраф ' + pay(usr(t.id), u, r.bet) + ' ₽');
  } else dEv(r, u.name + ' ложно обвинил ' + t.name + ' и заплатил ' + pay(u, usr(t.id), Math.ceil(r.bet / 2)) + ' ₽');
  sendG(r);
}

/* ---------- Crash: общий раунд ---------- */
const CRS = { ph: 'wait', t0: Date.now(), cp: 1, hist: [], bets: new Map(), subs: new Set() };
const newCp = () => Math.min(200, Math.max(1, Math.floor(95 / (1 - Math.random())) / 100));
const crView = () => ({ t: 'cr', hist: CRS.hist, ph: CRS.ph, age: Date.now() - CRS.t0, cp: CRS.ph == 'crash' ? CRS.cp : undefined, pl: [...CRS.bets.values()].map(x => ({ n: x.name, b: x.b, c: x.c || 0 })) });
function crCash(x, m) { x.c = m; tx(x.u, { t: 'cwin', n: Math.floor(x.b * m), m }) }
setInterval(() => {
  const now = Date.now(), age = now - CRS.t0;
  if (CRS.ph == 'wait' && age >= 7000) { CRS.ph = 'run'; CRS.t0 = now; CRS.cp = newCp() }
  else if (CRS.ph == 'run') {
    const m = Math.exp(age / 5000);
    for (const x of CRS.bets.values()) if (!x.c && x.au >= 1.1 && x.au < CRS.cp && m >= x.au) crCash(x, x.au);
    if (m >= CRS.cp) { CRS.ph = 'crash'; CRS.t0 = now; CRS.hist.unshift(CRS.cp); CRS.hist = CRS.hist.slice(0, 12) }
  } else if (CRS.ph == 'crash' && age >= 3500) { CRS.ph = 'wait'; CRS.t0 = now; CRS.bets.clear() }
  if (CRS.subs.size) { const s = JSON.stringify(crView()); CRS.subs.forEach(u => u.ws && u.ws.readyState == 1 && u.ws.send(s)) }
}, 100);

/* ---------- админ ---------- */
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length == b.length && crypto.timingSafeEqual(a, b) };
function admin(ws, m) {
  if (Date.now() < (ws.lockUntil || 0)) return;
  if (!ADMIN_PW || !safeEq(m.pw, ADMIN_PW)) { if ((ws.fails = (ws.fails || 0) + 1) >= 5) { ws.lockUntil = Date.now() + 60000; ws.fails = 0 } return tx({ ws }, { t: 'admr', bad: 1 }) }
  ws.adm = 1;
  const R = s => tx({ ws }, { t: 'admr', m: s }), T = () => usr(m.id) || findU(m.id);
  const list = () => {
    const q = String(m.q || '').toLowerCase();
    const u = Object.values(db.users).filter(x => q == '#ban' ? x.ban : !q || (x.name + ' ' + x.id + ' ' + x.username).toLowerCase().includes(q))
      .sort((a, b) => (!!b.ws - !!a.ws) || a.name.localeCompare(b.name)).slice(0, 60)
      .map(x => ({ id: x.id, name: x.name, username: x.username, bal: x.bal, gb: x.gb, ban: x.ban, on: x.ws ? 1 : 0 }));
    const o = db.orders.filter(x => x.st == 'new').map(x => ({ id: x.id, k: x.k, uid: x.uid, name: x.name, rub: x.rub }));
    tx({ ws }, { t: 'adml', u, o, lk: {} });
  };
  if (m.op == 'list') return list();
  const u = T();
  switch (m.op) {
    case 'bank': if (!u) return R('Игрок не найден'); u.bal = Math.max(0, u.bal + Math.floor(+m.n || 0)); me(u); save(); return R('Банк: ' + u.bal);
    case 'game': if (!u) return R('Игрок не найден'); { const n = Math.floor(+m.n || 0); u.gb = Math.max(0, (u.gb || 0) + n); deliver(u, { t: 'gadj', n }); save(); return R('Игровой баланс изменён') }
    case 'zero': if (!u) return R('Игрок не найден'); if (m.w == 'bank') { u.bal = 0; me(u) } else { u.gb = 0; deliver(u, { t: 'gadj', n: -1e15 }) } save(); return R('Обнулено');
    case 'ban': if (!u) return R('Игрок не найден'); u.ban = m.v ? 1 : 0; u.why = String(m.r || '').slice(0, 100); if (u.ban) { leaveRoom(u); tx(u, { t: 'ban', m: u.why }) } save(); return R(u.ban ? 'Забанен' : 'Разбанен');
    case 'grant': if (!u || !CAT[m.k]) return R('Игрок или предмет не найден'); grant(u, m.k); return R('Выдано');
    case 'ordd': {
      const o = db.orders.find(x => x.id == m.oid && x.st == 'new'); if (!o) return R('Заказ не найден');
      o.st = m.yes ? 'ok' : 'no'; const t = usr(o.uid);
      if (t) { deliver(t, { t: 'ordr', id: o.id, ok: m.yes ? 1 : 0 }); if (m.yes) grant(t, o.k) } save(); return R(m.yes ? 'Выдано' : 'Отклонено');
    }
    default: return R('Эта функция не поддерживается сервером');
  }
}

/* ---------- обработка сообщений ---------- */
function auth(ws, m) {
  const tu = tgUser(m.init); let id, name, un = '';
  if (tu) { id = String(tu.id); name = [tu.first_name, tu.last_name].filter(Boolean).join(' ') || tu.username || 'Игрок'; un = tu.username || '' }
  else if (DEV && m.name) { name = String(m.name).slice(0, 20); id = 'dev_' + name.replace(/\W/g, '') }
  else return ws.send(JSON.stringify({ t: 'err', m: 'Не удалось войти через Telegram' }));
  const u = getU(id, name, un);
  if (u.ws && u.ws !== ws) { try { u.ws.close() } catch (e) {} }
  clearTimeout(u.dc); u.ws = ws; ws.u = u; save();
  me(u); tx(u, { t: 'cfg', lk: {} });
  if (u.ban) return tx(u, { t: 'ban', m: u.why });
  u.q.splice(0).forEach(o => tx(u, o));
  const r = rooms[u.room]; if (r) { if (r.g && r.kind == 'durak') tx(u, view(r, r.pl.find(p => p.id == u.id))); else if (!r.started) sendRoom(r) }
}
async function onMsg(ws, m) {
  if (m.t == 'auth') return auth(ws, m);
  const u = ws.u; if (!u || u.ban) return;
  const n = Math.floor(+m.n), r = rooms[u.room];
  switch (m.t) {
    case 'gb': u.gb = Math.max(0, Math.floor(+m.bal) || 0); break;
    case 'dep': if (n >= 1 && n <= 1e12) { u.bal += n; me(u); save() } break;
    case 'wd': if (n >= 1 && u.bal >= n) { u.bal -= n; tx(u, { t: 'wd', n }); me(u); save() } else err(u, 'Не хватает средств в банке'); break;
    case 'send': { const t = findU(m.to); if (!t || t.id == u.id) return err(u, 'Игрок не найден'); if (!(n >= 1) || u.bal < n) return err(u, 'Не хватает средств в банке'); u.bal -= n; t.bal += n; me(u); me(t); deliver(t, { t: 'in', from: u.name, n }); save(); break }
    case 'skins': if (Array.isArray(m.own)) m.own.filter(k => typeof k == 'string' && k.length < 8).forEach(k => { if (!u.skins.includes(k)) u.skins.push(k) }); if (u.skins.includes(m.sel)) u.sel = m.sel; me(u); save(); break;
    case 'mk': mk(u, m); break;
    case 'jn': jn(u, m); break;
    case 'start': if (r && !r.started && r.kind == 'durak' && r.host == u.id && r.pl.length >= 2) { r.max = r.pl.length; dStart(r) } break;
    case 'leave': if (u.room) leaveRoom(u); break;
    case 'play': if (r && r.g) { const i = r.pl.findIndex(p => p.id == u.id); if (i >= 0) play(r, i, m) } break;
    case 'act': if (r && r.g) { const i = r.pl.findIndex(p => p.id == u.id); if (i >= 0) act(r, i) } break;
    case 'cheat': cheat(u); break;
    case 'acc': accuse(u, m); break;
    case 'st': if (r && EM.includes(m.e)) r.pl.forEach(p => { if (p.id != u.id) tx(usr(p.id), { t: 'stk', id: u.id, e: m.e }) }); break;
    case 'mv': if (r && r.started && r.kind != 'durak' && !r.over) r.pl.forEach(p => { if (p.id != u.id) tx(usr(p.id), { t: 'mv', m: m.m }) }); break;
    case 'gres': if (r && r.started && r.kind != 'durak') boardEnd(r, m.r == 'draw' ? { draw: 1 } : { loser: u.id }); break;
    case 'csub': CRS.subs.add(u); tx(u, crView()); break;
    case 'cunsub': CRS.subs.delete(u); break;
    case 'cbet': { const b = Math.floor(+m.n); if (CRS.ph == 'wait' && !CRS.bets.has(u.id) && b >= 1 && b <= 1e12) CRS.bets.set(u.id, { u, name: u.name, b, au: +m.au || 0, c: 0 }); break }
    case 'ccash': { const x = CRS.bets.get(u.id), mm = Math.exp((Date.now() - CRS.t0) / 5000); if (CRS.ph == 'run' && x && !x.c && mm < CRS.cp) crCash(x, mm); break }
    case 'adm': admin(ws, m); break;
    case 'ord': {
      const it = CAT[m.k]; if (!it || typeof m.id != 'string' || m.id.length > 12 || db.orders.some(o => o.id == m.id)) return;
      const o = { id: m.id, k: m.k, uid: u.id, name: u.name, rub: it.rub, st: 'new', t: Date.now() }; db.orders.push(o); save();
      wss.clients.forEach(c => { if (c.adm) c.send(JSON.stringify({ t: 'ordn', o: { id: o.id, k: o.k, uid: o.uid, name: o.name, rub: o.rub } })) }); break;
    }
    case 'inv': {
      const it = CAT[m.k]; if (!TOKEN || !it) return err(u, 'Оплата Stars недоступна');
      if (!it.pack && u.skins.includes(m.k)) return err(u, 'Уже куплено');
      const j = await api('createInvoiceLink', { title: it.name.slice(0, 32), description: it.name + (it.pack ? '. Виртуальная валюта, не настоящие деньги.' : '. Косметический предмет.'), payload: u.id + '|' + m.k + '|' + rid(), currency: 'XTR', prices: [{ label: it.name.slice(0, 32), amount: it.st }] });
      if (j.ok) tx(u, { t: 'inv', url: j.result }); else err(u, 'Не удалось создать счёт'); break;
    }
  }
}

/* ---------- HTTP + WebSocket ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };
const server = http.createServer((q, s) => {
  const p = q.url.split('?')[0], f = p == '/' || p == '/index.html' ? 'index.html' : p == '/qr.png' ? 'qr.png' : null, fp = f && path.join(__dirname, 'public', f);
  if (fp && fs.existsSync(fp)) { s.writeHead(200, { 'Content-Type': MIME[path.extname(f)] }); return fs.createReadStream(fp).pipe(s) }
  s.writeHead(200, { 'Content-Type': 'text/plain' }); s.end('ok');
});
const wss = new WebSocketServer({ server, maxPayload: 16384 });
wss.on('connection', ws => {
  ws.cnt = 0;
  ws.on('message', d => {
    if (++ws.cnt > 40) return;
    let m; try { m = JSON.parse(d) } catch (e) { return }
    if (m && typeof m.t == 'string') onMsg(ws, m).catch(e => console.error('msg', m.t, e.message));
  });
  ws.on('close', () => {
    const u = ws.u; if (!u || u.ws !== ws) return;
    u.ws = null; CRS.subs.delete(u);
    u.dc = setTimeout(() => { if (!u.ws && u.room) leaveRoom(u) }, 45000);
  });
  ws.on('error', () => {});
});
setInterval(() => wss.clients.forEach(c => c.cnt = 0), 1000);
server.listen(PORT, () => console.log('Lucky Nova server on :' + PORT));
poll();
