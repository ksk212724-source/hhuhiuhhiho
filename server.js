/* =====================================================================
Nova Aurum / Lucky Nova: server.js
Один процесс = HTTP + WebSocket + Telegram-бот.
WebSocket:
wss://HOST/ wss://HOST/dust основное приложение (банк, скины, админка, краш,
дурак, шахматы, шашки, заказы, Stars)
онлайн-гонки «Пыльное ралли» (лобби + позиции)
HTTP:
GET / "ok" (пинг)
GET /hw/own?u=ID купленные игры игрока
POST /hw/own {u, own:[...]} сохранить купленные игры
Запуск:
npm i ws
node server.js
Переменные окружения (всё необязательно):
PORT порт (Render подставит сам)
ADMIN_PW BOT_TOKEN WEBAPP_URL DATA_FILE ALLOW_GUEST пароль админки (по умолчанию 11642323)
токен Telegram-бота (проверка initData, Stars, команды бота)
https-адрес мини-приложения (для кнопки в боте)
ADMIN_TG_IDS id админов в Telegram через запятую (уведомления о заказах)
путь к файлу данных (по умолчанию ./data.json)
1 = пускать без Telegram (по умолчанию 1), 0 = только Telegram
===================================================================== */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const PORT = +process.env.PORT || 3000;
const ADMIN_PW = String(process.env.ADMIN_PW || "11642323");
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const WEBAPP_URL = process.env.WEBAPP_URL || "";
const ADMIN_TG = String(process.env.ADMIN_TG_IDS || "").split(",").map(s => s.trim()).filter(
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const ALLOW_GUEST = process.env.ALLOW_GUEST !== "0";
/* ------------------------------ данные ------------------------------ */
const FREE_SKINS = ["k0", "bt0"];
const PACKS = { p1: 1000, p2: 5000, p3: 15000, p4: 50000 }; // игровая валюта за по
const FRAME_COINS = { f1: 149, f2: 249, f3: 349 }; // рамка + монеты на
const RUB = { k1: 10, k2: 20, k4: 30, k5: 40, k7: 50, k6: 60, k3: 70, k8: 80, k9: 90, k10: 10
bt1: 10, bt2: 20, bt3: 30, bt4: 40, bt5: 50, bt6: 60, bt7: 70, bt8: 80, bt9: 90, f1: 149, f
const LK_KEYS = ["slot", "candy", "crash", "roul", "mines", "hl", "poker", "bj", "durak", "ch
let DB = { users: {}, orders: [], lk: {}, hw: {}, pend: {}, xprAll: 0 };
try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))); } catch (e) { /
let saveT = null;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.writeFileSync(D
process.on("SIGTERM", () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(DB)); } catch
const num = (v, d = 0) => { v = Math.floor(+v); return Number.isFinite(v) ? v : d; };
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
const jstr = o => JSON.stringify(o);
function getUser(id, name, username) {
id = String(id);
let u = DB.users[id];
if (!u) { u = DB.users[id] = { id, name: clip(name || "Игрок", 40), username: clip(username
if (name && u.name !== name) { u.name = clip(name, 40); save(); }
if (username != null && u.username !== username) { u.username = clip(username, 40); save();
return u;
}
/* ------------------------------ связь ------------------------------ */
const conns = new Map(); // userId -> Set<ws>
const send = (ws, o) => { if (ws && ws.readyState === 1) { try { ws.send(jstr(o)); } catch (e
const toUser = (id, o) => { const s = conns.get(String(id)); if (s) s.forEach(w => send(w, o)
const online = id => conns.has(String(id)) && conns.get(String(id)).size > 0;
const broadcast = o => conns.forEach(s => s.forEach(w => send(w, o)));
const meMsg = u => ({ t: "me", bal: u.bal, skins: u.skins, sel: u.sel, id: u.id, name: const pushMe = u => toUser(u.id, meMsg(u));
const err = (ws, m) => send(ws, { t: "err", m });
u.name
function addItem(u, k) {
if (!k) return;
if (!u.skins.includes(k)) u.skins.push(k);
}
function giveCoins(u, n) { // игровая валюта (клиентский баланс): шлём ему, офл
n = num(n); if (!n) return;
if (!online(u.id)) { (DB.pend[u.id] = DB.pend[u.id] || []).push({ t: "gadj", n }); save();
else toUser(u.id, { t: "gadj", n });
if (u.gb != null) u.gb = Math.max(0, u.gb + n);
}
function applyPurchase(u, k) {
if (PACKS[k]) { toUser(u.id, { t: "paid", n: PACKS[k], k }); if (!online(u.id)) (DB.pend[u.
addItem(u, k);
const coins = FRAME_COINS[k] || 0;
if (coins) giveCoins(u, coins);
toUser(u.id, { t: "paid", k });
pushMe(u);
}
/* --------------------------- Telegram initData --------------------------- */
function checkInit(init) {
try {
const p = new URLSearchParams(init);
const hash = p.get("hash"); if (!hash) return null;
p.delete("hash");
const str = [...p.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => k + "="
const key = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
const h = crypto.createHmac("sha256", key).update(str).digest("hex");
if (h.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash)
if (Date.now() / 1000 - +p.get("auth_date") > 7 * 86400) return null;
return JSON.parse(p.get("user"));
} catch (e) { return null; }
}
function parseUnsafe(init) { try { return JSON.parse(new URLSearchParams(init).get("user"));
/* ============================== КРАШ ============================== */
const CR = { ph: "wait", t0: Date.now(), cp: 1, hist: [], bets: new Map(), bots: [], subs: ne
const WAIT = 7000, PAUSE = 3500, mAt = t => Math.exp(t / 5000);
const BOTN = ["Алекс", "Нова", "Макс", "Ева", "Тимур", "Лира", "Ярик", "Зара", "Кира", "Борис
function crPoint() { const r = Math.random(); if (r < .04) return 1; return Math.min(200, Mat
function crWait() {
CR.ph = "wait"; CR.t0 = Date.now(); CR.cp = crPoint(); CR.bets.clear();
CR.bots = Array.from({ length: 2 + (Math.random() * 4 | 0) }, () => ({ n: BOTN[Math.random(
}
function crRun() { CR.ph = "run"; CR.t0 = Date.now(); }
function crCash(uid, b, m, auto) {
if (b.out) return; b.out = 1; b.m = m;
const w = Math.floor(b.n * m), u = DB.users[uid];
if (u) { toUser(uid, { t: "cwin", n: w, m }); }
}
function crState() {
const age = Date.now() - CR.t0;
const pl = CR.bots.map(b => ({ n: b.n, b: b.b, c: b.c })).concat([...CR.bets.entries()].map
const s = { t: "cr", hist: CR.hist, pl, ph: CR.ph, age };
if (CR.ph === "crash") s.cp = CR.cp;
return s;
}
setInterval(() => {
const age = Date.now() - CR.t0;
if (CR.ph === "wait" && age >= WAIT) crRun();
else if (CR.ph === "run") {
const m = mAt(age);
CR.bots.forEach(b => { if (!b.c && m >= b.at && b.at < CR.cp) b.c = b.at; });
CR.bets.forEach((b, id) => { if (!b.out && b.au >= 1.1 && m >= b.au && b.au < CR.cp) crCa
if (m >= CR.cp) { CR.ph = "crash"; CR.t0 = Date.now(); CR.hist.unshift(CR.cp); CR.hist =
} else if (CR.ph === "crash" && age >= PAUSE) crWait();
if (CR.subs.size) { const s = jstr(crState()); CR.subs.forEach(w => { if (w.readyState ===
}, 100);
crWait();
/* ============================== СТОЛЫ ============================== */
const rooms = new Map(); const userRoom = new Map(); // code -> room
// userId -> room
const genCode = () => { let c; do { c = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUV
const lkOf = k => { const v = DB.lk[k]; return v == null ? 1 : v; };
const plInfo = u => ({ id: u.id, name: u.name, skin: u.sel });
const roomMsg = r => ({ t: "room", code: r.code, kind: r.kind, bet: r.bet, max: r.max, host:
const roomSend = (r, o, skip) => { r.pl.forEach(p => { if (p !== skip) toUser(p, o); }); };
const roomPush = r => r.pl.forEach(p => toUser(p, roomMsg(r)));
function mkRoom(ws, m) {
const u = ws.u; if (userRoom.has(u.id)) return err(ws, "Ты уже за столом");
const kind = ["durak", "chess", "checkers"].includes(m.kind) ? m.kind : "durak";
const bet = Math.max(0, num(m.n)), max = kind === "durak" ? Math.min(4, Math.max(2, num(m.m
if (bet > u.bal) return err(ws, "Не хватает монет в банке");
const r = { code: genCode(), kind, bet, max, host: u.id, pl: [u.id], spec: new Set(), g: nu
rooms.set(r.code, r); userRoom.set(u.id, r); roomPush(r);
}
function jnRoom(ws, code) {
const u = ws.u, r = rooms.get(String(code || "").toUpperCase());
if (!r || r.g) return err(ws, "Стол не найден или игра уже идёт");
if (userRoom.has(u.id)) return err(ws, "Ты уже за столом");
if (r.pl.length >= r.max) return err(ws, "Стол заполнен");
if (r.bet > u.bal) return err(ws, "Не хватает монет в банке");
r.pl.push(u.id); userRoom.set(u.id, r); roomPush(r);
if (r.kind !== "durak" && r.pl.length === r.max) startRoom(r);
}
function takeBets(r) { r.pl.forEach(id => { DB.users[id].bal -= r.bet; pushMe(DB.users[id]);
function payout(r, winners, draw) {
// winners: id[] ; draw: вернуть ставки
const pot = r.bet * r.pl.length; let each = 0;
if (draw) r.pl.forEach(id => { DB.users[id].bal += r.bet; });
else { each = Math.floor(pot / winners.length); winners.forEach(id => { DB.users[id].bal +=
r.pl.forEach(id => pushMe(DB.users[id])); save(); return each;
}
function closeRoom(r) {
r.pl.forEach(id => userRoom.delete(id));
r.spec.forEach(id => { toUser(id, { t: "specend", m: "Партия закончилась" }); userRoom.dele
rooms.delete(r.code);
}
function startRoom(r) {
if (r.g) return;
if (r.pl.some(id => DB.users[id].bal < r.bet)) { r.pl = r.pl.filter(id => DB.users[id].bal
takeBets(r);
if (r.kind === "durak") { r.g = durakNew(r); durakSend(r); return; }
const w = Math.random() < .5 ? r.pl[0] : r.pl[1];
r.g = { side: { [w]: "w", [r.pl.find(x => x !== w)]: "b" }, over: 0 };
r.pl.forEach(id => toUser(id, { t: "gstart", kind: r.kind, side: r.g.side[id], bet: r.bet,
}
function leaveRoom(ws) {
const u = ws.u, r = userRoom.get(u.id); if (!r) return;
if (r.spec.has(u.id)) { r.spec.delete(u.id); userRoom.delete(u.id); return; }
if (!r.g) { r.pl = r.pl.filter(x => x !== u.id); userRoom.delete(u.id); toUser(u.id, { t: "
if (!r.pl.length) rooms.delete(r.code); else { if (r.host === u.id) r.host = r.pl[0]; roo
// выход посреди партии = поражение
if (r.kind === "durak") return durakLeave(r, u.id);
const opp = r.pl.find(x => x !== u.id);
if (!r.g.over) { r.g.over = 1; const n = payout(r, [opp]); toUser(opp, { t: "end", kind: r.
closeRoom(r);
}
function specEnd(r, m) { r.spec.forEach(id => toUser(id, { t: "specend", m })); }
/* --- шахматы / шашки: сервер пересылает ходы, исход сообщают клиенты --- */
function relayMove(ws, m) {
const r = userRoom.get(ws.u.id); if (!r || !r.g || r.kind === "durak" || r.g.over) return;
if (!r.pl.includes(ws.u.id)) return;
r.hist.push(m.m);
toUser(r.pl.find(x => x !== ws.u.id), { t: "mv", m: m.m });
r.spec.forEach(id => toUser(id, { t: "smv", m: m.m }));
}
!r.pl.
function gameRes(ws, m) {
const r = userRoom.get(ws.u.id); if (!r || !r.g || r.kind === "durak" || r.g.over || r.g.over = 1; const opp = r.pl.find(x => x !== ws.u.id);
if (m.r === "draw") { payout(r, [], true); r.pl.forEach(id => toUser(id, { t: "end", else { const n = payout(r, [opp]); toUser(opp, { t: "end", kind: r.kind, win: 1, n }); toUs
closeRoom(r);
kind:
}
function listRooms(ws, kind) {
const list = [...rooms.values()].filter(r => r.g && r.kind === kind && !r.g.over)
.map(r => ({ code: r.code, bet: r.bet, sp: r.spec.size, pl: r.pl.map(id => DB.users[id].n
send(ws, { t: "rooms", list });
}
function watch(ws, code) {
const r = rooms.get(String(code || "").toUpperCase()); if (!r || !r.g) return err(ws, "Игра
if (userRoom.has(ws.u.id)) return err(ws, "Сначала выйди из своего стола");
if (r.kind === "durak") return durakWatch(ws, r);
r.spec.add(ws.u.id); userRoom.set(ws.u.id, r);
send(ws, { t: "spec", kind: r.kind, bet: r.bet, pl: r.pl.map(id => DB.users[id].name), hist
}
* (i +
/* ============================== ДУРАК ============================== */
/* карта 0..35: масть = c/9|0, ранг = c%9 (6..A). Козырь: масть последней карты колоды. */
const sd = c => (c / 9) | 0, rk = c => c % 9;
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() function durakNew(r) {
const deck = shuffle([...Array(36).keys()]);
const tc = deck[deck.length - 1];
const g = { deck, tc, ts: sd(tc), disc: 0, ps: r.pl.map(id => ({ id, hand: [], out: 0, ok:
g.ps.forEach(p => { p.hand = g.deck.splice(0, 6); });
// первым ходит владелец младшего козыря
let best = 99, bi = 0; g.ps.forEach((p, i) => p.hand.forEach(c => { if (sd(c) === g.ts && r
g.atk = bi; g.def = nextAlive(g, bi); g.lead = bi; g.tx = "Игра началась";
return g;
}
const alive = g => g.ps.map((p, i) => i).filter(i => !g.ps[i].out);
function nextAlive(g, i) { const n = g.ps.length; for (let k = 1; k <= n; k++) { const j = (i
const beats = (g, a, d) => sd(a) === sd(d) ? rk(d) > rk(a) : sd(d) === g.ts && sd(a) !== g.ts
function maxTable(g) { return Math.min(6, g.ps[g.def].hand.length + g.tb.filter(x => x.d != n
function allBeaten(g) { return g.tb.length > 0 && g.tb.every(x => x.d != null); }
function roleOf(g, i) { const p = g.ps[i]; if (p.out) return ""; return i === g.def ? "d" : "
function actOf(g, i) {
if (g.over || g.ps[i].out) return null;
if (i === g.def) return (!g.tk && g.tb.some(x => x.d == null)) ? "take" : null;
if (!g.tb.length) return null;
if (g.tk) return g.ps[i].ok ? null : "done";
if (allBeaten(g)) return g.ps[i].ok ? null : (i === g.atk ? "bito" : "confirm");
return null;
}
function durakSend(r) {
const g = r.g; if (!g) return;
g.ps.forEach((p, i) => {
const u = DB.users[p.id];
toUser(p.id, { t: "g", me: p.id, skin: u.sel, bet: r.bet, dn: g.deck.length, di: g.disc,
h: p.hand, tb: g.tb.map(x => ({ a: x.a, as: x.as, d: x.d, ds: x.ds })), act: actOf(g, i
pl: g.ps.map((q, j) => ({ id: q.id, name: DB.users[q.id].name, skin: DB.users[q.id].sel
});
r.spec.forEach(id => toUser(id, specDurak(r)));
}
function specDurak(r) {
const g = r.g;
return { t: "g", spec: 1, me: "", bet: r.bet, dn: g.deck.length, di: g.disc, tc: g.tc, tx:
pl: g.ps.map((q, j) => ({ id: q.id, name: DB.users[q.id].name, skin: DB.users[q.id].sel,
tb: g.tb.map(x => ({ a: x.a, as: x.as, d: x.d, ds: x.ds })) };
}
function durakWatch(ws, r) { r.spec.add(ws.u.id); userRoom.set(ws.u.id, r); send(ws, specDura
function durakText(g, i) {
if (g.ps[i].out) return "Ты вышел из игры";
if (i === g.def) return g.tk ? "Ты берёшь карты" : g.tb.some(x => x.d == null) ? "Отбивайся
if (!g.tb.length) return i === g.atk ? "Твой ход: атакуй" : "Ждём атаку";
if (g.tk) return "Защитник берёт: подкидывай или жми ГОТОВО";
return allBeaten(g) ? "Всё отбито: подкидывай или БИТО" : "Защитник отбивается";
}
function durakPlay(ws, m) {
const r = userRoom.get(ws.u.id); if (!r || !r.g || r.kind !== "durak" || r.g.over) return;
const g = r.g, i = g.ps.findIndex(p => p.id === ws.u.id); if (i < 0 || g.ps[i].out) return;
const p = g.ps[i], c = p.hand[num(m.c, -1)]; if (c == null) return;
if (i === g.def) {
if (g.tk) return;
const pair = g.tb[num(m.tgt, -1)]; if (!pair || pair.d != null || !beats(g, pair.a, c)) r
pair.d = c; pair.ds = DB.users[p.id].sel; p.hand.splice(num(m.c), 1);
g.ps.forEach(q => q.ok = 0);
if (!p.hand.length) return durakRound(r, true);
if (allBeaten(g) && g.tb.length >= maxTable(g)) return durakRound(r, true);
} else {
if (g.tb.length >= maxTable(g)) return;
if (!g.tb.length && i !== g.atk) return;
if (g.tb.length && !g.tb.some(x => rk(x.a) === rk(c) || (x.d != null && rk(x.d) === rk(c)
g.tb.push({ a: c, as: DB.users[p.id].sel, d: null, ds: null }); p.hand.splice(num(m.c), 1
g.ps.forEach(q => q.ok = 0);
}
durakSend(r);
}
function durakAct(ws) {
const r = userRoom.get(ws.u.id); if (!r || !r.g || r.kind !== "durak" || r.g.over) return;
const g = r.g, i = g.ps.findIndex(p => p.id === ws.u.id), a = actOf(g, i); if (!a) return;
if (a === "take") { g.tk = 1; g.ps.forEach(q => q.ok = 0); }
else g.ps[i].ok = 1;
const att = g.ps.filter((q, j) => j !== g.def && !q.out);
if (g.tk && att.every(q => q.ok)) return durakRound(r, false);
if (!g.tk && allBeaten(g) && att.every(q => q.ok)) return durakRound(r, true);
durakSend(r);
}
function refill(g, order) { order.forEach(i => { const p = g.ps[i]; while (p.hand.length < 6
function durakRound(r, defended) {
const g = r.g, d = g.def;
const cards = g.tb.flatMap(x => x.d != null ? [x.a, x.d] : [x.a]);
const oldAtk = g.atk;
const order = []; for (let k = 0; k < g.ps.length; k++) { const j = (oldAtk + k) % g.ps.len
if (defended) g.disc += cards.length; else g.ps[d].hand.push(...cards);
g.tb = []; g.tk = 0; g.ps.forEach(q => q.ok = 0);
refill(g, order);
if (!g.deck.length) g.ps.forEach(q => { if (!q.hand.length) q.out = 1; });
const left = alive(g);
if (left.length <= 1) return durakEnd(r, left[0]);
let na = defended ? d : nextAlive(g, d);
if (g.ps[na].out) na = nextAlive(g, na);
g.atk = na; g.def = nextAlive(g, na);
durakSend(r);
}
function durakEnd(r, loseIdx) {
const g = r.g; if (g.over) return; g.over = 1;
const k = lkOf("durak");
if (loseIdx == null) { payout(r, [], true); r.pl.forEach(id => toUser(id, { t: "end", win:
else {
const loser = g.ps[loseIdx].id, winners = r.pl.filter(id => id !== loser);
const pot = r.bet * r.pl.length, each = Math.floor(pot / winners.length);
payout(r, winners);
const name = DB.users[loser].name;
winners.forEach(id => toUser(id, { t: "end", win: 1, n: each, durak: name }));
toUser(loser, { t: "end", win: 0, n: 0, durak: name });
}
specEnd(r, "Партия закончилась"); closeRoom(r);
}
function durakLeave(r, id) {
const g = r.g; if (g.over) return closeRoom(r); g.over = 1;
const rest = r.pl.filter(x => x !== id), pot = r.bet * r.pl.length, each = Math.floor(pot /
rest.forEach(x => DB.users[x].bal += each); r.pl.forEach(x => pushMe(DB.users[x])); save();
rest.forEach(x => toUser(x, { t: "end", left: 1, win: 1, n: each })); toUser(id, { t: "end"
specEnd(r, "Игрок вышел"); closeRoom(r);
}
/* шулерство: один раз за партию берёшь козырь из колоды; другой игрок может поймать */
function durakCheat(ws) {
const r = userRoom.get(ws.u.id); if (!r || !r.g || r.kind !== "durak" || r.g.over) return;
const g = r.g, p = g.ps.find(x => x.id === ws.u.id); if (!p || p.out || p.cheated || const ti = g.deck.findIndex(c => sd(c) === g.ts && c !== g.tc); const di = ti >= 0 ? p.hand.push(g.deck.splice(di, 1)[0]); p.cheated = 1;
toUser(p.id, { t: "ev", m: "Карта тайно взята из колоды", me: 1 });
durakSend(r);
!g.dec
ti : 0
}
function durakAcc(ws, m) {
const r = userRoom.get(ws.u.id); if (!r || !r.g || r.kind !== "durak" || r.g.over) return;
const g = r.g, tgt = g.ps.find(x => x.id === String(m.to)); if (!tgt || tgt.out || tgt.id =
if (tgt.cheated) { toUser(ws.u.id, { t: "ev", m: "Поймал шулера! Он проиграл", me: 0 }); r.
else { toUser(ws.u.id, { t: "ev", m: "Ложное обвинение!", me: 1 }); }
}
function stick(ws, m) {
const r = userRoom.get(ws.u.id); if (!r) return; const e = clip(m.e, 8);
roomSend(r, { t: "stk", id: ws.u.id, e }, ws.u.id); r.spec.forEach(id => toUser(id, { t: "s
}
/* ============================== АДМИНКА ============================== */
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.l
const admins = new Set();
let abuseTimer = null, abuseState = null;
function userRow(u) { return { id: u.id, name: u.name, username: u.username, on: online(u.id)
function pendingOrders() { return DB.orders.filter(o => o.st === "new").map(o => ({ id: o.id,
function findUser(q) {
q = String(q || "").trim().toLowerCase().replace(/^@/, ""); if (!q) return null;
return Object.values(DB.users).find(u => u.id === q || (u.username && u.username.toLowerCas
}
function admList(q) {
q = String(q || "").trim().toLowerCase();
let list = Object.values(DB.users);
if (q === "#ban") list = list.filter(u => u.ban);
else if (q) list = list.filter(u => u.id.includes(q) || u.name.toLowerCase().includes(q) ||
list.sort((a, b) => (online(b.id) - online(a.id)) || (b.bal - a.bal));
return list.slice(0, 60).map(userRow);
}
function adm(ws, m) {
ws.admTries = (ws.admTries || 0);
if (!safeEq(m.pw || "", ADMIN_PW)) { if (++ws.admTries > 8) { send(ws, { t: "admr", bad: 1
admins.add(ws);
const ok = s => send(ws, { t: "admr", m: s });
const id = m.id != null ? String(m.id) : "", u = DB.users[id];
const need = () => { if (!u) { ok("Игрок не найден"); return false; } return true; };
switch (m.op) {
case "list": return send(ws, { t: "adml", u: admList(m.q), o: pendingOrders(), lk: DB.lk
case "bank": if (!need()) return; u.bal = Math.max(0, u.bal + num(m.n)); pushMe(u); save(
case "game": if (!need()) return; giveCoins(u, num(m.n)); save(); return ok("Игровой бала
case "zero":
if (!need()) return;
if (m.w === "bank") { u.bal = 0; pushMe(u); save(); return ok("Банк обнулён"); }
toUser(u.id, { t: "gadj", n: 0, z: 1 }); if (!online(u.id)) (DB.pend[u.id] = DB.pend[u.
case "ban":
if (!need()) return; u.ban = m.v ? 1 : 0; u.banR = clip(m.r, 200); save();
if (u.ban) { toUser(u.id, { t: "ban", m: u.banR }); const s = conns.get(u.id); if (s) s
return ok(u.ban ? "Забанен" : "Разбанен");
case "lk": { if (!LK_KEYS.includes(m.k)) return ok("Неизвестная игра"); DB.lk[m.k] case "grant": if (!need()) return; if (!m.k) return ok("Нет предмета"); addItem(u, = Math
String
case "rev": { if (!need()) return; const ks = [].concat(m.k || []).map(String); u.skins =
case "xpr": { if (m.id === "all") { broadcast({ t: "xpr" }); Object.keys(DB.users).forEac
if (!need()) return; if (!toUser(u.id, { t: "xpr" })) (DB.pend[u.id] = DB.pend[u.id] ||
case "ordd": return resolveOrder(ws, String(m.oid), !!m.yes, ok);
case "abuse": {
clearTimeout(abuseTimer);
if (m.v) { abuseState = { on: 1, mult: Math.max(1, num(m.mult, 50000)), run: 180000 };
abuseTimer = setTimeout(() => { abuseState = null; broadcast({ t: "abuse", on: abuseState = null; broadcast({ t: "abuse", on: 0 }); return ok("Абьюз остановлен");
0 });
}
default: return ok("Неизвестная команда");
}
}
function resolveOrder(ws, oid, yes, ok) {
const o = DB.orders.find(x => x.id === oid); if (!o) return ok && ok("Заказ не найден");
if (o.st !== "new") return ok && ok("Заказ уже обработан");
o.st = yes ? "yes" : "no"; const u = DB.users[o.uid];
if (yes && u) applyPurchase(u, o.k);
toUser(o.uid, { t: "ordr", id: o.id, ok: yes ? 1 : 0 }); save();
admins.forEach(w => send(w, { t: "adml", u: admList(""), o: pendingOrders(), lk: DB.lk }));
tgNotify("Заказ " + o.id + (yes ? " подтверждён " : " отклонён "));
return ok && ok(yes ? "Выдано" : "Отклонено");
}
/* ============================== Telegram-бот ============================== */
const tg = (method, body) => BOT_TOKEN ? fetch("https://api.telegram.org/bot" + BOT_TOKEN + "
const tgNotify = (text, extra) => ADMIN_TG.forEach(id => tg("sendMessage", Object.assign({ ch
let tgOffset = 0;
async function tgPoll() {
if (!BOT_TOKEN) return;
await tg("deleteWebhook", {});
for (;;) {
const r = await tg("getUpdates", { offset: tgOffset, timeout: 25, allowed_updates: if (!r.ok) { await new Promise(s => setTimeout(s, 4000)); continue; }
for (const up of r.result || []) { tgOffset = up.update_id + 1; try { await tgUpdate(up);
["mess
}
}
async function tgUpdate(up) {
if (up.pre_checkout_query) return tg("answerPreCheckoutQuery", { pre_checkout_query_id: up.
if (up.callback_query) {
const cq = up.callback_query, d = String(cq.data || "").split(":");
if (d[0] === "ord" && ADMIN_TG.includes(String(cq.from.id))) { resolveOrder(null, d[2], d
else await tg("answerCallbackQuery", { callback_query_id: cq.id });
return;
}
const msg = up.message; if (!msg) return;
if (msg.successful_payment) {
const [uid, k] = String(msg.successful_payment.invoice_payload || "").split("|"); const u
if (u && k) { applyPurchase(u, k); tgNotify(" Оплата Stars: " + u.name + " (" + uid + "
return;
}
const text = String(msg.text || ""), cid = msg.chat.id;
if (/^\/start/.test(text)) {
const kb = WEBAPP_URL ? { reply_markup: { inline_keyboard: [[{ text: " Играть", web_app
return tg("sendMessage", Object.assign({ chat_id: cid, text: "Добро пожаловать! Жми «Игра
}
if (/^\/id/.test(text)) return tg("sendMessage", { chat_id: cid, text: "Твой Telegram ID: "
if (ADMIN_TG.includes(String(msg.from.id)) && /^\/orders/.test(text)) {
const o = pendingOrders(); if (!o.length) return tg("sendMessage", { chat_id: cid, text:
for (const x of o) await tg("sendMessage", { chat_id: cid, text: `Заказ ${x.id}: ${x.k} ·
}
}
/* ============================== основной WebSocket ============================== */
function onMain(ws) {
ws.isAlive = true; ws.on("pong", () => ws.isAlive = true);
ws.on("message", raw => {
let m; try { m = JSON.parse(raw); } catch (e) { return; }
if (!m || typeof m.t !== "string") return;
ws.rate = ws.rate || { n: 0, t: Date.now() }; if (Date.now() - ws.rate.t > 1000) ws.rate
try { handle(ws, m); } catch (e) { console.error("handle", m.t, e); }
});
ws.on("close", () => {
CR.subs.delete(ws); admins.delete(ws);
if (ws.u) { const s = conns.get(ws.u.id); if (s) { s.delete(ws); if (!s.size) { conns.del
});
}
function handle(ws, m) {
if (m.t === "auth") return auth(ws, m);
if (m.t === "adm") return adm(ws, m);
const u = ws.u; if (!u) return send(ws, { t: "err", m: "Нет авторизации" });
if (u.ban) return send(ws, { t: "ban", m: u.banR });
switch (m.t) {
case "gb": { const b = num(m.bal, -1); if (b >= 0 && b <= 1e15) { u.gb = b; save(); } bre
case "skins": { if (typeof m.sel === "string" && u.skins.includes(m.sel)) { u.sel = m.sel
case "dep": { const n = num(m.n); if (n < 1) return err(ws, "Неверная сумма"); u.bal += n
case "wd": { const n = Math.min(num(m.n), u.bal); if (n < 1) return err(ws, "В банке пуст
case "send": {
const n = num(m.n), to = findUser(m.to); if (n < 1) return err(ws, "Неверная сумма");
if (!to) return err(ws, "Игрок не найден"); if (to.id === u.id) return err(ws, "Нельзя
if (n > u.bal) return err(ws, "Не хватает монет в банке");
u.bal -= n; to.bal += n; save(); pushMe(u); pushMe(to); toUser(to.id, { t: "in", from:
}
case "ord": return newOrder(ws, m);
case "inv": return invoice(ws, m);
case "csub": CR.subs.add(ws); send(ws, crState()); break;
case "cunsub": CR.subs.delete(ws); break;
case "cbet": { if (CR.ph !== "wait" || CR.bets.has(u.id)) return; const n = num(m.n); if
case "ccash": { const b = CR.bets.get(u.id); if (!b || b.out || CR.ph !== "run") return;
case "mk": return mkRoom(ws, m);
case "jn": return jnRoom(ws, m.code);
case "start": { const r = userRoom.get(u.id); if (r && r.host === u.id && !r.g && r.kind
case "leave": return leaveRoom(ws);
case "play": return durakPlay(ws, m);
case "act": return durakAct(ws);
case "cheat": return durakCheat(ws);
case "acc": return durakAcc(ws, m);
case "st": return stick(ws, m);
case "mv": return relayMove(ws, m);
case "gres": return gameRes(ws, m);
case "rooms": return listRooms(ws, m.kind || "durak");
case "watch": return watch(ws, m.code);
}
}
const toast = (ws, m) => send(ws, { t: "err", m });
function auth(ws, m) {
let tu = null;
if (BOT_TOKEN && m.init) tu = checkInit(m.init);
else if (m.init) tu = parseUnsafe(m.init); // без токена: доверяем (только для раз
if (BOT_TOKEN && !tu && !ALLOW_GUEST) return send(ws, { t: "err", m: "Ошибка авторизации Te
let id, name, username;
if (tu && tu.id) { id = String(tu.id); name = [tu.first_name, tu.last_name].filter(Boolean)
else if (ALLOW_GUEST) { const dev = clip(m.name, 24).replace(/[^\w\u0400-\u04FF -]/g, "");
else return send(ws, { t: "err", m: "Открой приложение в Telegram" });
const u = getUser(id, name, username); ws.u = u;
if (!conns.has(u.id)) conns.set(u.id, new Set()); conns.get(u.id).add(ws);
send(ws, meMsg(u)); send(ws, { t: "cfg", lk: DB.lk });
if (u.ban) return send(ws, { t: "ban", m: u.banR });
(DB.pend[u.id] || []).forEach(x => send(ws, x)); if (DB.pend[u.id]) { delete DB.pend[u.id];
if (abuseState) send(ws, { t: "abuse", on: 1, mult: abuseState.mult, run: abuseState.run })
const r = userRoom.get(u.id);
if (r && r.g && r.kind === "durak") durakSend(r); else if (r && !r.g) send(ws, roomMsg(r));
}
function newOrder(ws, m) {
const u = ws.u, id = clip(m.id, 16), k = clip(m.k, 8);
if (!id || !RUB[k]) return;
let o = DB.orders.find(x => x.id === id);
if (o) { if (o.st === "yes") send(ws, { t: "ordr", id, ok: 1 }); else if (o.st === "no") se
o = { id, k, rub: RUB[k], uid: u.id, name: u.name, st: "new", t: Date.now() };
DB.orders.push(o); if (DB.orders.length > 2000) DB.orders = DB.orders.slice(-1500); save();
const row = { id, k, rub: o.rub, name: o.name, uid: o.uid };
admins.forEach(w => send(w, { t: "ordn", o: row }));
tgNotify(` Новый заказ ${id}\n${k} · ${o.rub} ₽\n${u.name} (ID ${u.id})`, { reply_markup:
}
async function invoice(ws, m) {
const u = ws.u, k = clip(m.k, 8); if (!RUB[k]) return;
if (!BOT_TOKEN) return err(ws, "Stars недоступны: на сервере не задан BOT_TOKEN");
const stars = PACKS[k] ? RUB[k] / 10 : Math.ceil(RUB[k] / 2);
const r = await tg("createInvoiceLink", { title: "Покупка " + k, description: "Покупка в пр
if (r.ok && r.result) send(ws, { t: "inv", url: r.result }); else err(ws, "Не удалось созда
}
/* ============================== ГОНКИ (/dust) ============================== */
/* Протокол игры:
→ create {name, pw, map, uid, nick} ← lobby {lobby:{name,pw,code,map,host,players:[{ui
→ join {code, pw, uid, nick} ← lobby (всем в комнате) | err {msg}
→ start {level} (только хост) ← start {level, players:[{uid,nick}]} (всем)
→ state {d, lat} ← state {uid, d, lat} (остальным)
Лобби живёт, пока в нём есть игроки. */
const dust = new Map(); // code -> {code,name,pw,map,host,players:Map(uid->{uid,nick,ws}
const dustCode = () => { let c; do { c = Math.random().toString(36).slice(2, 6).toUpperCase()
const dustView = L => ({ name: L.name, pw: L.pw, code: L.code, map: L.map, host: L.host, play
const dustSend = (L, o, skip) => L.players.forEach(p => { if (p.uid !== skip) send(p.ws, o);
function dustLeave(ws) {
const L = ws.lobby; if (!L) return; ws.lobby = null;
L.players.delete(ws.uid);
if (!L.players.size) { dust.delete(L.code); return; }
if (L.host === ws.uid) L.host = L.players.keys().next().value;
L.started = L.started && L.players.size > 0; dustSend(L, { t: "lobby", lobby: dustView(L) }
}
function onDust(ws) {
ws.isAlive = true; ws.on("pong", () => ws.isAlive = true);
ws.on("message", raw => {
let m; try { m = JSON.parse(raw); } catch (e) { return; }
if (!m || typeof m.t !== "string") return;
ws.rate = ws.rate || { n: 0, t: Date.now() }; if (Date.now() - ws.rate.t > 1000) ws.rate
if (m.t === "create") {
dustLeave(ws);
const pw = clip(m.pw, 32); if (pw.length < 3) return send(ws, { t: "err", msg: "Пароль
const uid = clip(m.uid, 40) || "u" + crypto.randomBytes(4).toString("hex");
const L = { code: dustCode(), name: clip(m.name, 30) || "Ралли", pw, map: Math.max(0, M
L.players.set(uid, { uid, nick: clip(m.nick, 16) || "Гонщик", ws }); dust.set(L.code, L
return send(ws, { t: "lobby", lobby: dustView(L) });
}
if (m.t === "join") {
const L = dust.get(clip(m.code, 8).toUpperCase());
if (!L || L.pw !== String(m.pw || "")) return send(ws, { t: "err", msg: "Неверный код и
if (L.players.size >= 8) return send(ws, { t: "err", msg: "Лобби заполнено" });
dustLeave(ws);
const uid = clip(m.uid, 40) || "u" + crypto.randomBytes(4).toString("hex");
const old = L.players.get(uid); if (old && old.ws !== ws) { try { old.ws.lobby = null;
L.players.set(uid, { uid, nick: clip(m.nick, 16) || "Гонщик", ws }); ws.lobby = L; ws.u
return dustSend(L, { t: "lobby", lobby: dustView(L) });
}
const L = ws.lobby; if (!L) return;
if (m.t === "start") {
if (L.host !== ws.uid) return send(ws, { t: "err", msg: "Запускает только хост" });
if (L.players.size < 2) return send(ws, { t: "err", msg: "Нужен хотя бы ещё один L.started = true;
return dustSend(L, { t: "start", level: Math.max(1, Math.min(24, num(m.level, 1))), pla
игрок"
}
if (m.t === "state") {
const d = +m.d, lat = +m.lat; if (!Number.isFinite(d) || !Number.isFinite(lat)) return;
return dustSend(L, { t: "state", uid: ws.uid, d, lat }, ws.uid);
}
});
ws.on("close", () => dustLeave(ws));
}
/* ============================== HTTP ============================== */
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,
const server = http.createServer((req, res) => {
const url = new URL(req.url, "http://x");
if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
if (url.pathname === "/hw/own") {
if (req.method === "GET") {
const u = String(url.searchParams.get("u") || ""); res.writeHead(200, Object.assign({ "
return res.end(jstr({ own: DB.hw[u] || [] }));
}
if (req.method === "POST") {
let body = ""; req.on("data", c => { body += c; if (body.length > 20000) req.destroy();
req.on("end", () => {
try {
const j = JSON.parse(body), key = String(j.u || ""); if (!key || !Array.isArray(j.o
const set = new Set(DB.hw[key] || []); j.own.forEach(x => set.add(clip(x, 24))); DB
res.writeHead(200, Object.assign({ "Content-Type": "application/json" }, CORS)); re
} catch (e) { res.writeHead(400, CORS); res.end("bad"); }
});
return;
}
}
res.writeHead(200, Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, CORS)); r
});
const wssMain = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const wssDust = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
wssMain.on("connection", onMain); wssDust.on("connection", onDust);
server.on("upgrade", (req, sock, head) => {
const p = new URL(req.url, "http://x").pathname;
const w = p === "/dust" ? wssDust : wssMain;
w.handleUpgrade(req, sock, head, ws => w.emit("connection", ws, req));
});
setInterval(() => [wssMain, wssDust].forEach(w => w.clients.forEach(ws => { if (!ws.isAlive)
server.listen(PORT, () => {
console.log("server on :" + PORT + " | бот: " + (BOT_TOKEN ? "вкл" : "выкл (нет BOT_TOKEN)"
tgPoll();
});
