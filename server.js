const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_PW = process.env.ADMIN_PW || "";               // пароль админ-панели (обязательно задай на Render)
const ALLOW_DEV = process.env.ALLOW_DEV === "1";           // только для локальных тестов: ?dev=имя
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

/* ===== хранилище ===== */
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { users: {}, lk: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (e) {}
db.users = db.users || {}; db.lk = db.lk || {};
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
const sint = x => { x = Math.trunc(+x); return Number.isSafeInteger(x) ? x : 0; };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rn(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const dname = u => u.username ? "@" + u.username : (u.name || "ID " + u.id);
const SKIN_IDS = new Set(["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "f1", "f2", "f3"]);
const LK_KEYS = ["slot", "candy", "crash", "roul", "mines", "hl", "poker", "bj", "durak", "chess", "checkers"];
const EMOJI = ["😊", "🤐", "😘", "😎", "🤡", "👍", "👎"];

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
  if (!u) u = db.users[id] = { id, name: name || "", username: username || "", bal: 0, skins: ["k0"], sel: "k0", gb: 0, padj: 0 };
  else { if (name) u.name = name; u.username = username || ""; }
  if (!Array.isArray(u.skins)) u.skins = ["k0"];
  if (!u.skins.includes("k0")) u.skins.unshift("k0");
  if (!u.sel) u.sel = "k0";
  u.gb = u.gb || 0; u.padj = u.padj || 0;
  save();
  return u;
}

/* ===== соединения ===== */
const conns = new Map();      // id -> {ws, timer}
const rooms = new Map();      // code -> room
const userRoom = new Map();   // id -> room
const online = id => { const c = conns.get(id); return !!(c && c.ws && c.ws.readyState === 1); };
const tx = (id, o) => { const c = conns.get(id); if (c && c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); };
const errId = (id, m) => tx(id, { t: "err", m });
const err = (u, m) => errId(u.id, m);
const me = u => tx(u.id, { t: "me", bal: u.bal, skins: u.skins, sel: u.sel, id: u.id, name: dname(u) });
const bcast = o => { const s = JSON.stringify(o); conns.forEach(c => { if (c.ws && c.ws.readyState === 1) c.ws.send(s); }); };

/* ===== комнаты ===== */
function newCode() {
  const L = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (;;) { let c = ""; for (let i = 0; i < 4; i++) c += L[rn(L.length)]; if (!rooms.has(c)) return c; }
}
const roomMsg = r => ({ t: "room", code: r.code, bet: r.bet, kind: r.kind, max: r.max, host: r.host, pl: r.pl.map(p => ({ id: p.id, name: p.name, skin: p.skin })) });
const roomSend = r => { const m = roomMsg(r); r.pl.forEach(p => tx(p.id, m)); };
function closeRoom(r) {
  r.done = 1; rooms.delete(r.code);
  r.pl.forEach(p => { if (userRoom.get(p.id) === r) userRoom.delete(p.id); });
}
function cancelRoom(r) {
  r.pl.forEach(p => { const u = db.users[p.id]; u.bal += r.bet; me(u); tx(p.id, { t: "room", code: null }); });
  closeRoom(r); save();
}

/* ===== дурак (подкидной, 2–4 игрока, шулерство) ===== */
const rk = c => c % 9, su = c => Math.floor(c / 9);
const beatsC = (a, d, ts) => su(a) === su(d) ? rk(d) > rk(a) : su(d) === ts && su(a) !== ts;
const alive = r => r.pl.filter(p => !p.out);
const nxt = (r, i) => { for (let k = 1; k <= r.pl.length; k++) { const j = (i + k) % r.pl.length; if (!r.pl[j].out) return j; } return i; };
const srt = (p, ts) => p.hand.sort((a, b) => (su(a) === ts) - (su(b) === ts) || su(a) - su(b) || rk(a) - rk(b));

function dStart(r) {
  const deck = shuffle(Array.from({ length: 36 }, (_, i) => i)), ts = su(deck[0]);
  r.pl.forEach(p => { p.skin = db.users[p.id].sel; p.out = 0; p.hand = deck.splice(deck.length - 6, 6); });
  let att = rn(r.pl.length), best = 99;
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
  const g = r.g, p = r.pl[i], ci = Number.isInteger(m.c) ? m.c : -1, c = p.hand[ci];
  if (c == null || p.out) return;
  if (i === g.def) {
    if (g.tk) return errId(p.id, "Ты уже берёшь карты");
    const t = Number.isInteger(m.tgt) && g.tb[m.tgt] && g.tb[m.tgt].d == null ? m.tgt : g.tb.findIndex(x => x.d == null && beatsC(x.a, c, g.ts));
    if (t < 0 || !g.tb[t] || g.tb[t].d != null || !beatsC(g.tb[t].a, c, g.ts)) return errId(p.id, "Этой картой не побить");
    g.tb[t].d = c; g.tb[t].ds = p.skin;
  } else {
    if (!canThrow(r, i)) return errId(p.id, "Сейчас подкидывать нельзя");
    if (g.tb.length && !g.tb.some(x => rk(x.a) === rk(c) || (x.d != null && rk(x.d) === rk(c)))) return errId(p.id, "Такого ранга нет на столе");
    g.tb.push({ a: c, as: p.skin, d: null });
  }
  p.hand.splice(ci, 1); g.conf = { a: 0, d: 0 }; g.done = {}; settle(r);
}
function dAct(r, i) {
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
  const al = alive(r); if (al.length <= 1) return dFinish(r, al[0]);
  g.att = took || r.pl[g.def].out ? nxt(r, g.def) : g.def; g.def = nxt(r, g.att); g.lim = Math.min(6, r.pl[g.def].hand.length);
  sendG(r);
}
function dFinish(r, loser) {
  if (r.done) return;
  const n = r.pl.length, bonus = Math.floor(r.bet / (n - 1));
  r.pl.forEach(p => {
    const u = db.users[p.id]; let win = 2, amt = r.bet;
    if (loser && p.id === loser.id) { win = 0; amt = 0; } else if (loser) { win = 1; amt = r.bet + bonus; }
    u.bal += amt; me(u); tx(p.id, { t: "end", win, n: amt, durak: loser ? loser.name : "" });
  });
  closeRoom(r); save();
}
function dAbandon(r, id) {
  if (r.done) return;
  const n = r.pl.length, bonus = Math.floor(r.bet / (n - 1)), lv = r.pl.find(p => p.id === id);
  r.pl.forEach(p => {
    const u = db.users[p.id], mine = p.id === id, amt = mine ? 0 : r.bet + bonus;
    u.bal += amt; me(u); tx(p.id, { t: "end", win: mine ? 0 : 1, n: amt, durak: lv ? lv.name : "", left: 1 });
  });
  closeRoom(r); save();
}
function dView(r, p) {
  const g = r.g, i = r.pl.indexOf(p), open = g.tb.filter(x => x.d == null).length, beaten = g.tb.length && !open, nm = j => r.pl[j].name;
  let a = null, tx_ = "Смотришь за игрой";
  if (!p.out) {
    if (i === g.def) {
      if (g.tk) tx_ = "Ты берёшь карты. Ждём подкидывающих";
      else if (open) { a = "take"; tx_ = "Отбивайся: перетащи карту на атакующую или нажми «Взять»"; }
      else if (beaten && g.conf.a && !g.conf.d) { a = "confirm"; tx_ = nm(g.att) + " сказал «бито». Подтверди"; }
      else if (beaten) tx_ = "Отбито. Ждём: подкинут или скажут «бито»";
      else tx_ = "Ходит " + nm(g.att);
    } else if (g.tk) {
      if (canThrow(r, i) && !g.done[i]) { a = "done"; tx_ = nm(g.def) + " берёт. Подкинь ещё или нажми «Готово»"; } else tx_ = "Ждём остальных";
    } else if (i === g.att) {
      if (!g.tb.length) tx_ = "Твой ход: перетащи карту на стол";
      else if (open) tx_ = "Ждём, пока " + nm(g.def) + " отобьётся";
      else if (!g.conf.a) { a = "bito"; tx_ = "Подкинь ещё или нажми «Бито»"; }
      else tx_ = "Ждём подтверждения от " + nm(g.def);
    } else tx_ = canThrow(r, i) ? "Можешь подкинуть карту" : "Ждёшь";
  }
  return {
    t: "g", bet: r.bet, dn: g.deck.length, tc: g.tc, ts: g.ts, di: g.disc.length, tb: g.tb, tk: g.tk, h: p.hand, skin: p.skin, act: a, tx: tx_, me: p.id, out: p.out,
    pl: r.pl.map((x, j) => ({ id: x.id, name: x.name, skin: x.skin, n: x.hand.length, out: x.out, role: j === g.att ? "a" : j === g.def ? "d" : "t", ok: j === g.att ? g.conf.a : j === g.def ? g.conf.d : g.done[j] ? 1 : 0 })),
    ch: { can: g.disc.length > 0 && (g.cheats[p.id] || 0) < 2 && g.cb[p.id] !== g.bout && !p.out, sus: !!g.sus[p.id] }
  };
}
const sendG = r => r.pl.forEach(p => tx(p.id, dView(r, p)));
const evAll = (r, m) => r.pl.forEach(p => tx(p.id, { t: "ev", m }));
function pay(from, to, n) { const a = Math.min(n, from.bal); from.bal -= a; to.bal += a; me(from); me(to); save(); return a; }
function dCheat(r, u) {
  const g = r.g, p = r.pl.find(x => x.id === u.id);
  if (p.out || !g.disc.length) return err(u, "Нечего подменять: бито пусто");
  if ((g.cheats[u.id] || 0) >= 2 || g.cb[u.id] === g.bout) return err(u, "Шулерить можно не чаще раза за ход (2 раза за игру)");
  const c = g.disc.splice(rn(g.disc.length), 1)[0];
  p.hand.push(c); srt(p, g.ts); g.cheats[u.id] = (g.cheats[u.id] || 0) + 1; g.cb[u.id] = g.bout; g.sus[u.id] = g.bout;
  tx(u.id, { t: "ev", m: "Карта из рукава у тебя! Не попадись", me: 1 }); sendG(r);
}
function dAcc(r, u, m) {
  const g = r.g, t = r.pl.find(x => x.id === m.to), a = r.pl.find(x => x.id === u.id);
  if (!t || t.id === u.id || !a || a.out) return;
  if (g.ab[u.id] === g.bout) return err(u, "Обвинять можно раз за ход");
  g.ab[u.id] = g.bout;
  if (g.sus[t.id] && g.sus[t.id] >= g.bout - 1) {
    delete g.sus[t.id];
    if (t.hand.length) g.disc.push(t.hand.splice(rn(t.hand.length), 1)[0]);
    const n = pay(db.users[t.id], u, r.bet); evAll(r, dname(u) + " поймал шулера " + t.name + "! Штраф " + n + " 🪙");
  } else {
    const n = pay(u, db.users[t.id], Math.ceil(r.bet / 2)); evAll(r, dname(u) + " ложно обвинил " + t.name + " и заплатил " + n + " 🪙");
  }
  sendG(r);
}

/* ===== шахматы и шашки онлайн (сервер только связывает игроков и платит) ===== */
function bStart(r) {
  const w = rn(2);
  r.pl.forEach((p, i) => { p.side = i === w ? "w" : "b"; });
  r.g = { board: 1 }; r.turn = r.pl[w].id;
  r.pl.forEach(p => { const o = r.pl.find(x => x !== p); tx(p.id, { t: "gstart", kind: r.kind, side: p.side, opp: o.name, bet: r.bet }); });
}
function bEnd(r, winId, left) {
  if (r.done) return;
  r.pl.forEach(p => {
    const u = db.users[p.id]; let win, n;
    if (winId === null) { win = 2; n = r.bet; } else if (p.id === winId) { win = 1; n = r.bet * 2; } else { win = 0; n = 0; }
    u.bal += n; me(u);
    const m = { t: "end", kind: r.kind, win, n }; if (left) m.left = 1;
    tx(p.id, m);
  });
  closeRoom(r); save();
}
const okSq = x => Number.isInteger(x) && x >= 0 && x < 64;
function validMove(kind, m) {
  if (kind === "chess") return Array.isArray(m) && m.length === 2 && okSq(m[0]) && okSq(m[1]);
  return !!m && Array.isArray(m.p) && m.p.length >= 2 && m.p.length <= 40 && m.p.every(okSq) && Array.isArray(m.c) && m.c.length <= 40 && m.c.every(okSq);
}

/* ===== выход / отключение ===== */
function abandon(u) {
  const r = userRoom.get(u.id);
  if (!r) return;
  if (r.g) {
    if (r.kind === "durak") dAbandon(r, u.id);
    else bEnd(r, r.pl.find(p => p.id !== u.id).id, 1);
    return;
  }
  if (r.host === u.id) return cancelRoom(r);
  r.pl = r.pl.filter(p => p.id !== u.id); userRoom.delete(u.id);
  u.bal += r.bet; me(u); tx(u.id, { t: "room", code: null });
  roomSend(r); save();
}

/* ===== общий краш ===== */
const CR = { ph: "wait", t0: Date.now(), cp: 1, tcp: 0, hist: [], bets: new Map(), subs: new Set(), last: 0 };
const crMsg = () => {
  const m = { t: "cr", hist: CR.hist, ph: CR.ph, age: Date.now() - CR.t0, pl: [...CR.bets.values()].map(p => ({ n: p.n, b: p.b, c: p.c })) };
  if (CR.ph === "crash") m.cp = CR.cp;
  return m;
};
function crBcast() {
  CR.last = Date.now();
  if (!CR.subs.size) return;
  const s = JSON.stringify(crMsg());
  CR.subs.forEach(id => { const c = conns.get(id); if (c && c.ws && c.ws.readyState === 1) c.ws.send(s); });
}
function crPay(b, mult) {
  if (b.c) return;
  const m2 = Math.max(1, Math.floor(mult * 100) / 100);
  let win = Math.floor(b.b * m2);
  const k = db.lk.crash;
  if (k != null && k !== 1 && win > b.b) win = Math.floor(b.b + (win - b.b) * k);
  b.c = m2;
  tx(b.id, { t: "cwin", n: win, m: m2 });
}
setInterval(() => {
  const now = Date.now(), age = now - CR.t0;
  if (CR.ph === "wait") {
    if (age >= 7000) {
      CR.ph = "run"; CR.t0 = now;
      CR.cp = Math.min(200, Math.max(1, Math.floor(95 / (1 - rn(1e9) / 1e9)) / 100));
      CR.tcp = 5000 * Math.log(CR.cp);
      return crBcast();
    }
  } else if (CR.ph === "run") {
    const m = Math.exp(age / 5000);
    CR.bets.forEach(b => { if (!b.c && b.au && b.au < CR.cp && m >= b.au) crPay(b, b.au); });
    if (age >= CR.tcp) {
      CR.ph = "crash"; CR.t0 = now;
      CR.hist = [CR.cp].concat(CR.hist).slice(0, 12);
      return crBcast();
    }
  } else if (age >= 4000) {
    CR.ph = "wait"; CR.t0 = now; CR.bets.clear();
    return crBcast();
  }
  if (now - CR.last >= 500) crBcast();
}, 50);

/* ===== админ ===== */
const hash = s => crypto.createHash("sha256").update(String(s)).digest();
const admOk = pw => !!ADMIN_PW && crypto.timingSafeEqual(hash(pw), hash(ADMIN_PW));
const admFail = new Map();
function admList(q) {
  q = String(q || "").trim().toLowerCase().replace(/^@/, "");
  return Object.values(db.users)
    .filter(x => !q || String(x.id).toLowerCase().includes(q) || (x.name || "").toLowerCase().includes(q) || (x.username || "").toLowerCase().includes(q))
    .sort((a, b) => online(b.id) - online(a.id) || (a.name || "").localeCompare(b.name || ""))
    .slice(0, 40)
    .map(x => ({ id: x.id, name: dname(x), username: x.username || "", on: online(x.id), bal: x.bal, gb: x.gb }));
}

/* ===== обработчики сообщений ===== */
const H = {
  gb(u, m) { const n = Math.floor(+m.bal); if (Number.isFinite(n) && n >= 0 && n < 1e15) { u.gb = n; save(); } },
  skins(u, m) {
    if (Array.isArray(m.own)) m.own.forEach(s => { if (SKIN_IDS.has(s) && !u.skins.includes(s)) u.skins.push(s); });
    if (typeof m.sel === "string" && u.skins.includes(m.sel)) u.sel = m.sel;
    save(); // me() не шлём: клиент сравнивает списки и может зациклить обмен
  },
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
    err(u, "Отправлено " + n + " 🪙 → " + dname(r));
  },

  /* столы */
  mk(u, m) {
    if (userRoom.has(u.id)) return err(u, "Ты уже за столом");
    const kind = ["durak", "chess", "checkers"].includes(m.kind) ? m.kind : "durak";
    const n = int(m.n); if (!n) return err(u, "Неверная ставка");
    if (u.bal < n) return err(u, "В банке не хватает монет. Положи их во вкладке «Бонусы»");
    const max = kind === "durak" ? Math.min(4, Math.max(2, int(m.max) || 2)) : 2;
    u.bal -= n;
    const r = { code: newCode(), kind, bet: n, max, host: u.id, pl: [{ id: u.id, name: dname(u), skin: u.sel }], g: null, done: 0 };
    rooms.set(r.code, r); userRoom.set(u.id, r);
    save(); me(u); roomSend(r);
  },
  jn(u, m) {
    if (userRoom.has(u.id)) return err(u, "Ты уже за столом");
    const r = rooms.get(String(m.code || "").trim().toUpperCase());
    if (!r || r.g || r.pl.length >= r.max) return err(u, "Стол не найден");
    if (u.bal < r.bet) return err(u, "Не хватает монет в банке: ставка " + r.bet);
    u.bal -= r.bet; r.pl.push({ id: u.id, name: dname(u), skin: u.sel }); userRoom.set(u.id, r);
    save(); me(u);
    if (r.kind !== "durak" && r.pl.length === r.max) bStart(r); else roomSend(r);
  },
  start(u) {
    const r = userRoom.get(u.id);
    if (!r || r.g || r.kind !== "durak" || r.host !== u.id) return;
    if (r.pl.length < 2) return err(u, "Нужен хотя бы ещё один игрок");
    dStart(r);
  },
  leave(u) { abandon(u); },

  /* дурак */
  play(u, m) { const r = userRoom.get(u.id); if (!r || !r.g || r.kind !== "durak") return; dPlay(r, r.pl.findIndex(p => p.id === u.id), m); },
  act(u) { const r = userRoom.get(u.id); if (!r || !r.g || r.kind !== "durak") return; dAct(r, r.pl.findIndex(p => p.id === u.id)); },
  cheat(u) { const r = userRoom.get(u.id); if (!r || !r.g || r.kind !== "durak") return; dCheat(r, u); },
  acc(u, m) { const r = userRoom.get(u.id); if (!r || !r.g || r.kind !== "durak") return; dAcc(r, u, m); },
  st(u, m) {
    const r = userRoom.get(u.id); if (!r || !EMOJI.includes(m.e)) return;
    r.pl.forEach(p => { if (p.id !== u.id) tx(p.id, { t: "stk", id: u.id, e: m.e }); });
  },

  /* шахматы / шашки */
  mv(u, m) {
    const r = userRoom.get(u.id);
    if (!r || !r.g || r.kind === "durak" || r.turn !== u.id || !validMove(r.kind, m.m)) return;
    const o = r.pl.find(p => p.id !== u.id);
    r.turn = o.id; tx(o.id, { t: "mv", m: m.m });
  },
  gres(u, m) {
    const r = userRoom.get(u.id);
    if (!r || !r.g || r.kind === "durak") return;
    if (m.r === "lose") bEnd(r, r.pl.find(p => p.id !== u.id).id);
    else if (m.r === "draw") bEnd(r, null);
  },

  /* краш */
  csub(u) { CR.subs.add(u.id); tx(u.id, crMsg()); },
  cunsub(u) { CR.subs.delete(u.id); },
  cbet(u, m) {
    const n = int(m.n);
    if (!n || n > 1e12 || CR.bets.has(u.id)) return;
    if (!(CR.ph === "wait" || (CR.ph === "run" && Date.now() - CR.t0 < 500))) return err(u, "Ставки на этот раунд закрыты");
    const au = +m.au;
    CR.bets.set(u.id, { id: u.id, n: dname(u), b: n, au: au >= 1.1 && au <= 1000 ? au : 0, c: 0 });
    CR.subs.add(u.id);
  },
  ccash(u) {
    const b = CR.bets.get(u.id);
    if (!b || b.c || CR.ph !== "run") return;
    const t = Date.now() - CR.t0;
    if (t >= CR.tcp) return;
    crPay(b, Math.exp(t / 5000));
  },

  /* админ-панель */
  adm(u, m) {
    const f = admFail.get(u.id) || { n: 0, t: Date.now() };
    if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
    if (f.n >= 8) return tx(u.id, { t: "admr", bad: 1 });
    if (!admOk(String(m.pw || ""))) { f.n++; admFail.set(u.id, f); return tx(u.id, { t: "admr", bad: 1 }); }
    const reply = s => tx(u.id, { t: "admr", m: s });
    const t = db.users[String(m.id)];
    switch (m.op) {
      case "list": return tx(u.id, { t: "adml", u: admList(m.q), lk: db.lk });
      case "bank": {
        const n = sint(m.n); if (!t || !n) return reply("Игрок не найден или сумма пустая");
        t.bal = Math.max(0, t.bal + n); save(); me(t);
        return reply("Банк " + dname(t) + ": " + (n > 0 ? "+" : "") + n + " (теперь " + t.bal + ")");
      }
      case "game": {
        const n = sint(m.n); if (!t || !n) return reply("Игрок не найден или сумма пустая");
        t.gb = Math.max(0, (t.gb || 0) + n);
        if (online(t.id)) tx(t.id, { t: "gadj", n }); else t.padj = (t.padj || 0) + n;
        save();
        return reply("Игровой баланс " + dname(t) + ": " + (n > 0 ? "+" : "") + n + (online(t.id) ? "" : " (придёт при входе)"));
      }
      case "lk": {
        if (!LK_KEYS.includes(m.k)) return reply("Неизвестный режим");
        const v = Math.min(5, Math.max(0, +m.v)); if (!Number.isFinite(v)) return reply("Неверное значение");
        db.lk[m.k] = v; save(); bcast({ t: "cfg", lk: db.lk });
        return reply("Шанс «" + m.k + "»: ×" + v);
      }
      case "grant": {
        if (!t) return reply("Игрок не найден");
        if (!SKIN_IDS.has(m.k)) return reply("Неизвестный предмет");
        if (!t.skins.includes(m.k)) t.skins.push(m.k);
        save(); me(t);
        return reply("Выдано игроку " + dname(t) + ": " + m.k);
      }
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
const wss = new WebSocketServer({ server, maxPayload: 8192 });

wss.on("connection", ws => {
  let u = null, cnt = 0, ts = Date.now();
  ws.alive = true;
  ws.on("pong", () => ws.alive = true);
  ws.on("error", () => {});
  ws.on("message", raw => {
    const now = Date.now();
    if (now - ts > 1000) { ts = now; cnt = 0; }
    if (++cnt > 30) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;
    if (m.t === "auth") {
      if (u) return;
      const tu = verify(m.init); let id, name, un = "";
      if (tu && tu.id) { id = String(tu.id); name = [tu.first_name, tu.last_name].filter(Boolean).join(" "); un = tu.username || ""; }
      else if (ALLOW_DEV && m.name) { name = String(m.name).replace(/[^\w\- ]/g, "").slice(0, 20); id = "dev_" + name; }
      else { ws.send(JSON.stringify({ t: "err", m: "Ошибка авторизации. Открой игру из Telegram" })); return ws.close(); }
      u = getUser(id, name, un);
      let c = conns.get(id);
      if (c) { clearTimeout(c.timer); const old = c.ws; c.ws = ws; if (old && old !== ws) try { old.close(); } catch (e) {} }
      else conns.set(id, c = { ws, timer: null });
      c.ws = ws;
      me(u);
      tx(id, { t: "cfg", lk: db.lk });
      if (u.padj) { const n = u.padj; u.padj = 0; save(); tx(id, { t: "gadj", n }); }
      const r = userRoom.get(id);
      if (r && !r.done) { if (!r.g) tx(id, roomMsg(r)); else if (r.kind === "durak") tx(id, dView(r, r.pl.find(p => p.id === id))); }
      return;
    }
    if (!u) return;
    if (!Object.prototype.hasOwnProperty.call(H, m.t)) return;
    try { H[m.t](u, m); } catch (e) { console.error(e); }
  });
  ws.on("close", () => {
    if (!u) return;
    const c = conns.get(u.id);
    if (!c || c.ws !== ws) return;
    c.ws = null;
    c.timer = setTimeout(() => { conns.delete(u.id); CR.subs.delete(u.id); abandon(u); }, 60000); // 60 сек на переподключение
  });
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); }), 25000);

server.listen(PORT, () => console.log("Lucky Nova server on :" + PORT));
