"use strict";
/* Nova Aurum server. Запуск: npm i ws && node server.js
   Переменные окружения: ADMIN_PW (пароль админки), BOT_TOKEN (токен бота: проверка Telegram и оплата Stars),
   DATA_FILE (файл базы, по умолчанию ./data.json), ALLOW_DEV=1 (вход без Telegram для тестов) */
const http = require("http"), fs = require("fs"), crypto = require("crypto");
const { WebSocketServer } = require("ws");
const PORT = +process.env.PORT || 3000, BOT = process.env.BOT_TOKEN || "", ADMIN_PW = process.env.ADMIN_PW || "11642323";
const FILE = process.env.DATA_FILE || "./data.json", ALLOW_DEV = process.env.ALLOW_DEV === "1" || !BOT;
let DB = { users: {}, orders: {}, done: {}, lk: {}, pay: {} };
try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(FILE, "utf8"))); } catch (e) {}
let svT = 0;
const save = () => { if (svT) return; svT = setTimeout(() => { svT = 0; try { fs.writeFileSync(FILE + ".tmp", JSON.stringify(DB)); fs.renameSync(FILE + ".tmp", FILE); } catch (e) { console.error("save", e.message); } }, 1500); };
const users = DB.users, CON = new Map(), ROOMS = {}, IN = {}, SP = {}, GR = {};
const rnd = n => Math.floor(Math.random() * n), now = () => Date.now();
const sendWs = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
function tell(id, o, keep) { const ws = CON.get(id); if (ws) sendWs(ws, o); else if (keep && users[id]) { users[id].pend = users[id].pend || []; users[id].pend.push(o); save(); } }
const push = u => tell(u.id, { t: "me", bal: u.bal, skins: u.skins, sel: u.sel, id: u.id, name: u.name });
const err = (id, m) => tell(id, { t: "err", m });

/* ===== каталог ===== */
const RUB = { k1: 10, k2: 20, k4: 30, k5: 40, k7: 50, k6: 60, k3: 70, k8: 80, k9: 90, k10: 100, k11: 110, k12: 120, k13: 130, k14: 140, k15: 150, bt1: 10, bt2: 20, bt3: 30, bt4: 40, bt5: 50, bt6: 60, bt7: 70, bt8: 80, bt9: 90, f1: 149, f2: 249, f3: 349 };
const FRB = { f1: 149, f2: 249, f3: 349 };
const PK = { p1: [1000, 10, 1], p2: [5000, 50, 5], p3: [15000, 150, 15], p4: [50000, 500, 50] };
function cat(k) {
  if (typeof k !== "string") return null;
  if (PK[k]) return { cur: 1, n: PK[k][0], rub: PK[k][1], st: PK[k][2], title: "Игровая валюта " + PK[k][0] };
  const m = /^pc(\d+)$/.exec(k);
  if (m) { const a = +m[1]; if (a >= 1000 && a <= 1e7) return { cur: 1, n: a, rub: Math.ceil(a / 100), st: Math.ceil(a / 1000), title: "Игровая валюта " + a }; return null; }
  if (RUB[k]) return { cur: 0, n: FRB[k] || 0, rub: RUB[k], st: Math.ceil(RUB[k] / 2), title: "Предмет " + k };
  return null;
}
function grant(u, k) {
  const c = cat(k); if (!c) return false;
  if (c.cur) tell(u.id, { t: "paid", n: c.n }, 1);
  else { if (!u.skins.includes(k)) u.skins.push(k); u.revoked = (u.revoked || []).filter(x => x !== k); tell(u.id, { t: "paid", n: c.n, k }, 1); }
  push(u); save(); return true;
}

/* ===== пользователи ===== */
const mkUser = (id, name, username) => ({ id, name, username: username || "", bal: 0, gb: null, skins: ["k0", "bt0"], sel: "k0", ban: 0, reason: "", revoked: [], pend: [], seen: now() });
function verify(init) {
  if (!BOT || !init) return null;
  try {
    const p = new URLSearchParams(init), h = p.get("hash"); p.delete("hash");
    const s = [...p.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
    const key = crypto.createHmac("sha256", "WebAppData").update(BOT).digest();
    if (crypto.createHmac("sha256", key).update(s).digest("hex") !== h) return null;
    if (Date.now() / 1000 - (+p.get("auth_date") || 0) > 86400 * 7) return null;
    return JSON.parse(p.get("user"));
  } catch (e) { return null; }
}
let onT = 0;
function bcOn() { if (onT) return; onT = setTimeout(() => { onT = 0; const o = { t: "on", n: CON.size }; CON.forEach(ws => sendWs(ws, o)); }, 800); }

/* ===== абьюз-событие ===== */
let AB = { on: 0, mult: 50000, start: 0, end: 0, tm: null };
const abMsg = () => AB.on && now() < AB.end ? { t: "abuse", on: 1, mult: AB.mult, cd: now() < AB.start ? 1 : 0, run: now() < AB.start ? 180000 : AB.end - now() } : null;
function abStart(mult) {
  clearTimeout(AB.tm); AB = { on: 1, mult: Math.max(1, Math.floor(+mult) || 50000), start: now() + 5000, end: now() + 185000, tm: null };
  CON.forEach(ws => sendWs(ws, { t: "abuse", on: 1, mult: AB.mult, cd: 1, run: 180000 }));
  AB.tm = setTimeout(abStop, 185000);
}
function abStop() { clearTimeout(AB.tm); AB.on = 0; CON.forEach(ws => sendWs(ws, { t: "abuse", on: 0 })); }

/* ===== краш (общий раунд) ===== */
const CRS = { ph: "wait", t0: now(), cp: 1, hist: [], bets: new Map(), subs: new Set() };
const nextCp = () => Math.min(200, Math.max(1, Math.floor(95 / (1 - Math.random())) / 100));
const crM = () => Math.exp((now() - CRS.t0) / 5000);
function crState(ws) {
  const age = now() - CRS.t0, o = { t: "cr", ph: CRS.ph, age, hist: CRS.hist, pl: [...CRS.bets.values()].map(b => ({ n: b.n, b: b.b, c: b.c })) };
  if (CRS.ph === "crash") o.cp = CRS.cp; return o;
}
setInterval(() => {
  const age = now() - CRS.t0;
  if (CRS.ph === "wait" && age >= 7000) { CRS.ph = "run"; CRS.t0 = now(); CRS.cp = nextCp(); }
  else if (CRS.ph === "run") {
    const m = crM();
    CRS.bets.forEach(b => { if (!b.c && b.au >= 1.1 && m >= b.au && m < CRS.cp) cashOut(b, b.au); });
    if (m >= CRS.cp) { CRS.ph = "crash"; CRS.t0 = now(); CRS.hist.unshift(CRS.cp); CRS.hist = CRS.hist.slice(0, 12); }
  } else if (CRS.ph === "crash" && age >= 4000) { CRS.ph = "wait"; CRS.t0 = now(); CRS.bets.clear(); }
}, 100);
setInterval(() => { if (!CRS.subs.size) return; const o = crState(); CRS.subs.forEach(ws => sendWs(ws, o)); }, 200);
function cashOut(b, m) { b.c = +m.toFixed(2); tell(b.uid, { t: "cwin", n: Math.floor(b.b * b.c), m: b.c }); }

/* ===== дурак (движок) ===== */
const rk = c => c % 9, su = c => Math.floor(c / 9), beats = (a, d, ts) => su(a) === su(d) ? rk(d) > rk(a) : su(d) === ts && su(a) !== ts;
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const alive = r => r.pl.filter(p => !p.out);
const nxt = (r, i) => { for (let k = 1; k <= r.pl.length; k++) { const j = (i + k) % r.pl.length; if (!r.pl[j].out) return j; } return i; };
const srt = (p, ts) => p.hand.sort((a, b) => (su(a) === ts) - (su(b) === ts) || su(a) - su(b) || rk(a) - rk(b));
function dStart(r) {
  const deck = shuffle(Array.from({ length: 36 }, (_, i) => i)), ts = su(deck[0]);
  r.pl.forEach(p => { p.skin = users[p.id].sel; p.out = 0; p.hand = deck.splice(deck.length - 6, 6); });
  let att = rnd(r.pl.length), best = 99;
  r.pl.forEach((p, i) => p.hand.forEach(c => { if (su(c) === ts && rk(c) < best) { best = rk(c); att = i; } }));
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
function dPlay(r, i, m) {
  const g = r.g, p = r.pl[i], c = p.hand[m.c];
  if (c == null || p.out) return;
  if (i === g.def) {
    if (g.tk) return err(p.id, "Ты уже берёшь карты");
    const t = Number.isInteger(m.tgt) && g.tb[m.tgt] && g.tb[m.tgt].d == null ? m.tgt : g.tb.findIndex(x => x.d == null && beats(x.a, c, g.ts));
    if (t < 0 || !g.tb[t] || g.tb[t].d != null || !beats(g.tb[t].a, c, g.ts)) return err(p.id, "Этой картой не побить");
    g.tb[t].d = c; g.tb[t].ds = p.skin;
  } else {
    if (!canThrow(r, i)) return err(p.id, "Сейчас подкидывать нельзя");
    if (g.tb.length && !g.tb.some(x => rk(x.a) === rk(c) || (x.d != null && rk(x.d) === rk(c)))) return err(p.id, "Такого ранга нет на столе");
    g.tb.push({ a: c, as: p.skin, d: null });
  }
  p.hand.splice(m.c, 1); g.conf = { a: 0, d: 0 }; g.done = {}; settle(r);
}
function dAct(r, i) {
  const g = r.g, open = g.tb.some(x => x.d == null), beaten = g.tb.length && !open;
  if (i === g.def) { if (open && !g.tk) { g.tk = 1; g.done = {}; } else if (beaten && g.conf.a && !g.conf.d) g.conf.d = 1; }
  else if (g.tk) g.done[i] = 1;
  else if (i === g.att && beaten && !g.conf.a) g.conf.a = 1;
  settle(r);
}
function settle(r) {
  const g = r.g;
  if (g.tk) {
    if (!r.pl.some((p, j) => j !== g.def && canThrow(r, j) && !g.done[j])) { const d = r.pl[g.def]; g.tb.forEach(x => { d.hand.push(x.a); if (x.d != null) d.hand.push(x.d); }); g.tb = []; return endBout(r, 1); }
  } else if (g.conf.a && g.conf.d && g.tb.length && g.tb.every(x => x.d != null)) { g.tb.forEach(x => g.disc.push(x.a, x.d)); g.tb = []; return endBout(r, 0); }
  sendG(r);
}
function endBout(r, took) {
  const g = r.g; g.tk = 0; g.conf = { a: 0, d: 0 }; g.done = {}; g.bout++;
  const ord = []; for (let k = 0; k < r.pl.length; k++) ord.push((g.att + k) % r.pl.length);
  ord.filter(j => j !== g.def).concat([g.def]).forEach(j => { const p = r.pl[j]; while (!p.out && p.hand.length < 6 && g.deck.length) p.hand.push(g.deck.pop()); });
  r.pl.forEach(p => { if (!p.out && !p.hand.length && !g.deck.length) p.out = 1; srt(p, g.ts); });
  const al = alive(r); if (al.length <= 1) return dFinish(r, al[0]);
  g.att = took || r.pl[g.def].out ? nxt(r, g.def) : g.def; g.def = nxt(r, g.att); g.lim = Math.min(6, r.pl[g.def].hand.length);
  sendG(r);
}
function dFinish(r, loser) {
  const n = r.pl.length, bonus = Math.floor(r.bet / (n - 1));
  r.pl.forEach(p => {
    const u = users[p.id]; let win = 2, amt = r.bet;
    if (loser && p.id === loser.id) { win = 0; amt = 0; } else if (loser) { win = 1; amt = r.bet + bonus; }
    u.bal += amt; tell(p.id, { t: "end", win, n: amt, durak: loser ? loser.name : "" }); push(u);
  });
  r.specs.forEach(id => tell(id, { t: "specend", m: "Игра окончена" + (loser ? ": " + loser.name + " остался дураком" : "") }));
  closeRoom(r); save();
}
function dAbandon(r, id) {
  const n = r.pl.length, bonus = Math.floor(r.bet / (n - 1));
  r.pl.forEach(p => { const u = users[p.id], me = p.id === id, amt = me ? 0 : r.bet + bonus; u.bal += amt; tell(p.id, { t: "end", win: me ? 0 : 1, n: amt, durak: users[id].name, left: 1 }); push(u); });
  r.specs.forEach(sid => tell(sid, { t: "specend", m: users[id].name + " вышел, игра окончена" }));
  closeRoom(r); save();
}
const plView = (r, g) => r.pl.map((x, j) => ({ id: x.id, name: x.name, skin: x.skin, n: x.hand.length, out: x.out, role: j === g.att ? "a" : j === g.def ? "d" : "t", ok: j === g.att ? g.conf.a : j === g.def ? g.conf.d : g.done[j] ? 1 : 0 }));
function dView(r, p) {
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
  return { t: "g", bet: r.bet, dn: g.deck.length, tc: g.tc, ts: g.ts, di: g.disc.length, tb: g.tb, tk: g.tk, h: p.hand, skin: p.skin, act: a, tx, me: p.id, out: p.out, pl: plView(r, g),
    ch: { can: g.disc.length > 0 && (g.cheats[p.id] || 0) < 2 && g.cb[p.id] !== g.bout && !p.out, sus: !!g.sus[p.id] } };
}
const specView = r => { const g = r.g; return { t: "g", spec: 1, bet: r.bet, dn: g.deck.length, tc: g.tc, ts: g.ts, di: g.disc.length, tb: g.tb, tk: g.tk, h: [], me: "", out: 1, tx: "", pl: plView(r, g) }; };
const sendG = r => { r.pl.forEach(p => tell(p.id, dView(r, p))); const sv = specView(r); r.specs.forEach(id => tell(id, sv)); };
const dEv = (r, m) => r.pl.forEach(p => tell(p.id, { t: "ev", m }));
function pay(from, to, n) { const a = Math.min(n, from.bal); from.bal -= a; to.bal += a; push(from); push(to); save(); return a; }
function dCheat(u) {
  const r = ROOMS[IN[u.id]]; if (!r || !r.g) return; const g = r.g, p = r.pl.find(x => x.id === u.id);
  if (p.out || !g.disc.length) return err(u.id, "Нечего подменять: бито пусто");
  if ((g.cheats[u.id] || 0) >= 2 || g.cb[u.id] === g.bout) return err(u.id, "Шулерить можно не чаще раза за ход (2 раза за игру)");
  const c = g.disc.splice(rnd(g.disc.length), 1)[0];
  p.hand.push(c); srt(p, g.ts); g.cheats[u.id] = (g.cheats[u.id] || 0) + 1; g.cb[u.id] = g.bout; g.sus[u.id] = g.bout;
  tell(u.id, { t: "ev", m: "Карта из рукава у тебя! Не попадись", me: 1 }); sendG(r);
}
function dAcc(u, m) {
  const r = ROOMS[IN[u.id]]; if (!r || !r.g) return; const g = r.g, t = r.pl.find(x => x.id === m.to);
  if (!t || t.id === u.id) return;
  if (g.ab[u.id] === g.bout) return err(u.id, "Обвинять можно раз за ход");
  g.ab[u.id] = g.bout;
  if (g.sus[t.id] && g.sus[t.id] >= g.bout - 1) {
    delete g.sus[t.id]; if (t.hand.length) g.disc.push(t.hand.splice(rnd(t.hand.length), 1)[0]);
    const a = pay(users[t.id], u, r.bet); dEv(r, u.name + " поймал шулера " + t.name + "! Штраф " + a);
  } else { const a = pay(u, users[t.id], Math.ceil(r.bet / 2)); dEv(r, u.name + " ложно обвинил " + t.name + " и заплатил " + a); }
  sendG(r);
}

/* ===== комнаты ===== */
const roomMsg = r => ({ t: "room", code: r.code, kind: r.kind, pl: r.pl.map(p => ({ id: p.id, name: p.name, skin: users[p.id].sel })), max: r.max, host: r.host, bet: r.bet });
const bcRoom = r => r.pl.forEach(p => tell(p.id, roomMsg(r)));
function closeRoom(r) { delete ROOMS[r.code]; r.pl.forEach(p => delete IN[p.id]); r.specs.forEach(id => delete SP[id]); }
function newCode() { let c; do { c = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[rnd(24)]).join(""); } while (ROOMS[c]); return c; }
function mk(u, m) {
  if (IN[u.id] || SP[u.id]) return err(u.id, "Ты уже за столом");
  const kind = ["durak", "chess", "checkers"].includes(m.kind) ? m.kind : "durak", n = Math.floor(+m.n);
  if (!(n >= 1)) return err(u.id, "Ставка от 1");
  if (u.bal < n) return err(u.id, "Не хватает денег в банке. Пополни банк в «Бонусах»");
  u.bal -= n; push(u);
  const r = { code: newCode(), kind, bet: n, max: kind === "durak" ? Math.min(4, Math.max(2, +m.max || 2)) : 2, host: u.id, pl: [{ id: u.id, name: u.name, hand: [], out: 0 }], specs: new Set(), g: null, started: 0, hist: [], turn: "w" };
  ROOMS[r.code] = r; IN[u.id] = r.code; save(); bcRoom(r);
}
function jn(u, m) {
  if (IN[u.id] || SP[u.id]) return err(u.id, "Ты уже за столом");
  const r = ROOMS[String(m.code || "").toUpperCase()];
  if (!r || r.started) return err(u.id, "Стол не найден или игра уже идёт");
  if (r.pl.length >= r.max) return err(u.id, "Стол заполнен");
  if (u.bal < r.bet) return err(u.id, "Не хватает денег в банке для ставки " + r.bet);
  u.bal -= r.bet; push(u); r.pl.push({ id: u.id, name: u.name, hand: [], out: 0 }); IN[u.id] = r.code; save(); bcRoom(r);
  if (r.kind !== "durak" && r.pl.length === 2) startBoard(r);
}
function startBoard(r) {
  r.started = 1; r.turn = "w"; r.hist = [];
  const f = rnd(2); r.pl[f].side = "w"; r.pl[1 - f].side = "b";
  r.pl.forEach((p, i) => tell(p.id, { t: "gstart", kind: r.kind, side: p.side, opp: r.pl[1 - i].name, bet: r.bet }));
}
function endBoard(r, loserId, left) {
  const specMsg = (txt) => r.specs.forEach(id => tell(id, { t: "specend", m: txt }));
  if (!loserId) { r.pl.forEach(p => { users[p.id].bal += r.bet; tell(p.id, { t: "end", kind: r.kind, win: 2, n: r.bet }); push(users[p.id]); }); specMsg("Ничья"); }
  else {
    const w = r.pl.find(p => p.id !== loserId);
    users[w.id].bal += 2 * r.bet; push(users[w.id]);
    tell(w.id, { t: "end", kind: r.kind, win: 1, n: 2 * r.bet, left: left ? 1 : 0 }); tell(loserId, { t: "end", kind: r.kind, win: 0, n: 0, left: left ? 1 : 0 });
    specMsg("Победил " + w.name);
  }
  closeRoom(r); save();
}
function leave(u) {
  const sc = SP[u.id];
  if (sc) { const r = ROOMS[sc]; if (r) r.specs.delete(u.id); delete SP[u.id]; tell(u.id, { t: "room" }); return; }
  const r = ROOMS[IN[u.id]];
  if (!r) { tell(u.id, { t: "room" }); return; }
  if (!r.started) {
    u.bal += r.bet; r.pl = r.pl.filter(p => p.id !== u.id); delete IN[u.id]; push(u); tell(u.id, { t: "room" }); save();
    if (!r.pl.length) { closeRoom(r); return; } if (r.host === u.id) r.host = r.pl[0].id; bcRoom(r); return;
  }
  if (r.kind === "durak") dAbandon(r, u.id); else endBoard(r, u.id, 1);
}
function watch(u, m) {
  if (IN[u.id] || SP[u.id]) return err(u.id, "Сначала выйди из текущей игры");
  const r = ROOMS[String(m.code || "").toUpperCase()];
  if (!r || !r.started) return err(u.id, "Игра уже закончилась");
  r.specs.add(u.id); SP[u.id] = r.code;
  if (r.kind === "durak") tell(u.id, specView(r));
  else tell(u.id, { t: "spec", kind: r.kind, code: r.code, bet: r.bet, pl: [r.pl.find(p => p.side === "w").name, r.pl.find(p => p.side === "b").name], hist: r.hist });
}
const roomList = kind => ({ t: "rooms", list: Object.values(ROOMS).filter(r => r.started && (!kind || r.kind === kind)).slice(0, 30).map(r => ({ code: r.code, kind: r.kind, bet: r.bet, pl: r.pl.map(p => p.name), sp: r.specs.size })) });

/* ===== админка ===== */
const BAD = new Map();
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const findU = id => users[id];
function adm(ws, m) {
  const b = BAD.get(ws) || { n: 0, t: 0 };
  if (b.n >= 5 && now() - b.t < 60000) return sendWs(ws, { t: "admr", bad: 1 });
  if (!ADMIN_PW || !safeEq(m.pw, ADMIN_PW)) { b.n++; b.t = now(); BAD.set(ws, b); return sendWs(ws, { t: "admr", bad: 1 }); }
  BAD.delete(ws); ws.adm = 1;
  const R = s => sendWs(ws, { t: "admr", m: s }), u = findU(m.id);
  switch (m.op) {
    case "list": {
      const q = String(m.q || "").toLowerCase().replace(/^@/, "");
      let l = Object.values(users);
      if (q === "#ban") l = l.filter(x => x.ban); else if (q) l = l.filter(x => x.id.toLowerCase().includes(q) || (x.name || "").toLowerCase().includes(q) || (x.username || "").toLowerCase().includes(q));
      l.sort((a, c) => (CON.has(c.id) - CON.has(a.id)) || (c.seen - a.seen));
      return sendWs(ws, { t: "adml", u: l.slice(0, 60).map(x => ({ id: x.id, name: x.name, username: x.username, on: CON.has(x.id), ban: x.ban, bal: x.bal, gb: x.gb })), o: Object.values(DB.orders), lk: DB.lk });
    }
    case "bank": if (!u) return R("Игрок не найден"); u.bal = Math.max(0, u.bal + Math.floor(+m.n || 0)); push(u); save(); return R("Банк игрока: " + u.bal);
    case "game": if (!u) return R("Игрок не найден"); tell(u.id, { t: "gadj", n: Math.floor(+m.n || 0) }, 1); return R("Игровой баланс изменён: " + Math.floor(+m.n || 0));
    case "zero": if (!u) return R("Игрок не найден"); if (m.w === "bank") { u.bal = 0; push(u); save(); return R("Банк обнулён"); } tell(u.id, { t: "gadj", z: 1 }, 1); return R("Игровой баланс обнулён");
    case "ban": if (!u) return R("Игрок не найден"); u.ban = m.v ? 1 : 0; u.reason = String(m.r || "").slice(0, 200); save();
      if (u.ban) { tell(u.id, { t: "ban", m: u.reason }); if (IN[u.id] || SP[u.id]) leave(u); } return R(u.ban ? "Забанен" : "Разбанен");
    case "lk": DB.lk[String(m.k)] = Math.max(0, Math.min(5, +m.v || 0)); save(); CON.forEach(c => sendWs(c, { t: "cfg", lk: DB.lk })); return R("Шанс сохранён");
    case "grant": if (!u) return R("Игрок не найден"); return R(grant(u, m.k) ? "Выдано" : "Неизвестный предмет");
    case "rev": if (!u) return R("Игрок не найден"); { const k = String(m.k);
      u.skins = u.skins.filter(x => x !== k); if (!u.skins.includes("k0")) u.skins.push("k0"); if (!u.skins.includes("bt0")) u.skins.push("bt0");
      u.revoked = u.revoked || []; if (!u.revoked.includes(k)) u.revoked.push(k); if (!u.skins.includes(u.sel)) u.sel = "k0";
      tell(u.id, { t: "rev", k: [k] }, 1); push(u); save(); return R("Предмет забран"); }
    case "xpr": {
      if (m.id === "all") { Object.values(users).forEach(x => tell(x.id, { t: "xpr" }, 1)); return R("Уровни обнулены у всех"); }
      if (!u) return R("Игрок не найден"); tell(u.id, { t: "xpr" }, 1); return R("Уровень обнулён");
    }
    case "ordd": {
      const o = DB.orders[m.oid]; if (!o) return R("Заказ уже обработан");
      delete DB.orders[o.id]; DB.done[o.id] = 1; const bu = users[o.uid];
      if (m.yes && bu) grant(bu, o.k); tell(o.uid, { t: "ordr", id: o.id, ok: m.yes ? 1 : 0 }, 1); save(); return R(m.yes ? "Заказ подтверждён" : "Заказ отклонён");
    }
    case "abuse": if (m.v) abStart(m.mult); else abStop(); return R(m.v ? "Абьюз запущен у всех" : "Абьюз остановлен");
  }
}

/* ===== обработка сообщений ===== */
function handle(ws, m) {
  if (!m || typeof m.t !== "string") return;
  if (m.t === "auth") return auth(ws, m);
  if (m.t === "adm") return adm(ws, m);
  const u = ws.u; if (!u) return;
  if (u.ban) return sendWs(ws, { t: "ban", m: u.reason });
  switch (m.t) {
    case "gb": u.gb = Math.max(0, Math.floor(+m.bal || 0)); break;
    case "dep": { const n = Math.floor(+m.n); if (n >= 1 && n <= 1e12) { u.bal += n; push(u); save(); } break; }
    case "wd": { const n = Math.floor(+m.n); if (n >= 1 && n <= u.bal) { u.bal -= n; tell(u.id, { t: "wd", n }); push(u); save(); } else err(u.id, "Недостаточно денег в банке"); break; }
    case "send": { const n = Math.floor(+m.n), q = String(m.to || "").trim().replace(/^@/, "").toLowerCase();
      const to = Object.values(users).find(x => x.id.toLowerCase() === q || (x.username && x.username.toLowerCase() === q));
      if (!to || to.id === u.id) return err(u.id, "Игрок не найден");
      if (!(n >= 1) || n > u.bal) return err(u.id, "Недостаточно денег в банке");
      u.bal -= n; to.bal += n; push(u); push(to); tell(to.id, { t: "in", from: u.name, n }, 1); save(); break; }
    case "skins": {
      (Array.isArray(m.own) ? m.own : []).slice(0, 100).forEach(k => { if (typeof k === "string" && /^(k\d+|bt\d+|f\d)$/.test(k) && !(u.revoked || []).includes(k) && !u.skins.includes(k)) u.skins.push(k); });
      if (typeof m.sel === "string" && u.skins.includes(m.sel)) u.sel = m.sel; save(); break; }
    case "mk": mk(u, m); break;
    case "jn": jn(u, m); break;
    case "start": { const r = ROOMS[IN[u.id]]; if (!r || r.host !== u.id || r.started || r.kind !== "durak") break; if (r.pl.length < 2) return err(u.id, "Нужно минимум 2 игрока"); r.started = 1; dStart(r); break; }
    case "leave": leave(u); break;
    case "play": { const r = ROOMS[IN[u.id]]; if (r && r.g) dPlay(r, r.pl.findIndex(p => p.id === u.id), m); break; }
    case "act": { const r = ROOMS[IN[u.id]]; if (r && r.g) dAct(r, r.pl.findIndex(p => p.id === u.id)); break; }
    case "cheat": dCheat(u); break;
    case "acc": dAcc(u, m); break;
    case "st": { const r = ROOMS[IN[u.id]]; if (!r || typeof m.e !== "string" || m.e.length > 8) break; r.pl.forEach(p => tell(p.id, { t: "stk", id: u.id, e: m.e })); break; }
    case "mv": { const r = ROOMS[IN[u.id]]; if (!r || r.kind === "durak" || !r.started) break; const me = r.pl.find(p => p.id === u.id);
      if (me.side !== r.turn) break; r.turn = r.turn === "w" ? "b" : "w"; r.hist.push(m.m);
      r.pl.forEach(p => { if (p.id !== u.id) tell(p.id, { t: "mv", m: m.m }); }); r.specs.forEach(id => tell(id, { t: "smv", m: m.m })); break; }
    case "gres": { const r = ROOMS[IN[u.id]]; if (!r || r.kind === "durak" || !r.started) break; endBoard(r, m.r === "draw" ? null : u.id, 0); break; }
    case "watch": watch(u, m); break;
    case "rooms": sendWs(ws, roomList(m.kind)); break;
    case "ord": { const c = cat(m.k); const id = String(m.id || "");
      if (!c || id.length < 3 || id.length > 16 || DB.orders[id] || DB.done[id]) break;
      const o = DB.orders[id] = { id, uid: u.id, name: u.name, k: m.k, rub: c.rub, t: now() }; save();
      wss.clients.forEach(c2 => { if (c2.adm) sendWs(c2, { t: "ordn", o }); }); break; }
    case "inv": invoice(u, m); break;
    case "csub": CRS.subs.add(ws); sendWs(ws, crState()); break;
    case "cunsub": CRS.subs.delete(ws); break;
    case "cbet": { const n = Math.floor(+m.n); if (CRS.ph !== "wait" || !(n >= 1) || n > 1e9 || CRS.bets.has(u.id)) break; CRS.bets.set(u.id, { uid: u.id, n: u.name, b: n, au: +m.au || 0, c: 0 }); break; }
    case "ccash": { const b = CRS.bets.get(u.id); if (CRS.ph !== "run" || !b || b.c) break; const x = crM(); if (x < CRS.cp) cashOut(b, x); break; }
  }
}
function auth(ws, m) {
  let id, name, username = "";
  const tg = verify(m.init);
  if (tg && tg.id) { id = String(tg.id); name = [tg.first_name, tg.last_name].filter(Boolean).join(" ") || "Игрок"; username = tg.username || ""; }
  else if (ALLOW_DEV) { const n = String(m.name || "").replace(/[^\w\-а-яё]/gi, "").slice(0, 16) || "guest" + rnd(9999); id = "d_" + n; name = n; }
  else return sendWs(ws, { t: "err", m: "Открой игру через Telegram" });
  let u = users[id]; if (!u) u = users[id] = mkUser(id, name, username); else { u.name = name; if (username) u.username = username; }
  u.seen = now(); clearTimeout(GR[id]);
  const old = CON.get(id); if (old && old !== ws) { old.u = null; try { old.close(); } catch (e) {} CRS.subs.delete(old); }
  ws.u = u; CON.set(id, ws); save();
  if (u.ban) return sendWs(ws, { t: "ban", m: u.reason });
  push(u); sendWs(ws, { t: "cfg", lk: DB.lk }); const a = abMsg(); if (a) sendWs(ws, a);
  const p = u.pend || []; u.pend = []; p.forEach(o => sendWs(ws, o));
  const r = ROOMS[IN[id]]; if (r) { if (r.g) tell(id, dView(r, r.pl.find(x => x.id === id))); else if (!r.started) tell(id, roomMsg(r)); }
  bcOn();
}
function drop(ws) {
  CRS.subs.delete(ws); BAD.delete(ws); const u = ws.u;
  if (u && CON.get(u.id) === ws) {
    CON.delete(u.id); u.seen = now(); bcOn();
    const r = ROOMS[IN[u.id]];
    if (SP[u.id] || r) GR[u.id] = setTimeout(() => { if (!CON.has(u.id)) leave(u); }, r && r.kind === "durak" ? 90000 : 30000);
  }
}

/* ===== Telegram Stars ===== */
async function tgApi(method, body) { const r = await fetch(`https://api.telegram.org/bot${BOT}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }); return r.json(); }
async function invoice(u, m) {
  if (!BOT) return err(u.id, "Оплата Stars не настроена на сервере");
  const c = cat(m.k); if (!c) return err(u.id, "Неизвестный товар");
  try {
    const r = await tgApi("createInvoiceLink", { title: c.title.slice(0, 32), description: c.title + " · " + c.rub + " ₽", payload: u.id + "|" + m.k, provider_token: "", currency: "XTR", prices: [{ label: c.title.slice(0, 32), amount: c.st }] });
    if (r.ok) tell(u.id, { t: "inv", url: r.result }); else err(u.id, "Не удалось создать счёт");
  } catch (e) { err(u.id, "Ошибка оплаты"); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function poll() {
  if (!BOT) return; let off = 0;
  try { await tgApi("deleteWebhook"); } catch (e) {}
  for (;;) {
    try {
      const r = await tgApi("getUpdates", { offset: off, timeout: 25, allowed_updates: ["pre_checkout_query", "message"] });
      if (!r.ok) { await sleep(5000); continue; }
      for (const up of r.result) {
        off = up.update_id + 1;
        if (up.pre_checkout_query) await tgApi("answerPreCheckoutQuery", { pre_checkout_query_id: up.pre_checkout_query.id, ok: true });
        const sp = up.message && up.message.successful_payment;
        if (sp) {
          const ch = sp.telegram_payment_charge_id; if (DB.pay[ch]) continue;
          const [uid, k] = String(sp.invoice_payload).split("|"), c = cat(k), u = users[uid];
          if (u && c && sp.total_amount >= c.st) { DB.pay[ch] = 1; grant(u, k); tell(uid, { t: "ordr", id: "stars", ok: 1 }); save(); }
        }
      }
    } catch (e) { await sleep(3000); }
  }
}

/* ===== запуск ===== */
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }); res.end("ok"); });
const wss = new WebSocketServer({ server, maxPayload: 65536 });
wss.on("connection", ws => {
  ws.alive = 1; ws.on("pong", () => ws.alive = 1);
  ws.on("message", raw => { let m; try { m = JSON.parse(raw); } catch (e) { return; } try { handle(ws, m); } catch (e) { console.error("handle", m && m.t, e); } });
  ws.on("close", () => drop(ws)); ws.on("error", () => {});
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = 0; try { ws.ping(); } catch (e) {} }), 30000);
server.listen(PORT, () => console.log("Nova Aurum server on :" + PORT + (BOT ? "" : " (без BOT_TOKEN: dev-режим)") + (ADMIN_PW ? "" : " (ADMIN_PW не задан: админка закрыта)")));
poll();
process.on("SIGTERM", () => { try { fs.writeFileSync(FILE, JSON.stringify(DB)); } catch (e) {} process.exit(0); });
