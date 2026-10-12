"use strict";
/* Lucky Nova server: банк, переводы, скины, дурак онлайн, шахматы/шашки онлайн,
   общий краш, админ-панель. Один процесс, данные в JSON-файле. */
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_PW = process.env.ADMIN_PASSWORD || "";
const ALLOW_GUEST = process.env.ALLOW_GUEST === "1" || !BOT_TOKEN; // без токена бота: гостевой режим для тестов
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "db.json");

/* ===================== хранилище ===================== */
let db = { users: {}, cfg: { lk: {} } };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  db.users = db.users || {}; db.cfg = db.cfg || {}; db.cfg.lk = db.cfg.lk || {};
} catch (e) { /* первый запуск */ }
let dirty = false;
const mark = () => { dirty = true; };
function flush() {
  if (!dirty) return; dirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { console.error("save error:", e.message); dirty = true; }
}
setInterval(flush, 10000);
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { flush(); process.exit(0); });

const SKINS = ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8"];
const FRAMES = ["f1", "f2", "f3"];
const ITEMS = new Set([...SKINS, ...FRAMES]);
const LKN = new Set(["slot", "candy", "crash", "roul", "mines", "hl", "poker", "bj", "durak", "chess", "checkers"]);
const EM = ["😊", "🤐", "😘", "😎", "🤡", "👍", "👎"];
const ITEM_NAMES = { k1: "Неон", k2: "Золото", k3: "Бриллиант", k4: "Изумруд", k5: "Рубин", k6: "Обсидиан", k7: "Лёд", k8: "Космос", f1: "Золотая рамка", f2: "Неоновая рамка", f3: "Изумрудная рамка" };

/* имена попадают в innerHTML на клиенте: вычищаем опасные символы */
const clean = s => String(s == null ? "" : s).replace(/[<>&"'`\\\u0000-\u001f]/g, "").trim().slice(0, 24);

const U = id => db.users[id];
function getUser(id, name, username) {
  let u = db.users[id];
  if (!u) { u = db.users[id] = { id, name, username, bal: 0, gb: 0, skins: ["k0"], sel: "k0", pend: 0 }; }
  if (name) u.name = name;
  u.username = username || "";
  mark(); return u;
}

/* ===================== сокеты ===================== */
const RT = new Map(); // id -> { socks:Set, timer }
const rt = id => RT.get(id) || (RT.set(id, { socks: new Set(), timer: null }), RT.get(id));
const online = id => { const r = RT.get(id); return !!(r && r.socks.size); };
const sendW = (w, o) => { if (w.readyState === 1) w.send(JSON.stringify(o)); };
const sendU = (id, o) => { const r = RT.get(id); if (!r) return; const s = JSON.stringify(o); for (const w of r.socks) if (w.readyState === 1) w.send(s); };
const err = (id, m) => sendU(id, { t: "err", m });
const pushMe = id => { const u = U(id); if (u) sendU(id, { t: "me", id: u.id, name: u.name, bal: u.bal, skins: u.skins, sel: u.sel }); };
function addBal(id, n) { const u = U(id); u.bal = Math.max(0, Math.floor(u.bal + n)); mark(); pushMe(id); }
const toAll = o => { const s = JSON.stringify(o); for (const r of RT.values()) for (const w of r.socks) if (w.readyState === 1) w.send(s); };

/* ===================== Telegram initData ===================== */
function checkInit(init) {
  try {
    const p = new URLSearchParams(init), hash = p.get("hash");
    if (!hash) return null; p.delete("hash");
    const str = [...p.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => k + "=" + v).join("\n");
    const sec = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const h = crypto.createHmac("sha256", sec).update(str).digest("hex");
    const a = Buffer.from(h), b = Buffer.from(hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const ad = +p.get("auth_date");
    if (!ad || Date.now() / 1000 - ad > 86400 * 30) return null;
    return JSON.parse(p.get("user"));
  } catch (e) { return null; }
}

/* ===================== комнаты ===================== */
const ROOMS = new Map(), IN = new Map(), KINDS = new Set(["durak", "chess", "checkers"]), ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const mkCode = () => { for (;;) { let c = ""; for (let i = 0; i < 4; i++) c += ABC[crypto.randomInt(ABC.length)]; if (!ROOMS.has(c)) return c; } };
const roomView = r => ({ t: "room", code: r.code, kind: r.kind, max: r.max, host: r.host, bet: r.bet, pl: r.pl.map(p => ({ id: p.id, name: p.name, skin: p.skin })) });
const bcastRoom = r => r.pl.forEach(p => sendU(p.id, roomView(r)));
const roomOf = id => ROOMS.get(IN.get(id));
function dropRoom(r) { r.ended = true; clearTimeout(r.tm); r.pl.forEach(p => IN.delete(p.id)); ROOMS.delete(r.code); }

function leave(id) {
  const r = roomOf(id);
  if (!r) { sendU(id, { t: "room" }); return; }
  if (r.started) { r.kind === "durak" ? D.abandon(r, id) : boardEnd(r, id, true); return; }
  if (r.host === id) { // хозяин закрыл стол: возвращаем ставки
    r.pl.forEach(p => { addBal(p.id, r.bet); sendU(p.id, { t: "room" }); });
    dropRoom(r);
  } else {
    addBal(id, r.bet); IN.delete(id); r.pl = r.pl.filter(p => p.id !== id);
    sendU(id, { t: "room" }); bcastRoom(r);
  }
}

/* ---------- шахматы / шашки ---------- */
function armTimer(r) {
  clearTimeout(r.tm);
  r.tm = setTimeout(() => { const p = r.pl.find(x => x.side === r.turn); if (p) boardEnd(r, p.id, false); }, 180000); // 3 минуты на ход
}
function startBoard(r) {
  const w = crypto.randomInt(2);
  r.pl[w].side = "w"; r.pl[1 - w].side = "b"; r.started = true; r.turn = "w";
  r.pl.forEach(p => { const o = r.pl.find(x => x !== p); sendU(p.id, { t: "gstart", kind: r.kind, side: p.side, opp: o.name, bet: r.bet }); });
  armTimer(r);
}
function boardEnd(r, loserId, left) { // loserId=null: ничья
  if (r.ended) return;
  const pl = r.pl.slice(); dropRoom(r);
  pl.forEach(p => {
    let win, n;
    if (!loserId) { win = 2; n = r.bet; } else if (p.id === loserId) { win = 0; n = 0; } else { win = 1; n = r.bet * 2; }
    if (n) addBal(p.id, n);
    sendU(p.id, { t: "end", kind: r.kind, win, n, left: left ? 1 : 0 });
  });
}

/* ---------- дурак (подкидной, 36 карт) ---------- */
const D = (() => {
  const rk = c => c % 9, su = c => Math.floor(c / 9);
  const beats = (a, d, ts) => su(a) === su(d) ? rk(d) > rk(a) : su(d) === ts && su(a) !== ts;
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const alive = r => r.pl.filter(p => !p.out);
  const nxt = (r, i) => { for (let k = 1; k <= r.pl.length; k++) { const j = (i + k) % r.pl.length; if (!r.pl[j].out) return j; } return i; };
  const srt = (p, ts) => p.hand.sort((a, b) => (su(a) === ts) - (su(b) === ts) || su(a) - su(b) || rk(a) - rk(b));

  function start(r) {
    const deck = shuffle(Array.from({ length: 36 }, (_, i) => i)), ts = su(deck[0]);
    r.pl.forEach(p => { p.skin = U(p.id).sel; p.out = 0; p.hand = deck.splice(deck.length - 6, 6); });
    let att = crypto.randomInt(r.pl.length), best = 99;
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
  function play(r, i, m) {
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
  function act(r, i) {
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
    const al = alive(r); if (al.length <= 1) return finish(r, al[0]);
    g.att = took || r.pl[g.def].out ? nxt(r, g.def) : g.def; g.def = nxt(r, g.att); g.lim = Math.min(6, r.pl[g.def].hand.length);
    sendG(r);
  }
  function finish(r, loser) {
    const n = r.pl.length, bonus = Math.floor(r.bet / (n - 1)), pl = r.pl.slice(); dropRoom(r);
    pl.forEach(p => {
      let win = 2, amt = r.bet;
      if (loser && p.id === loser.id) { win = 0; amt = 0; } else if (loser) { win = 1; amt = r.bet + bonus; }
      if (amt) addBal(p.id, amt);
      sendU(p.id, { t: "end", win, n: amt, durak: loser ? loser.name : "" });
    });
  }
  function abandon(r, id) {
    if (r.ended) return;
    const n = r.pl.length, bonus = Math.floor(r.bet / (n - 1)), pl = r.pl.slice(), who = U(id).name; dropRoom(r);
    pl.forEach(p => { const me = p.id === id, amt = me ? 0 : r.bet + bonus; if (amt) addBal(p.id, amt); sendU(p.id, { t: "end", win: me ? 0 : 1, n: amt, durak: who, left: 1 }); });
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
  const sendG = r => r.pl.forEach(p => sendU(p.id, view(r, p)));
  const evAll = (r, m) => r.pl.forEach(p => sendU(p.id, { t: "ev", m }));
  function pay(from, to, n) { const a = Math.min(n, from.bal); if (a > 0) { addBal(from.id, -a); addBal(to.id, a); } return a; }
  function cheat(r, id) {
    const g = r.g, p = r.pl.find(x => x.id === id);
    if (p.out || !g.disc.length) return err(id, "Нечего подменять: бито пусто");
    if ((g.cheats[id] || 0) >= 2 || g.cb[id] === g.bout) return err(id, "Шулерить можно не чаще раза за ход (2 раза за игру)");
    const c = g.disc.splice(crypto.randomInt(g.disc.length), 1)[0];
    p.hand.push(c); srt(p, g.ts); g.cheats[id] = (g.cheats[id] || 0) + 1; g.cb[id] = g.bout; g.sus[id] = g.bout;
    sendU(id, { t: "ev", m: "Карта из рукава у тебя! Не попадись", me: 1 }); sendG(r);
  }
  function acc(r, id, toId) {
    const g = r.g, t = r.pl.find(x => x.id === toId), u = U(id);
    if (!t || t.id === id) return;
    if (g.ab[id] === g.bout) return err(id, "Обвинять можно раз за ход");
    g.ab[id] = g.bout;
    if (g.sus[t.id] && g.sus[t.id] >= g.bout - 1) {
      delete g.sus[t.id];
      if (t.hand.length) g.disc.push(t.hand.splice(crypto.randomInt(t.hand.length), 1)[0]);
      const a = pay(U(t.id), u, r.bet); evAll(r, u.name + " поймал шулера " + t.name + "! Штраф " + a + " 🪙");
    } else { const a = pay(u, U(t.id), Math.ceil(r.bet / 2)); evAll(r, u.name + " ложно обвинил " + t.name + " и заплатил " + a + " 🪙"); }
    sendG(r);
  }
  return { start, play, act, cheat, acc, abandon, sendG };
})();
const gameRoom = id => { const r = roomOf(id); return r && r.g && !r.ended ? r : null; };

/* ===================== общий краш ===================== */
const CR = { ph: "wait", t: Date.now(), cp: 1, hist: [], bets: new Map(), subs: new Set(), lastB: 0 };
const genCp = () => Math.min(200, Math.max(1, Math.floor(95 / (1 - Math.random())) / 100));
const crState = () => ({ t: "cr", ph: CR.ph, age: Date.now() - CR.t, cp: CR.ph === "crash" ? CR.cp : undefined, hist: CR.hist, pl: [...CR.bets.values()].map(b => ({ n: b.name, b: b.n, c: b.c || 0 })) });
function crB() { CR.lastB = Date.now(); if (!CR.subs.size) return; const s = JSON.stringify(crState()); CR.subs.forEach(w => { if (w.readyState === 1) w.send(s); }); }
function crNew() { CR.ph = "wait"; CR.t = Date.now(); CR.bets = new Map(); CR.cp = genCp(); crB(); }
function crPay(b, mult) {
  b.c = mult;
  let win = Math.floor(b.n * mult); const k = db.cfg.lk.crash;
  if (k != null && k !== 1 && win > b.n) win = Math.floor(b.n + (win - b.n) * k);
  if ([...CR.subs].some(w => w.uid === b.id)) sendU(b.id, { t: "cwin", n: win, m: mult });
  else { addBal(b.id, win); sendU(b.id, { t: "ev", m: "Rocket Crash: +" + win + " 🪙 зачислено в банк", me: 1 }); } // игрок вышел с экрана краша
}
crNew();
setInterval(() => {
  const now = Date.now(), age = now - CR.t;
  if (CR.ph === "wait") {
    if (age >= 7000) { CR.ph = "run"; CR.t = now; crB(); } else if (now - CR.lastB >= 500) crB();
  } else if (CR.ph === "run") {
    const m = Math.exp(age / 5000);
    if (m >= CR.cp) { CR.ph = "crash"; CR.t = now; CR.hist.unshift(CR.cp); CR.hist = CR.hist.slice(0, 12); crB(); return; }
    let ch = false;
    CR.bets.forEach(b => { if (!b.c && b.au >= 1.1 && m >= b.au) { crPay(b, b.au); ch = true; } });
    if (ch || now - CR.lastB >= 500) crB();
  } else if (age >= 3500) crNew();
}, 50);

/* ===================== обработчики сообщений ===================== */
const HND = Object.create(null);
const int = (v, lo, hi) => { v = Math.floor(+v); return v >= lo && v <= hi ? v : 0; };

HND.auth = (w, m) => {
  let id, name, username = "";
  const tgu = BOT_TOKEN && m.init ? checkInit(String(m.init)) : null;
  if (tgu && tgu.id) { id = String(tgu.id); name = clean(tgu.first_name || tgu.username || "Игрок") || "Игрок"; username = clean(tgu.username || ""); }
  else if (ALLOW_GUEST) { const d = clean(m.name || ""); id = d ? "dev_" + d : "guest_" + crypto.randomBytes(3).toString("hex"); name = d || "Гость"; }
  else return sendW(w, { t: "err", m: "Открой игру через Telegram" });
  getUser(id, name, username);
  w.uid = id; const r = rt(id); r.socks.add(w); clearTimeout(r.timer);
  pushMe(id); sendW(w, { t: "cfg", lk: db.cfg.lk });
  const u = U(id); if (u.pend) { sendW(w, { t: "gadj", n: u.pend }); u.pend = 0; mark(); }
  const room = roomOf(id);
  if (room) { if (room.g) D.sendG(room); else sendW(w, roomView(room)); }
};
HND.gb = (w, m) => { const n = Math.floor(+m.bal); if (n >= 0 && n <= 1e15) { U(w.uid).gb = n; mark(); } };
HND.dep = (w, m) => { const n = int(m.n, 1, 1e12); if (n) addBal(w.uid, n); };
HND.wd = (w, m) => {
  const n = int(m.n, 1, 1e12), u = U(w.uid); if (!n) return;
  if (u.bal < n) return err(u.id, "В банке не хватает монет");
  addBal(u.id, -n); sendU(u.id, { t: "wd", n });
};
HND.send = (w, m) => {
  const n = int(m.n, 1, 1e12), me = U(w.uid), key = String(m.to || "").trim().replace(/^@/, "").toLowerCase();
  if (!n || !key) return err(me.id, "Укажи получателя и сумму");
  const t = Object.values(db.users).find(x => x.id.toLowerCase() === key || (x.username && x.username.toLowerCase() === key));
  if (!t) return err(me.id, "Игрок не найден");
  if (t.id === me.id) return err(me.id, "Нельзя отправить самому себе");
  if (me.bal < n) return err(me.id, "В банке не хватает монет");
  addBal(me.id, -n); addBal(t.id, n);
  sendU(t.id, { t: "in", from: me.name, n });
  sendU(me.id, { t: "ev", m: "Отправлено " + n + " 🪙 → " + t.name, me: 1 });
};
HND.skins = (w, m) => {
  const u = U(w.uid); if (!Array.isArray(m.own)) return;
  m.own.forEach(s => { if (SKINS.includes(s) && !u.skins.includes(s)) u.skins.push(s); }); // рамки только через админа
  if (u.skins.includes(m.sel) && SKINS.includes(m.sel)) u.sel = m.sel;
  mark();
};

HND.mk = (w, m) => {
  const id = w.uid, u = U(id);
  if (IN.has(id)) return err(id, "Ты уже за столом");
  const kind = KINDS.has(m.kind) ? m.kind : "durak", bet = int(m.n, 1, 1e9);
  if (!bet) return err(id, "Неверная ставка");
  if (u.bal < bet) return err(id, "В банке не хватает монет для ставки");
  const max = kind === "durak" ? Math.min(4, Math.max(2, Math.floor(+m.max) || 2)) : 2;
  addBal(id, -bet);
  const r = { code: mkCode(), kind, max, bet, host: id, pl: [{ id, name: u.name, skin: u.sel }], g: null, started: false };
  ROOMS.set(r.code, r); IN.set(id, r.code); bcastRoom(r);
};
HND.jn = (w, m) => {
  const id = w.uid, u = U(id), r = ROOMS.get(String(m.code || "").toUpperCase());
  if (IN.has(id)) return err(id, "Ты уже за столом");
  if (!r) return err(id, "Стол не найден");
  if (r.started) return err(id, "Игра уже идёт");
  if (r.pl.length >= r.max) return err(id, "Стол заполнен");
  if (u.bal < r.bet) return err(id, "В банке не хватает монет: ставка " + r.bet);
  addBal(id, -r.bet); r.pl.push({ id, name: u.name, skin: u.sel }); IN.set(id, r.code);
  if (r.kind !== "durak" && r.pl.length === 2) startBoard(r); else bcastRoom(r);
};
HND.start = w => {
  const r = roomOf(w.uid);
  if (!r || r.kind !== "durak" || r.started || r.host !== w.uid) return;
  if (r.pl.length < 2) return err(w.uid, "Нужен хотя бы один соперник");
  r.started = true; D.start(r);
};
HND.leave = w => leave(w.uid);
HND.play = (w, m) => { const r = gameRoom(w.uid); if (!r || !Number.isInteger(m.c)) return; D.play(r, r.pl.findIndex(p => p.id === w.uid), { c: m.c, tgt: m.tgt }); };
HND.act = w => { const r = gameRoom(w.uid); if (r) D.act(r, r.pl.findIndex(p => p.id === w.uid)); };
HND.cheat = w => { const r = gameRoom(w.uid); if (r) D.cheat(r, w.uid); };
HND.acc = (w, m) => { const r = gameRoom(w.uid); if (r) D.acc(r, w.uid, String(m.to)); };
HND.st = (w, m) => {
  const r = roomOf(w.uid); if (!r || !EM.includes(m.e)) return;
  r.pl.forEach(p => { if (p.id !== w.uid) sendU(p.id, { t: "stk", id: w.uid, e: m.e }); });
};
HND.mv = (w, m) => {
  const r = roomOf(w.uid); if (!r || !r.started || r.kind === "durak" || r.ended || !m.m) return;
  const me = r.pl.find(p => p.id === w.uid), op = r.pl.find(p => p.id !== w.uid);
  if (!op || me.side !== r.turn || JSON.stringify(m.m).length > 2000) return;
  r.turn = r.turn === "w" ? "b" : "w"; armTimer(r); sendU(op.id, { t: "mv", m: m.m });
};
HND.gres = (w, m) => {
  const r = roomOf(w.uid); if (!r || !r.started || r.kind === "durak" || r.ended) return;
  const me = r.pl.find(p => p.id === w.uid);
  if (m.r === "lose") boardEnd(r, w.uid, false);
  else if (m.r === "draw" && me.side === r.turn) boardEnd(r, null, false); // пат объявляет тот, чей ход
};

/* краш */
HND.csub = w => { CR.subs.add(w); sendW(w, crState()); };
HND.cunsub = w => { CR.subs.delete(w); };
HND.cbet = w => { /* см. ниже (нужен m) */ };
HND.cbet = (w, m) => {
  const id = w.uid, n = int(m.n, 1, 1e9);
  if (CR.ph !== "wait" || !n || CR.bets.has(id)) return;
  const au = +m.au >= 1.1 ? Math.min(+m.au, 200) : 0;
  CR.bets.set(id, { id, name: U(id).name, n, au, c: 0 }); crB();
};
HND.ccash = w => {
  const b = CR.bets.get(w.uid);
  if (CR.ph !== "run" || !b || b.c) return;
  const m = Math.exp((Date.now() - CR.t) / 5000);
  if (m >= CR.cp) return;
  crPay(b, Math.max(1, Math.floor(m * 100) / 100)); crB();
};

/* админ-панель */
const admFails = [];
function admOk(m) {
  const now = Date.now(); while (admFails.length && now - admFails[0] > 600000) admFails.shift();
  if (!ADMIN_PW || admFails.length >= 10 || typeof m.pw !== "string") return false;
  const a = Buffer.from(m.pw), b = Buffer.from(ADMIN_PW);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) admFails.push(now); return ok;
}
HND.adm = (w, m) => {
  if (!admOk(m)) return sendW(w, { t: "admr", bad: 1 });
  const t = m.id ? U(String(m.id)) : null, n = Math.trunc(+m.n) || 0;
  switch (m.op) {
    case "list": {
      const q = String(m.q || "").toLowerCase().replace(/^@/, "");
      const u = Object.values(db.users)
        .filter(x => !q || x.id.toLowerCase().includes(q) || x.name.toLowerCase().includes(q) || (x.username || "").toLowerCase().includes(q))
        .sort((a, b) => (online(b.id) - online(a.id)) || b.bal - a.bal).slice(0, 50)
        .map(x => ({ id: x.id, name: x.name, username: x.username, on: online(x.id), bal: x.bal, gb: x.gb }));
      return sendW(w, { t: "adml", u, lk: db.cfg.lk });
    }
    case "bank":
      if (!t || !n) return sendW(w, { t: "admr", m: "Выбери игрока и сумму" });
      addBal(t.id, n); return sendW(w, { t: "admr", m: "Банк " + t.name + ": " + (n > 0 ? "+" : "") + n });
    case "game":
      if (!t || !n) return sendW(w, { t: "admr", m: "Выбери игрока и сумму" });
      if (online(t.id)) { sendU(t.id, { t: "gadj", n }); t.gb = Math.max(0, (t.gb || 0) + n); } else t.pend = (t.pend || 0) + n;
      mark(); return sendW(w, { t: "admr", m: "Игра " + t.name + ": " + (n > 0 ? "+" : "") + n + (online(t.id) ? "" : " (придёт при входе)") });
    case "grant":
      if (!t || !ITEMS.has(m.k)) return sendW(w, { t: "admr", m: "Неверный игрок или предмет" });
      if (!t.skins.includes(m.k)) t.skins.push(m.k);
      mark(); pushMe(t.id); sendU(t.id, { t: "ev", m: "Тебе открыт предмет: " + (ITEM_NAMES[m.k] || m.k), me: 1 });
      return sendW(w, { t: "admr", m: "Выдано: " + (ITEM_NAMES[m.k] || m.k) + " → " + t.name });
    case "lk": {
      if (!LKN.has(m.k)) return sendW(w, { t: "admr", m: "Неизвестный режим" });
      const v = Math.min(5, Math.max(0, +m.v)); if (isNaN(v)) return;
      db.cfg.lk[m.k] = v; mark(); toAll({ t: "cfg", lk: db.cfg.lk });
      return sendW(w, { t: "admr", m: "Шанс " + m.k + " = " + v });
    }
  }
};

/* ===================== HTTP + WebSocket ===================== */
const srv = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/health") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
  if (url === "/" || url === "/index.html") {
    return fs.readFile(path.join(__dirname, "public", "index.html"), (e, d) => {
      if (e) { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); return res.end("Lucky Nova server is running"); }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }); res.end(d);
    });
  }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: srv, maxPayload: 16 * 1024 });
wss.on("connection", w => {
  w.alive = true; w.rtm = 0; w.rc = 0;
  w.on("pong", () => { w.alive = true; });
  w.on("message", d => {
    let m; try { m = JSON.parse(d); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;
    const now = Date.now(); if (now - w.rtm > 1000) { w.rtm = now; w.rc = 0; }
    if (++w.rc > 80) return; // защита от флуда
    const f = HND[m.t]; if (!f) return;
    if (m.t !== "auth" && m.t !== "adm" && !w.uid) return;
    try { f(w, m); } catch (e) { console.error("handler", m.t, e); }
  });
  w.on("close", () => {
    CR.subs.delete(w);
    const id = w.uid; if (!id) return;
    const r = RT.get(id); r.socks.delete(w);
    if (r.socks.size) return;
    const room = roomOf(id); if (!room) return;
    const grace = room.started && room.kind !== "durak" ? 15000 : 30000; // даём время переподключиться
    clearTimeout(r.timer); r.timer = setTimeout(() => { if (!r.socks.size) leave(id); }, grace);
  });
});
setInterval(() => { wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; try { w.ping(); } catch (e) {} }); }, 25000);

srv.listen(PORT, () => console.log("Lucky Nova server on :" + PORT + (BOT_TOKEN ? "" : " (гостевой режим: BOT_TOKEN не задан)") + (ADMIN_PW ? "" : " (админка выключена: ADMIN_PASSWORD не задан)")));
