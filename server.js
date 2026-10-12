"use strict";
/* Lucky Nova: игровой сервер (WebSocket). Node 18+, единственная зависимость: ws.
   Переменные окружения:
     BOT_TOKEN        токен бота из BotFather (обязательно: проверка входа через Telegram)
     ADMIN_PASSWORD   пароль админ-панели (обязательно, если нужна админка)
     UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   (необязательно) хранение данных в Upstash Redis
     DATA_FILE        (необязательно) путь к файлу данных, по умолчанию ./data.json
     ALLOW_DEV=1      (необязательно) вход без Telegram по ?dev=имя, только для тестов */
const http = require("http"), fs = require("fs"), crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = +process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Kirrir11";
const ALLOW_DEV = process.env.ALLOW_DEV === "1";
const DATA_FILE = process.env.DATA_FILE || "./data.json";
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "", REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const GRACE_MS = 90000;                       // сколько ждём возвращения игрока после обрыва связи
const ITEMS = { k0: "Классика", k1: "Неон", k2: "Золото", k4: "Изумруд", k5: "Рубин", k7: "Лёд", k6: "Обсидиан", k3: "Бриллиант", k8: "Космос", f1: "Золотая рамка", f2: "Неоновая рамка", f3: "Изумрудная рамка" };
const LK_KEYS = ["slot", "candy", "crash", "roul", "mines", "hl", "poker", "bj", "durak", "chess", "checkers"];
const EMOJI = ["😊", "🤐", "😘", "😎", "🤡", "👍", "👎"];

const int = x => { x = Math.floor(+x); return Number.isFinite(x) ? x : NaN; };
const clip = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);

/* ================= хранилище ================= */
let DB = { users: {}, lk: {} };
async function redis(cmd) {
  const r = await fetch(REDIS_URL, { method: "POST", headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error("redis " + r.status);
  return r.json();
}
async function loadDB() {
  if (REDIS_URL) { const r = await redis(["GET", "luckynova"]); if (r && r.result) DB = JSON.parse(r.result); }
  else if (fs.existsSync(DATA_FILE)) DB = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  DB.users = DB.users || {}; DB.lk = DB.lk || {};
}
let dirty = false, saving = false, timer = null, timerAt = 0;
function markDirty(urgent) {
  dirty = true;
  const delay = urgent ? 2000 : REDIS_URL ? 60000 : 5000, at = Date.now() + delay;
  if (timer && timerAt <= at) return;
  clearTimeout(timer); timerAt = at; timer = setTimeout(flush, delay);
}
async function flush() {
  timer = null; timerAt = 0;
  if (!dirty) return;
  if (saving) return markDirty(true);
  dirty = false; saving = true;
  try {
    const s = JSON.stringify(DB);
    if (REDIS_URL) await redis(["SET", "luckynova", s]);
    else { fs.writeFileSync(DATA_FILE + ".tmp", s); fs.renameSync(DATA_FILE + ".tmp", DATA_FILE); }
  } catch (e) { console.error("save failed:", e.message); dirty = true; setTimeout(() => markDirty(true), 10000); }
  saving = false;
}

/* ================= пользователи и связь ================= */
const online = new Map();            // id -> ws
const Q = {};                        // очередь важных сообщений для тех, кто оффлайн
const timers = new Map();            // id -> таймер ожидания возвращения
const sendWs = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
function send(id, o) {
  const ws = online.get(id);
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; }
  if (o.t === "mv" || o.t === "end") (Q[id] = Q[id] || []).push(o);
  return false;
}
const err = (id, m) => send(id, { t: "err", m });
const pushMe = u => send(u.id, { t: "me", bal: u.bal, skins: u.skins, sel: u.sel, id: u.id, name: u.name });
function touchUser(id, name, username) {
  let u = DB.users[id];
  if (!u) u = DB.users[id] = { id, name: "", username: "", bal: 0, gb: 0, skins: ["k0"], sel: "k0", pend: 0, seen: 0 };
  u.name = name || u.name || "Игрок"; u.username = username || ""; u.seen = Date.now();
  markDirty(); return u;
}
function credit(id, n) { const u = DB.users[id]; if (!u) return; u.bal += n; pushMe(u); markDirty(true); }

function verifyInit(init) {
  if (!BOT_TOKEN || !init) return null;
  const p = new URLSearchParams(init), hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const h = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
  if (h.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - (+p.get("auth_date") || 0) > 86400 * 3) return null;
  try { const u = JSON.parse(p.get("user")); return u && u.id ? u : null; } catch (e) { return null; }
}

function auth(ws, m) {
  if (ws.uid) return;
  let id, name, username = "";
  const tu = verifyInit(m.init);
  if (tu) { id = String(tu.id); name = clip(tu.first_name || tu.username || "Игрок", 20); username = clip(tu.username || "", 32); }
  else if (ALLOW_DEV && m.name) { name = clip(m.name, 20); id = "dev_" + name.replace(/\W/g, "").slice(0, 16); }
  else {
    sendWs(ws, { t: "err", m: BOT_TOKEN ? "Открой игру через Telegram" : "Сервер не настроен: нет BOT_TOKEN" });
    return ws.close();
  }
  const old = online.get(id);
  if (old && old !== ws) { old.uid = null; CR.subs.delete(old); try { old.close(); } catch (e) { } }
  const u = touchUser(id, name, username);
  ws.uid = id; online.set(id, ws);
  clearTimeout(timers.get(id)); timers.delete(id);
  pushMe(u); sendWs(ws, { t: "cfg", lk: DB.lk });
  if (u.pend) { sendWs(ws, { t: "gadj", n: u.pend }); u.pend = 0; markDirty(true); }
  const code = inRoom.get(id), r = code && rooms.get(code);
  if (r) { if (!r.g) sendRoom(r); else if (r.kind === "durak") { const p = r.pl.find(x => x.id === id); if (p && !p.left) send(id, view(r, p)); } }
  const q = Q[id]; if (q) { delete Q[id]; q.forEach(o => sendWs(ws, o)); }
}

/* ================= столы: дурак, шахматы, шашки ================= */
const rooms = new Map(), inRoom = new Map();
function genCode() { const A = "ABCDEFGHJKLMNPQRSTUVWXYZ"; for (; ;) { let c = ""; for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)]; if (!rooms.has(c)) return c; } }
const roomView = r => ({ t: "room", code: r.code, kind: r.kind, bet: r.bet, max: r.max, host: r.host, pl: r.pl.map(p => ({ id: p.id, name: p.name, skin: DB.users[p.id].sel })) });
const sendRoom = r => r.pl.forEach(p => send(p.id, roomView(r)));
const myRoom = u => { const c = inRoom.get(u.id); return c ? rooms.get(c) : null; };

function closeGame(r) {
  r.pl.forEach(p => { if (inRoom.get(p.id) === r.code) inRoom.delete(p.id); });
  rooms.delete(r.code); markDirty(true);
}
function mkRoom(u, m) {
  if (inRoom.has(u.id)) return err(u.id, "Ты уже за столом. Сначала выйди из него");
  const kind = ["durak", "chess", "checkers"].includes(m.kind) ? m.kind : "durak", bet = int(m.n);
  if (!(bet >= 1) || bet > 1e9) return err(u.id, "Ставка должна быть от 1");
  if (u.bal < bet) return err(u.id, "Не хватает монет в банке. Пополни банк в «Бонусах»");
  const max = kind === "durak" ? Math.min(4, Math.max(2, int(m.max) || 2)) : 2;
  u.bal -= bet;
  const r = { code: genCode(), kind, bet, max, host: u.id, pl: [{ id: u.id, name: u.name, skin: u.sel, hand: [], out: 0 }], g: null, ts: Date.now() };
  rooms.set(r.code, r); inRoom.set(u.id, r.code); pushMe(u); markDirty(true); sendRoom(r);
}
function joinRoom(u, m) {
  const r = rooms.get(String(m.code || "").toUpperCase());
  if (!r || r.g) return err(u.id, "Стол не найден или игра уже идёт");
  if (inRoom.has(u.id)) return err(u.id, "Ты уже за столом");
  if (r.pl.length >= r.max) return err(u.id, "Стол заполнен");
  if (u.bal < r.bet) return err(u.id, "Не хватает монет в банке: ставка " + r.bet);
  u.bal -= r.bet;
  r.pl.push({ id: u.id, name: u.name, skin: u.sel, hand: [], out: 0 });
  inRoom.set(u.id, r.code); pushMe(u); markDirty(true); sendRoom(r);
  if (r.kind !== "durak" && r.pl.length === r.max) startBoard(r);
}
function closeWaiting(r) {
  r.pl.forEach(p => { const u = DB.users[p.id]; u.bal += r.bet; pushMe(u); send(p.id, { t: "room" }); });
  closeGame(r);
}
function leave(u) {
  const r = myRoom(u);
  if (!r) { inRoom.delete(u.id); return; }
  if (!r.g) {
    if (r.host === u.id) return closeWaiting(r);
    r.pl = r.pl.filter(p => p.id !== u.id); inRoom.delete(u.id);
    u.bal += r.bet; pushMe(u); markDirty(true); send(u.id, { t: "room" }); return sendRoom(r);
  }
  if (r.kind === "durak") {
    const p = r.pl.find(x => x.id === u.id);
    if (p.out) { p.left = 1; inRoom.delete(u.id); return; }   // уже вышел из игры победителем: просто уходит
    return abandonDurak(r, u.id);
  }
  endBoard(r, u.id, "left");
}

/* --- шахматы / шашки: сервер хранит ставки, очередь ходов и результат --- */
function startBoard(r) {
  const ids = r.pl.map(p => p.id); if (Math.random() < .5) ids.reverse();
  r.g = { side: { [ids[0]]: "w", [ids[1]]: "b" }, turn: "w" };
  r.pl.forEach(p => { const o = r.pl.find(x => x.id !== p.id); send(p.id, { t: "gstart", kind: r.kind, side: r.g.side[p.id], opp: o.name, bet: r.bet }); });
}
function endBoard(r, loserId, how) {
  if (how === "draw") r.pl.forEach(p => { credit(p.id, r.bet); send(p.id, { t: "end", kind: r.kind, win: 2, n: r.bet }); });
  else {
    const left = how === "left" ? 1 : undefined;
    r.pl.forEach(p => {
      if (p.id === loserId) send(p.id, { t: "end", kind: r.kind, win: 0, n: 0, left });
      else { credit(p.id, r.bet * 2); send(p.id, { t: "end", kind: r.kind, win: 1, n: r.bet * 2, left }); }
    });
  }
  closeGame(r);
}
function boardMove(u, m) {
  const r = myRoom(u); if (!r || !r.g || r.kind === "durak" || m.m == null) return;
  if (r.g.side[u.id] !== r.g.turn) return;
  r.g.turn = r.g.turn === "w" ? "b" : "w";
  const o = r.pl.find(p => p.id !== u.id); send(o.id, { t: "mv", m: m.m });
}
function boardRes(u, m) {
  const r = myRoom(u); if (!r || !r.g || r.kind === "durak") return;
  if (m.r === "lose") endBoard(r, u.id, "lose");
  else if (m.r === "draw" && r.g.side[u.id] === r.g.turn) endBoard(r, u.id, "draw");
}

/* --- дурак (подкидной, 36 карт) --- */
const rk = c => c % 9, su = c => Math.floor(c / 9);
const beats = (a, d, ts) => su(a) === su(d) ? rk(d) > rk(a) : su(d) === ts && su(a) !== ts;
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1);[a[i], a[j]] = [a[j], a[i]]; } return a; };
const alive = r => r.pl.filter(p => !p.out);
const nxt = (r, i) => { for (let k = 1; k <= r.pl.length; k++) { const j = (i + k) % r.pl.length; if (!r.pl[j].out) return j; } return i; };
const srt = (p, ts) => p.hand.sort((a, b) => (su(a) === ts) - (su(b) === ts) || su(a) - su(b) || rk(a) - rk(b));
function startDurak(r) {
  const deck = shuffle(Array.from({ length: 36 }, (_, i) => i)), ts = su(deck[0]);
  r.pl.forEach(p => { p.skin = DB.users[p.id].sel; p.out = 0; p.left = 0; p.hand = deck.splice(deck.length - 6, 6); });
  let att = crypto.randomInt(r.pl.length), best = 99;
  r.pl.forEach((p, i) => p.hand.forEach(c => { if (su(c) === ts && rk(c) < best) { best = rk(c); att = i; } }));
  r.g = { deck, tc: deck[0], ts, tb: [], disc: [], att, def: 0, lim: 5, tk: 0, conf: { a: 0, d: 0 }, done: {}, bout: 1, sus: {}, cheats: {}, cb: {}, ab: {} };
  r.g.def = nxt(r, att); r.g.lim = Math.min(5, r.pl[r.g.def].hand.length);
  r.pl.forEach(p => srt(p, r.g.ts)); sendG(r);
}
function canThrow(r, i) {
  const g = r.g, p = r.pl[i];
  if (i === g.def || p.out || !p.hand.length) return false;
  if (!g.tb.length) return i === g.att;
  if (g.tb.length >= g.lim) return false;
  if (!g.tk && g.tb.filter(x => x.d == null).length >= r.pl[g.def].hand.length) return false;
  return p.hand.some(c => g.tb.some(x => rk(x.a) === rk(c) || (x.d != null && rk(x.d) === rk(c))));
}
function playD(r, i, m) {
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
function actD(r, i) {
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
  const al = alive(r); if (al.length <= 1) return finishDurak(r, al[0]);
  g.att = took || r.pl[g.def].out ? nxt(r, g.def) : g.def; g.def = nxt(r, g.att); g.lim = Math.min(6, r.pl[g.def].hand.length);
  sendG(r);
}
function finishDurak(r, loser) {
  const n = r.pl.length, bonus = Math.floor(r.bet / (n - 1));
  r.pl.forEach(p => {
    let win = 2, amt = r.bet;
    if (loser && p.id === loser.id) { win = 0; amt = 0; } else if (loser) { win = 1; amt = r.bet + bonus; }
    DB.users[p.id].bal += amt; send(p.id, { t: "end", win, n: amt, durak: loser ? loser.name : "" }); pushMe(DB.users[p.id]);
  });
  closeGame(r);
}
function abandonDurak(r, id) {
  const n = r.pl.length, bonus = Math.floor(r.bet / (n - 1)), who = DB.users[id].name;
  r.pl.forEach(p => { const me = p.id === id, amt = me ? 0 : r.bet + bonus; DB.users[p.id].bal += amt; send(p.id, { t: "end", win: me ? 0 : 1, n: amt, durak: who, left: 1 }); pushMe(DB.users[p.id]); });
  closeGame(r);
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
    pl: r.pl.map((x, j) => ({ id: x.id, name: x.name, skin: x.skin, n: x.hand.length, out: x.out, role: j === g.att ? "a" : j === g.def ? "d" : "t", ok: j === g.att ? g.conf.a : j === g.def ? g.conf.d : g.done[j] ? 1 : 0 })),
    ch: { can: g.disc.length > 0 && (g.cheats[p.id] || 0) < 2 && g.cb[p.id] !== g.bout && !p.out, sus: !!g.sus[p.id] }
  };
}
const sendG = r => r.pl.forEach(p => { if (!p.left) send(p.id, view(r, p)); });
const evAll = (r, m) => r.pl.forEach(p => send(p.id, { t: "ev", m }));
function pay(from, to, n) { const a = Math.min(n, from.bal); from.bal -= a; to.bal += a; pushMe(from); pushMe(to); markDirty(true); return a; }
function cheatD(r, u) {
  const g = r.g, p = r.pl.find(x => x.id === u.id);
  if (p.out || !g.disc.length) return err(u.id, "Нечего подменять: бито пусто");
  if ((g.cheats[u.id] || 0) >= 2 || g.cb[u.id] === g.bout) return err(u.id, "Шулерить можно не чаще раза за ход (2 раза за игру)");
  const c = g.disc.splice(crypto.randomInt(g.disc.length), 1)[0];
  p.hand.push(c); srt(p, g.ts); g.cheats[u.id] = (g.cheats[u.id] || 0) + 1; g.cb[u.id] = g.bout; g.sus[u.id] = g.bout;
  send(u.id, { t: "ev", m: "Карта из рукава у тебя! Не попадись", me: 1 }); sendG(r);
}
function accD(r, u, m) {
  const g = r.g, t = r.pl.find(x => x.id === m.to);
  if (!t || t.id === u.id) return;
  if (g.ab[u.id] === g.bout) return err(u.id, "Обвинять можно раз за ход");
  g.ab[u.id] = g.bout;
  if (g.sus[t.id] && g.sus[t.id] >= g.bout - 1) {
    delete g.sus[t.id]; if (t.hand.length) g.disc.push(t.hand.splice(crypto.randomInt(t.hand.length), 1)[0]);
    const a = pay(DB.users[t.id], u, r.bet); evAll(r, u.name + " поймал шулера " + t.name + "! Штраф " + a + " 🪙");
  } else { const a = pay(u, DB.users[t.id], Math.ceil(r.bet / 2)); evAll(r, u.name + " ложно обвинил " + t.name + " и заплатил " + a + " 🪙"); }
  sendG(r);
}
const durakRoom = u => { const r = myRoom(u); return r && r.kind === "durak" && r.g ? r : null; };

/* ================= общий краш ================= */
const CR = { ph: "wait", t0: Date.now(), cp: 0, crashAt: 0, hist: [], pl: new Map(), subs: new Set(), lastB: 0 };
const genCp = () => { const r = crypto.randomBytes(4).readUInt32BE() / 4294967296; return Math.min(200, Math.max(1, Math.floor(95 / (1 - r)) / 100)); };
function crState() {
  const s = { t: "cr", ph: CR.ph, age: Date.now() - CR.t0, hist: CR.hist, pl: [...CR.pl.values()].map(b => ({ n: b.name, b: b.b, c: b.c })) };
  if (CR.ph === "crash") s.cp = CR.cp; return s;
}
function crBroadcast() {
  CR.lastB = Date.now(); if (!CR.subs.size) return;
  const raw = JSON.stringify(crState());
  for (const ws of CR.subs) if (ws.readyState === 1) ws.send(raw);
}
function crCash(b, mult) {
  b.c = Math.max(1, Math.floor(mult * 100) / 100);
  let n = Math.floor(b.b * mult); const k = DB.lk.crash;
  if (k != null && k !== 1) { const p = n - b.b; if (p > 0) n = Math.floor(b.b + p * k); }
  if (online.has(b.id)) send(b.id, { t: "cwin", n, m: b.c }); else credit(b.id, n);   // оффлайн: выигрыш падает в банк
  crBroadcast();
}
function crTick() {
  const now = Date.now(), age = now - CR.t0;
  if (CR.ph === "wait") { if (age >= 7000) { CR.ph = "run"; CR.t0 = now; CR.cp = genCp(); CR.crashAt = 5000 * Math.log(CR.cp); crBroadcast(); } }
  else if (CR.ph === "run") {
    const t = now - CR.t0, m = Math.exp(t / 5000);
    for (const b of CR.pl.values()) if (!b.c && b.au >= 1.1 && b.au <= CR.cp && (m >= b.au || t >= CR.crashAt)) crCash(b, b.au);
    if (t >= CR.crashAt) { CR.ph = "crash"; CR.t0 = now; CR.hist.unshift(CR.cp); CR.hist.length = Math.min(CR.hist.length, 12); crBroadcast(); }
  } else if (age >= 3500) { CR.ph = "wait"; CR.t0 = now; CR.pl = new Map(); CR.cp = 0; crBroadcast(); }
  if (now - CR.lastB >= 300) crBroadcast();
}
function crBet(u, m) {
  if (CR.ph !== "wait") return err(u.id, "Ставки на этот раунд закрыты");
  const b = int(m.n); if (!(b >= 1) || b > 1e9 || CR.pl.has(u.id)) return;
  const au = +m.au; CR.pl.set(u.id, { id: u.id, name: u.name, b, au: au >= 1.1 && au <= 1000 ? au : 0, c: 0 });
  crBroadcast();
}
function crCashReq(u) {
  const b = CR.pl.get(u.id); if (!b || b.c || CR.ph !== "run") return;
  const t = Date.now() - CR.t0; if (t >= CR.crashAt) return;
  crCash(b, Math.min(Math.exp(t / 5000), CR.cp));
}

/* ================= админка ================= */
const pwOk = x => { const h = s => crypto.createHash("sha256").update(String(s)).digest(); return crypto.timingSafeEqual(h(x), h(ADMIN_PASSWORD)); };
function admin(ws, u, m) {
  if (!ADMIN_PASSWORD) return sendWs(ws, { t: "err", m: "На сервере не задан ADMIN_PASSWORD" });
  if (ws.block && ws.block > Date.now()) return;
  if (!pwOk(m.pw)) { if (++ws.fail >= 5) { ws.block = Date.now() + 60000; ws.fail = 0; } return sendWs(ws, { t: "admr", bad: 1 }); }
  ws.fail = 0;
  const ok = msg => sendWs(ws, { t: "admr", m: msg }), tg = DB.users[m.id];
  switch (m.op) {
    case "list": {
      const q = clip(m.q, 40).toLowerCase().replace(/^@/, "");
      const list = Object.values(DB.users).filter(x => !q || x.id.toLowerCase().includes(q) || x.name.toLowerCase().includes(q) || (x.username || "").toLowerCase().includes(q))
        .sort((a, b) => (online.has(b.id) - online.has(a.id)) || b.seen - a.seen).slice(0, 30)
        .map(x => ({ id: x.id, name: x.name, username: x.username, on: online.has(x.id), bal: x.bal, gb: x.gb }));
      return sendWs(ws, { t: "adml", u: list, lk: DB.lk });
    }
    case "bank": {
      const n = int(m.n); if (!tg || !n) return ok("Выбери игрока и введи сумму");
      const was = tg.bal; tg.bal = Math.max(0, tg.bal + n); pushMe(tg); markDirty(true);
      return ok("Банк " + tg.name + ": " + (tg.bal - was >= 0 ? "+" : "") + (tg.bal - was));
    }
    case "game": {
      const n = int(m.n); if (!tg || !n) return ok("Выбери игрока и введи сумму");
      tg.gb = Math.max(0, tg.gb + n);
      if (online.has(tg.id)) send(tg.id, { t: "gadj", n }); else tg.pend += n;
      markDirty(true); return ok("Игровой счёт " + tg.name + ": " + (n > 0 ? "+" : "") + n);
    }
    case "lk": {
      const v = Math.min(5, Math.max(0, +m.v));
      if (!LK_KEYS.includes(m.k) || !Number.isFinite(v)) return ok("Неверное значение");
      DB.lk[m.k] = v; markDirty(true);
      for (const w of online.values()) sendWs(w, { t: "cfg", lk: DB.lk });
      return ok("Шанс «" + m.k + "»: ×" + v);
    }
    case "grant": {
      if (!tg || !ITEMS[m.k]) return ok("Выбери игрока и предмет");
      if (!tg.skins.includes(m.k)) tg.skins.push(m.k);
      pushMe(tg); markDirty(true); send(tg.id, { t: "ev", m: "Тебе выдан предмет: " + ITEMS[m.k], me: 1 });
      return ok("Выдано " + tg.name + ": " + ITEMS[m.k]);
    }
  }
}

/* ================= обработка сообщений ================= */
function onMessage(ws, m) {
  if (m.t === "auth") return auth(ws, m);
  const u = ws.uid && DB.users[ws.uid]; if (!u) return;
  switch (m.t) {
    case "gb": { const b = int(m.bal); if (b >= 0 && b < 1e15) { u.gb = b; markDirty(); } break; }
    case "dep": { const n = int(m.n); if (!(n >= 1) || n > 1e12) return err(u.id, "Неверная сумма"); u.bal += n; pushMe(u); markDirty(true); break; }
    case "wd": {
      const n = int(m.n); if (!(n >= 1)) return err(u.id, "Неверная сумма");
      if (u.bal < n) return err(u.id, "Недостаточно монет в банке");
      u.bal -= n; send(u.id, { t: "wd", n }); pushMe(u); markDirty(true); break;
    }
    case "send": {
      const n = int(m.n), to = clip(m.to, 40).replace(/^@/, "").toLowerCase();
      if (!(n >= 1)) return err(u.id, "Неверная сумма");
      const tg = DB.users[to] || Object.values(DB.users).find(x => x.username && x.username.toLowerCase() === to);
      if (!tg) return err(u.id, "Игрок не найден (он должен хотя бы раз открыть игру)");
      if (tg.id === u.id) return err(u.id, "Нельзя отправить самому себе");
      if (u.bal < n) return err(u.id, "Недостаточно монет в банке");
      u.bal -= n; tg.bal += n; pushMe(u); pushMe(tg); markDirty(true);
      send(tg.id, { t: "in", from: u.name, n }); send(u.id, { t: "ev", m: "Отправлено " + n + " 🪙 игроку " + tg.name, me: 1 }); break;
    }
    case "skins": if (typeof m.sel === "string" && u.skins.includes(m.sel) && u.sel !== m.sel) { u.sel = m.sel; markDirty(); } break;   // ответа нет намеренно: иначе клиент зациклится
    case "mk": mkRoom(u, m); break;
    case "jn": joinRoom(u, m); break;
    case "leave": leave(u); break;
    case "start": { const r = myRoom(u); if (!r || r.g || r.kind !== "durak" || r.host !== u.id) return; if (r.pl.length < 2) return err(u.id, "Нужно минимум 2 игрока"); r.max = r.pl.length; startDurak(r); break; }
    case "play": { const r = durakRoom(u); if (r) playD(r, r.pl.findIndex(p => p.id === u.id), { c: int(m.c), tgt: m.tgt }); break; }
    case "act": { const r = durakRoom(u); if (r) actD(r, r.pl.findIndex(p => p.id === u.id)); break; }
    case "st": { const r = durakRoom(u); if (r && EMOJI.includes(m.e)) r.pl.forEach(p => { if (p.id !== u.id && !p.left) send(p.id, { t: "stk", id: u.id, e: m.e }); }); break; }
    case "cheat": { const r = durakRoom(u); if (r) cheatD(r, u); break; }
    case "acc": { const r = durakRoom(u); if (r) accD(r, u, m); break; }
    case "mv": boardMove(u, m); break;
    case "gres": boardRes(u, m); break;
    case "csub": CR.subs.add(ws); sendWs(ws, crState()); break;
    case "cunsub": CR.subs.delete(ws); break;
    case "cbet": crBet(u, m); break;
    case "ccash": crCashReq(u); break;
    case "adm": admin(ws, u, m); break;
  }
}

/* ================= запуск ================= */
const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" }); res.end("Lucky Nova server OK"); });
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
wss.on("connection", ws => {
  ws.uid = null; ws.fail = 0; ws.alive = true;
  ws.on("pong", () => ws.alive = true);
  ws.on("message", data => {
    ws.alive = true;
    const now = Date.now(); ws.tk = Math.min(60, (ws.tk == null ? 60 : ws.tk) + (now - (ws.tl || now)) / 1000 * 30); ws.tl = now;
    if (ws.tk < 1) return; ws.tk--;
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;
    try { onMessage(ws, m); } catch (e) { console.error("handler error:", m.t, e); }
  });
  ws.on("error", () => { });
  ws.on("close", () => {
    CR.subs.delete(ws);
    if (!ws.uid || online.get(ws.uid) !== ws) return;
    const id = ws.uid; online.delete(id); DB.users[id].seen = Date.now(); markDirty();
    if (inRoom.has(id)) timers.set(id, setTimeout(() => { timers.delete(id); if (!online.has(id)) leave(DB.users[id]); }, GRACE_MS));
  });
});
function boot() {
  setInterval(crTick, 50);
  setInterval(() => wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; try { ws.ping(); } catch (e) { } }), 30000);
  setInterval(() => { for (const r of rooms.values()) if (!r.g && Date.now() - r.ts > 30 * 60000) closeWaiting(r); }, 60000);
  server.listen(PORT, () => console.log("Lucky Nova server on :" + PORT, REDIS_URL ? "(Upstash)" : "(file " + DATA_FILE + ")", BOT_TOKEN ? "" : "WARNING: BOT_TOKEN не задан"));
}
const shutdown = async () => { try { clearTimeout(timer); dirty = true; saving = false; await flush(); } catch (e) { } process.exit(0); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
process.on("uncaughtException", e => console.error("uncaught:", e));
process.on("unhandledRejection", e => console.error("unhandled:", e));
loadDB().then(boot).catch(e => { console.error("Не удалось загрузить данные, остановка (чтобы не затереть их):", e.message); process.exit(1); });
