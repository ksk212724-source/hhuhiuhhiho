const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ALLOW_DEV = process.env.ALLOW_DEV === "1"; // только для локальных тестов: ?dev=имя
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

/* ===== хранилище ===== */
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { users: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (e) {}
let saveT = null;
function saveNow() {
  try { const t = DB_FILE + ".tmp"; fs.writeFileSync(t, JSON.stringify(db)); fs.renameSync(t, DB_FILE); }
  catch (e) { console.error("save error", e); }
}
function save() { if (saveT) return; saveT = setTimeout(() => { saveT = null; saveNow(); }, 500); }
["SIGTERM", "SIGINT"].forEach(s => process.on(s, () => { saveNow(); process.exit(0); }));

/* ===== утилиты ===== */
const rn = n => crypto.randomInt(n);
const int = x => { x = Math.floor(+x); return Number.isSafeInteger(x) && x > 0 ? x : 0; };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rn(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const dname = u => u.username ? "@" + u.username : (u.name || "ID " + u.id);

/* ===== проверка Telegram initData ===== */
function verify(init) {
  if (!BOT_TOKEN || !init) return null;
  const p = new URLSearchParams(init), h = p.get("hash");
  if (!h) return null;
  p.delete("hash");
  const s = [...p.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
  const key = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const c = crypto.createHmac("sha256", key).update(s).digest("hex");
  if (c.length !== h.length || !crypto.timingSafeEqual(Buffer.from(c), Buffer.from(h))) return null;
  if (Date.now() / 1000 - (+p.get("auth_date") || 0) > 86400) return null;
  try { return JSON.parse(p.get("user")); } catch (e) { return null; }
}
function getUser(id, name, username) {
  let u = db.users[id];
  if (!u) u = db.users[id] = { id, name: name || "", username: username || "", bal: 0, skins: ["k0"], sel: "k0" };
  else { if (name) u.name = name; u.username = username || ""; }
  save();
  return u;
}

/* ===== соединения ===== */
const conns = new Map();      // id -> {ws, timer}
const rooms = new Map();      // code -> room
const userRoom = new Map();   // id -> room
const tx = (id, o) => { const c = conns.get(id); if (c && c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); };
const err = (u, m) => tx(u.id, { t: "err", m });
const me = u => tx(u.id, { t: "me", bal: u.bal, skins: u.skins, sel: u.sel, id: u.id, name: dname(u) });

/* ===== дурак ===== */
const RANKS = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"], SUITS = ["♠️", "♥️", "♦️", "♣️"];
const rv = c => RANKS.indexOf(c.r);
const beats = (d, a, tr) => (d.s === a.s && rv(d) > rv(a)) || (d.s === tr.s && a.s !== tr.s);
const oppOf = (room, id) => room.p.find(x => x !== id);
const defOf = room => oppOf(room, room.g.att);

function sortHand(g) {
  Object.values(g.hands).forEach(h => h.sort((x, y) =>
    (x.s === g.trump.s) - (y.s === g.trump.s) || SUITS.indexOf(x.s) - SUITS.indexOf(y.s) || rv(x) - rv(y)));
}
function newCode() {
  const L = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (;;) { let c = ""; for (let i = 0; i < 4; i++) c += L[rn(L.length)]; if (!rooms.has(c)) return c; }
}
function startGame(room) {
  const deck = [];
  SUITS.forEach(s => RANKS.forEach(r => deck.push({ r, s })));
  shuffle(deck);
  const trump = deck[0]; // нижняя карта колоды
  const hands = {};
  room.p.forEach(id => hands[id] = []);
  for (let i = 0; i < 6; i++) room.p.forEach(id => hands[id].push(deck.pop()));
  let att = null, low = 99;
  room.p.forEach(id => hands[id].forEach(c => { if (c.s === trump.s && rv(c) < low) { low = rv(c); att = id; } }));
  if (!att) att = room.p[rn(2)];
  room.g = { deck, trump, hands, att, table: [], tk: false, lim: 6, busy: false };
  sortHand(room.g);
  pushState(room);
}
function canThrow(room) {
  const g = room.g;
  if (g.table.length >= g.lim) return false;
  const ranks = new Set(); g.table.forEach(p => { ranks.add(p.a.r); if (p.d) ranks.add(p.d.r); });
  return g.hands[g.att].some(c => ranks.has(c.r));
}
function pushState(room) {
  const g = room.g; if (!g) return;
  const undef = g.table.some(p => !p.d);
  room.p.forEach(id => {
    const att = id === g.att, o = oppOf(room, id);
    let act = null;
    if (!g.busy) {
      if (!att) { if (!g.tk && undef) act = "take"; }
      else if (g.table.length && (g.tk || !undef)) act = "done";
    }
    tx(id, { t: "g", att, tk: g.tk, tb: g.table.map(p => ({ a: p.a, d: p.d })), h: g.hands[id],
      oc: g.hands[o].length, opp: dname(db.users[o]), bet: room.bet, dn: g.deck.length, tc: g.trump, act });
  });
}
function checkAuto(room) {
  const g = room.g, undef = g.table.some(p => !p.d);
  pushState(room);
  let fn = null;
  if (g.tk) { if (!canThrow(room)) fn = endTake; }
  else if (g.table.length && !undef && !canThrow(room)) fn = endBito;
  if (fn) { g.busy = true; pushState(room); setTimeout(() => { if (room.g === g) fn(room); }, 900); }
}
function refill(room) {
  const g = room.g;
  [g.att, defOf(room)].forEach(id => { while (g.hands[id].length < 6 && g.deck.length) g.hands[id].push(g.deck.pop()); });
}
function nextRound(room) {
  const g = room.g;
  if (!g.deck.length) {
    const e = room.p.map(id => g.hands[id].length === 0);
    if (e[0] && e[1]) return finish(room, null);
    if (e[0]) return finish(room, room.p[0]);
    if (e[1]) return finish(room, room.p[1]);
  }
  g.table = []; g.tk = false; g.busy = false;
  g.lim = Math.min(6, g.hands[defOf(room)].length);
  sortHand(g);
  pushState(room);
}
function endBito(room) {
  const g = room.g; refill(room);
  g.att = defOf(room);
  nextRound(room);
}
function endTake(room) {
  const g = room.g, d = defOf(room);
  g.table.forEach(p => { g.hands[d].push(p.a); if (p.d) g.hands[d].push(p.d); });
  g.table = []; refill(room);
  nextRound(room);
}

/* ===== комнаты и расчёт ===== */
function cancelRoom(room) {
  room.p.forEach(id => {
    const u = db.users[id]; u.bal += room.bet; userRoom.delete(id);
    tx(id, { t: "room", code: null }); me(u);
  });
  rooms.delete(room.code); save();
}
function finish(room, winId) {
  rooms.delete(room.code); room.g = null;
  room.p.forEach(id => {
    const u = db.users[id]; userRoom.delete(id);
    let win, n;
    if (winId === null) { u.bal += room.bet; win = 2; n = room.bet; }
    else if (id === winId) { u.bal += room.bet * 2; win = 1; n = room.bet * 2; }
    else { win = 0; n = 0; }
    me(u); tx(id, { t: "end", win, n });
  });
  save();
}
function abandon(u) {
  const room = userRoom.get(u.id);
  if (!room) return;
  if (room.g) finish(room, oppOf(room, u.id)); else cancelRoom(room);
}

/* ===== обработчики сообщений ===== */
const H = {
  dep(u, m) {
    const n = int(m.n); if (!n || n > 1e12) return err(u, "Неверная сумма");
    u.bal += n; save(); me(u);
  },
  wd(u, m) {
    const n = int(m.n); if (!n) return err(u, "Неверная сумма");
    if (n > u.bal) return err(u, "В банке столько нет");
    u.bal -= n; save(); me(u); tx(u.id, { t: "wd", n });
  },
  send(u, m) {
    const n = int(m.n); if (!n) return err(u, "Неверная сумма");
    const q = String(m.to || "").trim().replace(/^@/, "").toLowerCase();
    if (!q) return err(u, "Укажи ID или @username");
    const r = db.users[q] || Object.values(db.users).find(x => x.username && x.username.toLowerCase() === q);
    if (!r) return err(u, "Игрок не найден (он должен хоть раз зайти в игру)");
    if (r.id === u.id) return err(u, "Нельзя отправить самому себе");
    if (n > u.bal) return err(u, "В банке не хватает монет");
    u.bal -= n; r.bal += n; save(); me(u); me(r);
    tx(r.id, { t: "in", from: dname(u), n });
    tx(u.id, { t: "err", m: "Отправлено " + n + " 🪙 → " + dname(r) });
  },
  mk(u, m) {
    if (userRoom.has(u.id)) return err(u, "Ты уже за столом");
    const n = int(m.n); if (!n) return err(u, "Неверная ставка");
    if (u.bal < n) return err(u, "В банке не хватает монет. Положи их во вкладке «Бонусы»");
    u.bal -= n;
    const room = { code: newCode(), bet: n, p: [u.id], g: null };
    rooms.set(room.code, room); userRoom.set(u.id, room);
    save(); me(u); tx(u.id, { t: "room", code: room.code, bet: n });
  },
  jn(u, m) {
    if (userRoom.has(u.id)) return err(u, "Ты уже за столом");
    const room = rooms.get(String(m.code || "").trim().toUpperCase());
    if (!room || room.g || room.p.length !== 1) return err(u, "Стол не найден");
    if (u.bal < room.bet) return err(u, "Не хватает монет в банке: ставка " + room.bet);
    u.bal -= room.bet; room.p.push(u.id); userRoom.set(u.id, room);
    save(); me(u);
    tx(room.p[0], { t: "room", code: null });
    startGame(room);
  },
  leave(u) { abandon(u); },
  play(u, m) {
    const room = userRoom.get(u.id), g = room && room.g;
    if (!g || g.busy) return;
    const hand = g.hands[u.id], i = Math.floor(+m.c);
    if (!(i >= 0 && i < hand.length)) return;
    const card = hand[i];
    if (u.id === g.att) {
      if (g.table.length >= g.lim) return err(u, "Больше подкидывать нельзя");
      if (g.table.length) {
        const ok = g.table.some(p => p.a.r === card.r || (p.d && p.d.r === card.r));
        if (!ok) return err(u, "Нужна карта того же ранга, что на столе");
      }
      hand.splice(i, 1); g.table.push({ a: card, d: null });
    } else {
      if (g.tk) return err(u, "Ты берёшь карты");
      const p = g.table.find(p => !p.d && beats(card, p.a, g.trump));
      if (!p) return err(u, "Эта карта не бьёт");
      hand.splice(i, 1); p.d = card;
    }
    checkAuto(room);
  },
  act(u) {
    const room = userRoom.get(u.id), g = room && room.g;
    if (!g || g.busy) return;
    const undef = g.table.some(p => !p.d);
    if (u.id !== g.att) {
      if (g.tk || !undef) return;
      g.tk = true; checkAuto(room);
    } else {
      if (!g.table.length) return;
      if (g.tk) return endTake(room);
      if (undef) return err(u, "Соперник ещё не отбился");
      endBito(room);
    }
  }
};

/* ===== HTTP + WebSocket ===== */
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/health") { res.writeHead(200); return res.end("ok"); }
  if (url === "/" || url === "/index.html") {
    fs.readFile(path.join(__dirname, "index.html"), (e, d) => {
      if (e) { res.writeHead(500); return res.end("index.html not found"); }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      res.end(d);
    });
    return;
  }
  res.writeHead(404); res.end("not found");
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on("connection", ws => {
  let u = null, cnt = 0, ts = Date.now();
  ws.alive = true;
  ws.on("pong", () => ws.alive = true);
  ws.on("message", raw => {
    const now = Date.now();
    if (now - ts > 1000) { ts = now; cnt = 0; }
    if (++cnt > 20) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;
    if (m.t === "auth") {
      if (u) return;
      let tu = verify(m.init), id, name, un = "";
      if (tu && tu.id) { id = String(tu.id); name = [tu.first_name, tu.last_name].filter(Boolean).join(" "); un = tu.username || ""; }
      else if (ALLOW_DEV && m.name) { name = String(m.name).replace(/[^\w\- ]/g, "").slice(0, 20); id = "dev_" + name; }
      else { ws.send(JSON.stringify({ t: "err", m: "Ошибка авторизации. Открой игру из Telegram" })); return ws.close(); }
      u = getUser(id, name, un);
      let c = conns.get(id);
      if (c) { clearTimeout(c.timer); const old = c.ws; c.ws = ws; if (old && old !== ws) try { old.close(); } catch (e) {} }
      else conns.set(id, c = { ws, timer: null });
      c.ws = ws;
      me(u);
      const room = userRoom.get(id);
      if (room) { if (room.g) pushState(room); else tx(id, { t: "room", code: room.code, bet: room.bet }); }
      return;
    }
    if (!u) return;
    const f = H[m.t];
    if (f) try { f(u, m); } catch (e) { console.error(e); }
  });
  ws.on("close", () => {
    if (!u) return;
    const c = conns.get(u.id);
    if (!c || c.ws !== ws) return;
    c.ws = null;
    c.timer = setTimeout(() => { conns.delete(u.id); abandon(u); }, 60000); // 60 сек на переподключение
  });
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); }), 25000);

server.listen(PORT, () => console.log("Lucky Nova server on :" + PORT));
