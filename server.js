/* Lucky Nova / Nova Aurum: сервер (WebSocket + HTTP).
   Запуск: npm i && node server.js
   Переменные окружения:
     PORT         порт (Render ставит сам)
     ADMIN_PW     пароль админ-панели (обязательно задай свой)
     BOT_TOKEN    токен бота Telegram (проверка initData и оплата Stars)
     DATA_FILE    путь к файлу данных (по умолчанию ./data.json; на Render подключи Disk)
     ALLOW_DEV=1  разрешить вход без Telegram по ?dev=имя (только для тестов)
*/
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = +process.env.PORT || 3000;
const ADMIN_PW = process.env.ADMIN_PW || "11642323";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const ALLOW_DEV = process.env.ALLOW_DEV === "1";
const HW_RE = /^[a-z0-9_]{2,24}$/; // id игр из вкладки «Игры»

/* ---------- каталог (совпадает с клиентом) ---------- */
const PK = { p1: [1000, 10, 1], p2: [5000, 50, 5], p3: [15000, 150, 15], p4: [50000, 500, 50] };
const RUB = { k1: 10, k2: 20, k4: 30, k5: 40, k7: 50, k6: 60, k3: 70, k8: 80, k9: 90, k10: 100, k11: 110, k12: 120, k13: 130, k14: 140, k15: 150, bt1: 10, bt2: 20, bt3: 30, bt4: 40, bt5: 50, bt6: 60, bt7: 70, bt8: 80, bt9: 90, f1: 149, f2: 249, f3: 349 };
const FRAME_BONUS = { f1: 149, f2: 249, f3: 349 };
const starsOf = k => (PK[k] ? PK[k][2] : RUB[k] ? Math.ceil(RUB[k] / 2) : 0);

/* ---------- хранилище ---------- */
const users = new Map(); // id -> user
let orders = {}; // id -> {id,k,rub,uid,name,ts}
let LK = {}; // коэффициенты выплат
try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  (d.users || []).forEach(u => users.set(String(u.id), mkUser(u)));
  orders = d.orders || {};
  LK = d.lk || {};
  console.log("данные загружены:", users.size, "игроков");
} catch (e) { console.log("новый файл данных"); }
function mkUser(u) {
  return { id: String(u.id), name: u.name || "Игрок", username: u.username || "", bal: u.bal | 0, skins: u.skins && u.skins.length ? u.skins : ["k0"], sel: u.sel || "k0", gb: u.gb == null ? null : u.gb, ban: !!u.ban, banr: u.banr || "", hw: u.hw || [], revq: u.revq || [], paid: u.paid || {}, ws: null, room: null, off: null };
}
let saveT = null;
function save() {
  if (saveT) return;
  saveT = setTimeout(() => {
    saveT = null;
    const out = { users: [...users.values()].map(u => ({ id: u.id, name: u.name, username: u.username, bal: u.bal, skins: u.skins, sel: u.sel, gb: u.gb, ban: u.ban, banr: u.banr, hw: u.hw, revq: u.revq, paid: u.paid })), orders, lk: LK };
    try { fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(out)); fs.renameSync(DATA_FILE + ".tmp", DATA_FILE); } catch (e) { console.error("save", e.message); }
  }, 1500);
}
const getUser = id => users.get(String(id));
function ensureUser(id, name, username) {
  id = String(id);
  let u = users.get(id);
  if (!u) { u = mkUser({ id, name, username }); users.set(id, u); }
  else { if (name) u.name = name; if (username != null) u.username = username; }
  return u;
}

/* ---------- отправка ---------- */
const sendRaw = (u, o) => { if (u && u.ws && u.ws.readyState === 1) { try { u.ws.send(JSON.stringify(o)); } catch (e) {} } };
const send = (id, o) => sendRaw(getUser(id), o);
const err = (id, m) => send(id, { t: "err", m });
const online = () => [...users.values()].filter(u => u.ws && u.ws.readyState === 1);
const broadcast = o => online().forEach(u => sendRaw(u, o));
const me = u => sendRaw(u, { t: "me", bal: u.bal, skins: u.skins, sel: u.sel, id: u.id, name: u.name });
const push = u => me(typeof u === "string" ? getUser(u) : u);
const bcOnline = () => broadcast({ t: "on", n: online().length });

/* ---------- дурак (движок) ---------- */
const rk = c => c % 9, su = c => Math.floor(c / 9);
const beats = (a, d, ts) => su(a) === su(d) ? rk(d) > rk(a) : su(d) === ts && su(a) !== ts;
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const ROOMS = new Map();
const alive = r => r.pl.filter(p => !p.out);
const nxt = (r, i) => { for (let k = 1; k <= r.pl.length; k++) { const j = (i + k) % r.pl.length; if (!r.pl[j].out) return j; } return i; };
const srt = (p, ts) => p.hand.sort((a, b) => (su(a) === ts) - (su(b) === ts) || su(a) - su(b) || rk(a) - rk(b));
function dkStart(r) {
  const deck = shuffle(Array.from({ length: 36 }, (_, i) => i)), ts = su(deck[0]);
  r.pl.forEach(p => { p.skin = getUser(p.id).sel; p.out = 0; p.hand = deck.splice(deck.length - 6, 6); });
  let att = Math.floor(Math.random() * r.pl.length), best = 99;
  r.pl.forEach((p, i) => p.hand.forEach(c => { if (su(c) === ts && rk(c) < best) { best = rk(c); att = i; } }));
  r.started = true;
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
function dkPlay(r, i, m) {
  const g = r.g, p = r.pl[i], c = p.hand[m.c];
  if (c == null || p.out) return;
  if (i === g.def) {
    if (g.tk) return err(p.id, "Ты уже берёшь карты");
    let t = Number.isInteger(m.tgt) && g.tb[m.tgt] && g.tb[m.tgt].d == null ? m.tgt : g.tb.findIndex(x => x.d == null && beats(x.a, c, g.ts));
    if (t < 0 || !g.tb[t] || g.tb[t].d != null || !beats(g.tb[t].a, c, g.ts)) return err(p.id, "Этой картой не побить");
    g.tb[t].d = c; g.tb[t].ds = p.skin;
  } else {
    if (!canThrow(r, i)) return err(p.id, "Сейчас подкидывать нельзя");
    if (g.tb.length && !g.tb.some(x => rk(x.a) === rk(c) || (x.d != null && rk(x.d) === rk(c)))) return err(p.id, "Такого ранга нет на столе");
    g.tb.push({ a: c, as: p.skin, d: null });
  }
  p.hand.splice(m.c, 1); g.conf = { a: 0, d: 0 }; g.done = {}; settle(r);
}
function dkAct(r, i) {
  const g = r.g, open = g.tb.some(x => x.d == null), beaten = g.tb.length && !open;
  if (i === g.def) {
    if (open && !g.tk) { g.tk = 1; g.done = {}; }
    else if (beaten && g.conf.a && !g.conf.d) g.conf.d = 1;
  } else if (g.tk) g.done[i] = 1;
  else if (i === g.att && beaten && !g.conf.a) g.conf.a = 1;
  settle(r);
}
function settle(r) {
  const g = r.g;
  if (g.tk) {
    const pend = r.pl.some((p, j) => j !== g.def && canThrow(r, j) && !g.done[j]);
    if (!pend) { const d = r.pl[g.def]; g.tb.forEach(x => { d.hand.push(x.a); if (x.d != null) d.hand.push(x.d); }); g.tb = []; return endBout(r, 1); }
  } else if (g.conf.a && g.conf.d && g.tb.length && g.tb.every(x => x.d != null)) {
    g.tb.forEach(x => g.disc.push(x.a, x.d)); g.tb = []; return endBout(r, 0);
  }
  sendG(r);
}
function endBout(r, took) {
  const g = r.g; g.tk = 0; g.conf = { a: 0, d: 0 }; g.done = {}; g.bout++;
  const ord = []; for (let k = 0; k < r.pl.length; k++) ord.push((g.att + k) % r.pl.length);
  ord.filter(j => j !== g.def).concat([g.def]).forEach(j => { const p = r.pl[j]; while (!p.out && p.hand.length < 6 && g.deck.length) p.hand.push(g.deck.pop()); });
  r.pl.forEach(p => { if (!p.out && !p.hand.length && !g.deck.length) p.out = 1; srt(p, g.ts); });
  const al = alive(r); if (al.length <= 1) return dkFinish(r, al[0]);
  g.att = took || r.pl[g.def].out ? nxt(r, g.def) : g.def; g.def = nxt(r, g.att); g.lim = Math.min(6, r.pl[g.def].hand.length);
  sendG(r);
}
function dkFinish(r, loser) {
  const n = r.pl.length, bonus = Math.floor(r.bet / (n - 1));
  r.pl.forEach(p => {
    const u = getUser(p.id); let win = 2, amt = r.bet;
    if (loser && p.id === loser.id) { win = 0; amt = 0; } else if (loser) { win = 1; amt = r.bet + bonus; }
    u.bal += amt; send(p.id, { t: "end", win, n: amt, durak: loser ? loser.name : "" }); push(u);
  });
  closeRoom(r);
}
function dkAbandon(r, id) {
  const n = r.pl.length, bonus = Math.floor(r.bet / (n - 1));
  r.pl.forEach(p => { const u = getUser(p.id), mine = p.id === id, amt = mine ? 0 : r.bet + bonus; u.bal += amt; send(p.id, { t: "end", win: mine ? 0 : 1, n: amt, durak: getUser(id).name, left: 1 }); push(u); });
  closeRoom(r);
}
function view(r, p) {
  const g = r.g, i = r.pl.indexOf(p), open = g.tb.filter(x => x.d == null).length, beaten = g.tb.length && !open, nm = j => r.pl[j].name;
  let a = null, tx = "Смотришь за игрой";
  if (!p.out) {
    if (i === g.def) {
      if (g.tk) tx = "Ты берёшь карты. Ждём подкидывающих";
      else if (open) { a = "take"; tx = "Отбивайся: перетащи карту на атакующую или нажми «Взять»"; }
      else if (beaten && g.conf.a && !g.conf.d) { a = "confirm"; tx = nm(g.att) + " сказал «бито». Подтверди"; }
      else if (beaten) tx = "Отбито. Ждём: подкинут или скажут «бито»";
      else tx = "Ходит " + nm(g.att);
    } else if (g.tk) {
      if (canThrow(r, i) && !g.done[i]) { a = "done"; tx = nm(g.def) + " берёт. Подкинь ещё или нажми «Готово»"; } else tx = "Ждём остальных";
    } else if (i === g.att) {
      if (!g.tb.length) tx = "Твой ход: перетащи карту на стол";
      else if (open) tx = "Ждём, пока " + nm(g.def) + " отобьётся";
      else if (!g.conf.a) { a = "bito"; tx = "Подкинь ещё или нажми «Бито»"; }
      else tx = "Ждём подтверждения от " + nm(g.def);
    } else tx = canThrow(r, i) ? "Можешь подкинуть карту" : "Ждёшь";
  }
  return {
    t: "g", bet: r.bet, dn: g.deck.length, tc: g.tc, ts: g.ts, di: g.disc.length, tb: g.tb, tk: g.tk, h: p.hand, skin: p.skin, act: a, tx, me: p.id, out: p.out,
    pl: plView(r),
    ch: { can: g.disc.length > 0 && (g.cheats[p.id] || 0) < 2 && g.cb[p.id] !== g.bout && !p.out, sus: !!g.sus[p.id] }
  };
}
const plView = r => { const g = r.g; return r.pl.map((x, j) => ({ id: x.id, name: x.name, skin: x.skin, n: x.hand.length, out: x.out, role: j === g.att ? "a" : j === g.def ? "d" : "t", ok: j === g.att ? g.conf.a : j === g.def ? g.conf.d : g.done[j] ? 1 : 0 })); };
const specView = r => { const g = r.g; return { t: "g", spec: 1, bet: r.bet, dn: g.deck.length, tc: g.tc, ts: g.ts, di: g.disc.length, tb: g.tb, tk: g.tk, h: [], skin: "k0", act: null, tx: "", me: "", out: 1, pl: plView(r), ch: { can: false, sus: false } }; };
function sendG(r) { r.pl.forEach(p => send(p.id, view(r, p))); r.sp.forEach(id => send(id, specView(r))); }
function dkEv(r, m) { r.pl.forEach(p => send(p.id, { t: "ev", m })); }
function pay(from, to, n) { const a = Math.min(n, from.bal); from.bal -= a; to.bal += a; push(from); push(to); save(); return a; }
function dkCheat(u) {
  const r = u.room && u.room.g ? u.room : null; if (!r || r.kind !== "durak") return; const g = r.g, p = r.pl.find(x => x.id === u.id);
  if (!p || p.out || !g.disc.length) return err(u.id, "Нечего подменять: бито пусто");
  if ((g.cheats[u.id] || 0) >= 2 || g.cb[u.id] === g.bout) return err(u.id, "Шулерить можно не чаще раза за ход (2 раза за игру)");
  const c = g.disc.splice(Math.floor(Math.random() * g.disc.length), 1)[0];
  p.hand.push(c); srt(p, g.ts); g.cheats[u.id] = (g.cheats[u.id] || 0) + 1; g.cb[u.id] = g.bout; g.sus[u.id] = g.bout;
  send(u.id, { t: "ev", m: "Карта из рукава у тебя! Не попадись", me: 1 }); sendG(r);
}
function dkAcc(u, m) {
  const r = u.room && u.room.g ? u.room : null; if (!r || r.kind !== "durak") return; const g = r.g, t = r.pl.find(x => x.id === String(m.to));
  if (!t || t.id === u.id) return;
  if (g.ab[u.id] === g.bout) return err(u.id, "Обвинять можно раз за ход");
  g.ab[u.id] = g.bout;
  if (g.sus[t.id] && g.sus[t.id] >= g.bout - 1) {
    delete g.sus[t.id]; if (t.hand.length) g.disc.push(t.hand.splice(Math.floor(Math.random() * t.hand.length), 1)[0]);
    const a = pay(getUser(t.id), u, r.bet); dkEv(r, u.name + " поймал шулера " + t.name + "! Штраф " + a + " 🪙");
  } else { const a = pay(u, getUser(t.id), Math.ceil(r.bet / 2)); dkEv(r, u.name + " ложно обвинил " + t.name + " и заплатил " + a + " 🪙"); }
  sendG(r);
}

/* ---------- комнаты: дурак / шахматы / шашки ---------- */
const roomMsg = r => ({ t: "room", code: r.code, kind: r.kind, bet: r.bet, max: r.max, host: r.host, pl: r.pl.map(p => ({ id: p.id, name: p.name, skin: getUser(p.id).sel })) });
const roomSend = r => r.pl.forEach(p => send(p.id, roomMsg(r)));
function newCode() { const A = "ABCDEFGHJKLMNPQRSTUVWXYZ"; let c; do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(""); } while (ROOMS.has(c)); return c; }
function closeRoom(r) {
  ROOMS.delete(r.code);
  r.pl.forEach(p => { const u = getUser(p.id); if (u && u.room === r) u.room = null; });
  r.sp.forEach(id => { const u = getUser(id); if (u) { u.room = null; send(id, { t: "specend", m: "Игра закончилась" }); } });
  r.sp.clear(); save();
}
function mkRoom(u, m) {
  if (u.room) return err(u.id, "Ты уже за столом. Сначала выйди");
  const kind = ["durak", "chess", "checkers"].includes(m.kind) ? m.kind : "durak";
  const bet = Math.max(0, Math.min(1e9, Math.floor(+m.n || 0)));
  const max = kind === "durak" ? Math.max(2, Math.min(4, Math.floor(+m.max || 2))) : 2;
  if (u.bal < bet) return err(u.id, "Недостаточно средств в банке");
  u.bal -= bet;
  const r = { code: newCode(), kind, bet, max, host: u.id, pl: [{ id: u.id, name: u.name, hand: [], out: 0 }], sp: new Set(), g: null, started: false, hist: [] };
  ROOMS.set(r.code, r); u.room = r; push(u); roomSend(r);
}
function joinRoom(u, m) {
  if (u.room) return err(u.id, "Ты уже за столом");
  const r = ROOMS.get(String(m.code || "").toUpperCase());
  if (!r) return err(u.id, "Стол не найден");
  if (r.started) return err(u.id, "Игра уже идёт");
  if (r.pl.length >= r.max) return err(u.id, "Стол заполнен");
  if (u.bal < r.bet) return err(u.id, "Недостаточно средств в банке");
  u.bal -= r.bet; r.pl.push({ id: u.id, name: u.name, hand: [], out: 0 }); u.room = r; push(u); roomSend(r);
  if (r.kind !== "durak" && r.pl.length === r.max) boardStart(r);
}
function boardStart(r) {
  r.started = true; if (Math.random() < .5) r.pl.reverse(); // pl[0] — белые
  r.pl.forEach((p, i) => send(p.id, { t: "gstart", kind: r.kind, side: i === 0 ? "w" : "b", opp: r.pl[1 - i].name, bet: r.bet }));
}
function leaveRoom(u, forced) {
  const r = u.room; if (!r) return;
  if (r.sp.has(u.id)) { r.sp.delete(u.id); u.room = null; return; }
  if (!r.started) {
    r.pl = r.pl.filter(p => p.id !== u.id); u.bal += r.bet; u.room = null; push(u);
    if (!r.pl.length || r.host === u.id) { r.pl.forEach(p => { const o = getUser(p.id); o.bal += r.bet; o.room = null; push(o); send(p.id, { t: "room" }); }); ROOMS.delete(r.code); }
    else roomSend(r);
    send(u.id, { t: "room" }); save(); return;
  }
  if (r.kind === "durak") return dkAbandon(r, u.id);
  boardEnd(r, u.id, "lose", true);
}
function boardEnd(r, loserId, how, left) {
  if (!ROOMS.has(r.code)) return;
  r.pl.forEach(p => {
    const o = getUser(p.id); let win, n = 0;
    if (how === "draw") { win = 2; n = r.bet; } else if (p.id === loserId) { win = 0; } else { win = 1; n = r.bet * 2; }
    o.bal += n; const m = { t: "end", kind: r.kind, win, n }; if (left) m.left = 1; send(p.id, m); push(o);
  });
  closeRoom(r);
}
function startDurak(u) {
  const r = u.room; if (!r || r.kind !== "durak" || r.started) return;
  if (r.host !== u.id) return err(u.id, "Запускает хозяин стола");
  if (r.pl.length < 2) return err(u.id, "Нужно минимум два игрока");
  r.max = r.pl.length; dkStart(r);
}
function roomsList(kind) {
  return [...ROOMS.values()].filter(r => r.started && r.kind === kind).map(r => ({ code: r.code, pl: r.pl.map(p => p.name), bet: r.bet, sp: r.sp.size }));
}
function watch(u, m) {
  if (u.room) return err(u.id, "Сначала выйди из текущей игры");
  const r = ROOMS.get(String(m.code || "").toUpperCase());
  if (!r || !r.started) return err(u.id, "Игра не найдена");
  r.sp.add(u.id); u.room = r;
  if (r.kind === "durak") send(u.id, specView(r));
  else send(u.id, { t: "spec", kind: r.kind, bet: r.bet, pl: r.pl.map(p => p.name), hist: r.hist });
}

/* ---------- общий краш ---------- */
const CR = { ph: "wait", t0: Date.now(), cp: 2, hist: [], bets: new Map(), subs: new Set(), last: 0 };
const crAge = () => Date.now() - CR.t0;
const crMult = () => Math.exp(crAge() / 5000);
function crState() {
  return { t: "cr", hist: CR.hist.slice(-14), ph: CR.ph, age: crAge(), cp: CR.cp, pl: [...CR.bets.values()].map(b => ({ n: b.name, b: b.n, c: b.c })) };
}
function crPush() { const s = crState(); CR.subs.forEach(id => { const o = s; if (CR.ph !== "crash" && CR.ph !== "run") o.cp = 0; send(id, o); }); }
function crPoint() {
  if (abuse.on) return 80 + Math.random() * 120;
  const r = Math.random(); return Math.min(1000, Math.max(1, Math.floor(100 * 0.96 / (1 - r)) / 100));
}
function crCash(id, forced) {
  const b = CR.bets.get(id); if (!b || b.c > 0 || CR.ph !== "run") return;
  const m = forced ? Math.min(forced, CR.cp) : Math.min(crMult(), CR.cp);
  b.c = +m.toFixed(2);
  const k = (LK.crash == null ? 1 : LK.crash) * (abuse.on ? abuse.mult : 1);
  send(id, { t: "cwin", n: Math.floor(b.n * b.c * k), m: b.c }); crPush();
}
function crLoop() {
  const age = crAge();
  if (CR.ph === "wait" && age >= 7000) { CR.ph = "run"; CR.t0 = Date.now(); CR.cp = crPoint(); crPush(); }
  else if (CR.ph === "run") {
    const m = crMult();
    CR.bets.forEach((b, id) => { if (!b.c && b.au > 1 && m >= b.au && b.au <= CR.cp) crCash(id, b.au); });
    if (m >= CR.cp) { CR.ph = "crash"; CR.t0 = Date.now(); CR.hist.push(+CR.cp.toFixed(2)); crPush(); }
    else if (Date.now() - CR.last > 700) { CR.last = Date.now(); crPush(); }
  } else if (CR.ph === "crash" && age >= 3500) { CR.ph = "wait"; CR.t0 = Date.now(); CR.bets.clear(); CR.cp = 2; crPush(); }
  else if (CR.ph === "wait" && Date.now() - CR.last > 1000) { CR.last = Date.now(); crPush(); }
}
setInterval(crLoop, 100);

/* ---------- админ-абьюз ---------- */
const abuse = { on: 0, mult: 10, until: 0, timer: null };
function abuseSet(v, mult) {
  clearTimeout(abuse.timer);
  if (v) {
    abuse.on = 1; abuse.mult = Math.max(1, Math.min(1e6, +mult || 10)); abuse.until = Date.now() + 185000;
    broadcast({ t: "abuse", on: 1, mult: abuse.mult, cd: 1, run: 180000 });
    abuse.timer = setTimeout(() => abuseSet(0), 185000);
  } else { abuse.on = 0; broadcast({ t: "abuse", on: 0 }); }
}

/* ---------- заказы и платежи ---------- */
function giveItem(u, k) {
  if (PK[k]) { u.bal += 0; return PK[k][0]; } // валюта идёт в игровой баланс на клиенте (paid.n)
  if (!u.skins.includes(k)) u.skins.push(k);
  return FRAME_BONUS[k] || 0;
}
function deliver(u, k, oid) {
  const n = giveItem(u, k);
  sendRaw(u, { t: "paid", n, k }); me(u); if (oid) sendRaw(u, { t: "ordr", id: oid, ok: 1 });
  save();
}
async function tg(method, body) {
  const r = await fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/" + method, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
async function makeInvoice(u, k) {
  if (!BOT_TOKEN) return err(u.id, "Оплата Stars не настроена на сервере");
  const stars = starsOf(k); if (!stars) return err(u.id, "Неизвестный товар");
  const name = PK[k] ? "Игровая валюта " + PK[k][0] : "Предмет " + k;
  try {
    const j = await tg("createInvoiceLink", { title: name.slice(0, 32), description: "Виртуальный предмет для игры (не настоящие деньги)", payload: u.id + "|" + k + "|" + Date.now(), currency: "XTR", prices: [{ label: name.slice(0, 32), amount: stars }] });
    if (j.ok) sendRaw(u, { t: "inv", url: j.result }); else err(u.id, "Не удалось создать счёт");
  } catch (e) { err(u.id, "Telegram недоступен"); }
}
let upOff = 0;
async function pollTg() {
  if (!BOT_TOKEN) return;
  try { await tg("deleteWebhook", {}); } catch (e) {}
  for (;;) {
    try {
      const j = await tg("getUpdates", { offset: upOff, timeout: 25, allowed_updates: ["pre_checkout_query", "message"] });
      for (const up of j.result || []) {
        upOff = up.update_id + 1;
        if (up.pre_checkout_query) await tg("answerPreCheckoutQuery", { pre_checkout_query_id: up.pre_checkout_query.id, ok: true });
        const sp = up.message && up.message.successful_payment;
        if (sp) {
          const [uid, k] = String(sp.invoice_payload).split("|"), u = getUser(uid);
          if (u && !u.paid[sp.telegram_payment_charge_id]) { u.paid[sp.telegram_payment_charge_id] = 1; deliver(u, k); }
        }
      }
    } catch (e) { await new Promise(r => setTimeout(r, 4000)); }
  }
}

/* ---------- админка ---------- */
const admins = new Set();
const adminList = q => {
  q = String(q || "").toLowerCase();
  let l = [...users.values()];
  if (q === "#ban") l = l.filter(u => u.ban);
  else if (q) l = l.filter(u => u.name.toLowerCase().includes(q) || u.id === q || (u.username && u.username.toLowerCase().includes(q.replace(/^@/, ""))));
  l.sort((a, b) => (b.ws ? 1 : 0) - (a.ws ? 1 : 0) || b.bal - a.bal);
  return l.slice(0, 60).map(u => ({ id: u.id, name: u.name, username: u.username, bal: u.bal, gb: u.gb, on: !!(u.ws && u.ws.readyState === 1), ban: u.ban }));
};
const orderList = () => Object.values(orders).map(o => ({ id: o.id, k: o.k, rub: o.rub, uid: o.uid, name: o.name }));
function adminOp(u, m) {
  if (!ADMIN_PW || m.pw !== ADMIN_PW) { setTimeout(() => sendRaw(u, { t: "admr", bad: 1 }), 600); return; }
  admins.add(u.id);
  const ok = msg => sendRaw(u, { t: "admr", m: msg });
  const tu = m.id != null ? getUser(m.id) : null;
  const need = () => { if (!tu) { ok("Игрок не найден"); return false; } return true; };
  switch (m.op) {
    case "list": sendRaw(u, { t: "adml", u: adminList(m.q), o: orderList(), lk: LK }); return;
    case "bank": if (!need()) return; { const n = Math.floor(+m.n) || 0; tu.bal = Math.max(0, tu.bal + n); push(tu); save(); return ok("Банк: " + (n >= 0 ? "+" : "") + n + " → " + tu.bal); }
    case "game": if (!need()) return; { const n = Math.floor(+m.n) || 0; if (!(tu.ws && tu.ws.readyState === 1)) return ok("Игрок не в сети: игровой баланс хранится у него"); sendRaw(tu, { t: "gadj", n }); return ok("Игровой баланс " + (n >= 0 ? "+" : "") + n); }
    case "zero": if (!need()) return; if (m.w === "bank") { tu.bal = 0; push(tu); save(); return ok("Банк обнулён"); } if (!(tu.ws && tu.ws.readyState === 1)) return ok("Игрок не в сети"); sendRaw(tu, { t: "gadj", z: 1, n: 0 }); return ok("Игровой баланс обнулён");
    case "ban": if (!need()) return; tu.ban = !!m.v; tu.banr = String(m.r || "").slice(0, 200); if (tu.ban) { leaveRoom(tu); sendRaw(tu, { t: "ban", m: tu.banr }); } save(); return ok(tu.ban ? "Игрок забанен" : "Игрок разбанен");
    case "lk": { const k = String(m.k || ""); if (!k) return; LK[k] = Math.max(0, Math.min(5, +m.v)); if (isNaN(LK[k])) LK[k] = 1; broadcast({ t: "cfg", lk: LK }); save(); return ok("Шанс «" + k + "» = " + LK[k]); }
    case "grant": {
      if (!need()) return;
      const k = String(m.k || "");
      if (k.startsWith("hw:") || HW_RE.test(k) && !/^(k|bt|f)\d+$/.test(k) && !PK[k]) { return hwGive(tu, k.replace(/^hw:/, ""), ok); }
      if (!tu.skins.includes(k)) tu.skins.push(k); me(tu); save(); return ok("Предмет выдан: " + k);
    }
    case "hwgive": if (!need()) return; return hwGive(tu, String(m.k || ""), ok);
    case "hwtake": if (!need()) return; { const k = String(m.k || ""); tu.hw = tu.hw.filter(x => x !== k); sendRaw(tu, { t: "hwown", own: tu.hw, take: [k] }); save(); return ok("Игра забрана: " + k); }
    case "rev": if (!need()) return; { const ks = [].concat(m.k || []).map(String); tu.skins = tu.skins.filter(x => !ks.includes(x) || x === "k0"); if (tu.ws) sendRaw(tu, { t: "rev", k: ks }); else tu.revq = tu.revq.concat(ks); me(tu); save(); return ok("Предмет забран"); }
    case "xpr": if (m.id === "all") { broadcast({ t: "xpr" }); return ok("Уровни обнулены у всех"); } if (!need()) return; sendRaw(tu, { t: "xpr" }); return ok("Уровень обнулён");
    case "abuse": abuseSet(!!m.v, m.mult); return ok(m.v ? "Абьюз запущен" : "Абьюз выключен");
    case "ordd": {
      const o = orders[m.oid]; if (!o) return ok("Заказ не найден");
      const ou = getUser(o.uid); delete orders[m.oid];
      if (m.yes && ou) deliver(ou, o.k, o.id); else if (ou) sendRaw(ou, { t: "ordr", id: o.id, ok: 0 });
      save(); return ok(m.yes ? "Заказ выполнен" : "Заказ отклонён");
    }
    default: return ok("Неизвестная операция");
  }
}
function hwGive(tu, id, ok) {
  if (!HW_RE.test(id)) return ok("Неверный id игры");
  if (!tu.hw.includes(id)) tu.hw.push(id);
  sendRaw(tu, { t: "hwown", own: tu.hw }); save();
  return ok("🎮 Игра «" + id + "» выдана игроку " + tu.name);
}

/* ---------- авторизация Telegram ---------- */
function parseInit(init) {
  if (!init) return null;
  const p = new URLSearchParams(init), hash = p.get("hash");
  if (BOT_TOKEN) {
    p.delete("hash");
    const s = [...p.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
    const key = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const h = crypto.createHmac("sha256", key).update(s).digest("hex");
    if (h !== hash) return null;
    if (Date.now() / 1000 - (+p.get("auth_date") || 0) > 86400 * 7) return null;
  }
  try { const u = JSON.parse(p.get("user")); return { id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "Игрок", username: u.username || "" }; } catch (e) { return null; }
}
function onAuth(ws, m) {
  let info = parseInit(m.init);
  if (!info && ALLOW_DEV && m.name) info = { id: "dev_" + String(m.name).replace(/\W/g, "").slice(0, 20), name: String(m.name).slice(0, 24), username: "" };
  if (!info) { ws.send(JSON.stringify({ t: "err", m: "Открой игру из Telegram" })); return; }
  const u = ensureUser(info.id, info.name, info.username);
  if (u.ws && u.ws !== ws) { try { u.ws.close(); } catch (e) {} }
  u.ws = ws; ws.uid = u.id; clearTimeout(u.off); u.off = null; ws.lastAuth = Date.now();
  if (u.ban) { sendRaw(u, { t: "ban", m: u.banr }); return; }
  if (u.revq.length) { u.skins = u.skins.filter(x => !u.revq.includes(x) || x === "k0"); sendRaw(u, { t: "rev", k: u.revq }); u.revq = []; }
  me(u); sendRaw(u, { t: "cfg", lk: LK }); sendRaw(u, { t: "hwown", own: u.hw });
  if (abuse.on) sendRaw(u, { t: "abuse", on: 1, mult: abuse.mult, run: Math.max(1000, abuse.until - Date.now() - 5000) });
  if (u.room && u.room.started && u.room.kind === "durak" && u.room.g) sendG(u.room);
  else if (u.room && !u.room.started) roomSend(u.room);
  bcOnline(); save();
}

/* ---------- обработка сообщений ---------- */
function onMsg(ws, raw) {
  let m; try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m.t !== "string") return;
  if (m.t === "auth") return onAuth(ws, m);
  const u = ws.uid && getUser(ws.uid); if (!u || u.ws !== ws) return;
  if (u.ban && m.t !== "adm") return sendRaw(u, { t: "ban", m: u.banr });
  const n = Math.floor(+m.n);
  switch (m.t) {
    case "gb": if (isFinite(+m.bal)) { u.gb = Math.max(0, Math.floor(+m.bal)); save(); } break;
    case "skins": {
      if (Array.isArray(m.own)) m.own.forEach(k => { if (typeof k === "string" && k.length < 12 && !u.skins.includes(k) && (/^k\d+$/.test(k) || /^bt\d+$/.test(k) || /^f\d+$/.test(k)) && !RUB[k]) u.skins.push(k); });
      if (typeof m.sel === "string" && u.skins.includes(m.sel)) u.sel = m.sel; me(u); save(); break;
    }
    case "dep": if (n > 0) { u.bal += n; push(u); save(); } break;
    case "wd": { const a = Math.min(Math.max(0, n), u.bal); if (a > 0) { u.bal -= a; sendRaw(u, { t: "wd", n: a }); push(u); save(); } break; }
    case "send": {
      const to = String(m.to || "").trim().replace(/^@/, "").toLowerCase();
      const t = getUser(to) || [...users.values()].find(x => x.username && x.username.toLowerCase() === to);
      if (!t || t === u) return err(u.id, "Игрок не найден");
      if (!(n > 0) || n > u.bal) return err(u.id, "Недостаточно средств в банке");
      u.bal -= n; t.bal += n; push(u); push(t); sendRaw(t, { t: "in", from: u.name, n }); save(); break;
    }
    case "mk": mkRoom(u, m); break;
    case "jn": joinRoom(u, m); break;
    case "start": startDurak(u); break;
    case "leave": leaveRoom(u); break;
    case "rooms": sendRaw(u, { t: "rooms", list: roomsList(m.kind === "chess" || m.kind === "checkers" ? m.kind : "durak") }); break;
    case "watch": watch(u, m); break;
    case "play": { const r = u.room; if (r && r.g && r.kind === "durak") { const i = r.pl.findIndex(p => p.id === u.id); if (i >= 0) dkPlay(r, i, { c: m.c, tgt: m.tgt }); } break; }
    case "act": { const r = u.room; if (r && r.g && r.kind === "durak") { const i = r.pl.findIndex(p => p.id === u.id); if (i >= 0) dkAct(r, i); } break; }
    case "cheat": dkCheat(u); break;
    case "acc": dkAcc(u, m); break;
    case "st": {
      const r = u.room; if (!r || typeof m.e !== "string" || m.e.length > 8) break;
      const o = { t: "stk", id: u.id, e: m.e }; r.pl.forEach(p => { if (p.id !== u.id || r.kind === "durak") send(p.id, o); }); r.sp.forEach(id => send(id, o)); break;
    }
    case "mv": {
      const r = u.room; if (!r || !r.started || r.kind === "durak" || !r.pl.some(p => p.id === u.id)) break;
      r.hist.push(m.m); if (r.hist.length > 400) r.hist.shift();
      r.pl.forEach(p => { if (p.id !== u.id) send(p.id, { t: "mv", m: m.m }); }); r.sp.forEach(id => send(id, { t: "smv", m: m.m })); break;
    }
    case "gres": { const r = u.room; if (r && r.started && r.kind !== "durak" && r.pl.some(p => p.id === u.id)) boardEnd(r, u.id, m.r === "draw" ? "draw" : "lose"); break; }
    case "csub": CR.subs.add(u.id); send(u.id, crState()); break;
    case "cunsub": CR.subs.delete(u.id); break;
    case "cbet": {
      if (CR.ph !== "wait" || !(n > 0) || CR.bets.has(u.id)) return err(u.id, "Ставки принимаются перед раундом");
      CR.bets.set(u.id, { name: u.name, n: Math.min(n, 1e9), au: Math.max(0, +m.au || 0), c: 0 }); CR.subs.add(u.id); crPush(); break;
    }
    case "ccash": crCash(u.id); break;
    case "ord": {
      if (!RUB[m.k] && !PK[m.k]) return;
      const id = String(m.id || "").slice(0, 16); if (!id || orders[id]) return;
      orders[id] = { id, k: m.k, rub: RUB[m.k] || PK[m.k][1], uid: u.id, name: u.name, ts: Date.now() };
      admins.forEach(a => { const au = getUser(a); if (au) sendRaw(au, { t: "ordn", o: orderList().find(x => x.id === id) }); }); save(); break;
    }
    case "inv": makeInvoice(u, m.k); break;
    case "adm": adminOp(u, m); break;
  }
}
function onClose(ws) {
  const u = ws.uid && getUser(ws.uid); if (!u || u.ws !== ws) return;
  u.ws = null; CR.subs.delete(u.id); admins.delete(u.id); bcOnline();
  if (u.room && !u.room.started) leaveRoom(u);
  else if (u.room && u.room.started && !u.room.sp.has(u.id)) { u.off = setTimeout(() => { if (!u.ws && u.room) leaveRoom(u); }, 45000); }
  else if (u.room) u.room.sp.delete(u.id), u.room = null;
}

/* ---------- HTTP + WS ---------- */
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  if (url.pathname === "/hw/own") {
    if (req.method === "GET") {
      const u = getUser(url.searchParams.get("u"));
      res.writeHead(200, { ...CORS, "Content-Type": "application/json" }); return res.end(JSON.stringify({ own: u ? u.hw : [] }));
    }
    if (req.method === "POST") {
      let b = ""; req.on("data", c => { b += c; if (b.length > 20000) req.destroy(); });
      req.on("end", () => {
        try {
          const j = JSON.parse(b), u = getUser(j.u);
          // добавляем только новые игры: забрать игру может лишь админ
          if (u && Array.isArray(j.own)) { j.own.forEach(k => { if (typeof k === "string" && HW_RE.test(k) && !u.hw.includes(k)) u.hw.push(k); }); save(); }
          res.writeHead(200, { ...CORS, "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: 1, own: u ? u.hw : [] }));
        } catch (e) { res.writeHead(400, CORS); res.end(); }
      });
      return;
    }
  }
  res.writeHead(200, { ...CORS, "Content-Type": "text/plain; charset=utf-8" }); res.end("Nova server OK · онлайн: " + online().length);
});
const wss = new WebSocketServer({ server, maxPayload: 100000 });
wss.on("connection", ws => {
  ws.isAlive = true; ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", d => { try { onMsg(ws, d.toString()); } catch (e) { console.error("msg", e); } });
  ws.on("close", () => { try { onClose(ws); } catch (e) { console.error("close", e); } });
  ws.on("error", () => {});
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) {} }), 30000);
server.listen(PORT, () => {
  console.log("сервер на порту", PORT);
  if (!ADMIN_PW) console.warn("ВНИМАНИЕ: ADMIN_PW не задан, админка отключена");
  if (!BOT_TOKEN) console.warn("ВНИМАНИЕ: BOT_TOKEN не задан: initData не проверяется, оплата Stars выключена");
  pollTg();
});
process.on("SIGTERM", () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify({ users: [...users.values()].map(u => ({ id: u.id, name: u.name, username: u.username, bal: u.bal, skins: u.skins, sel: u.sel, gb: u.gb, ban: u.ban, banr: u.banr, hw: u.hw, revq: u.revq, paid: u.paid })), orders, lk: LK })); } catch (e) {} process.exit(0); });
