/* Lucky Nova server — Node 18+, зависимость: ws
   ENV: BOT_TOKEN (токен бота, обязателен), ADMIN_PW (пароль админки, обязателен для админки),
        PORT, DATA_FILE (путь к json), ALLOW_DEV=1 (вход без Telegram по ?dev=имя, только для тестов) */
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_PW = process.env.ADMIN_PW || "";
const ALLOW_DEV = process.env.ALLOW_DEV === "1";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const KSK = new Set(Array.from({ length: 16 }, (_, i) => "k" + i));
const FRM = ["f1", "f2", "f3"];
const RUB = { k1: 10, k2: 20, k4: 30, k5: 40, k7: 50, k6: 60, k3: 70, k8: 80, k9: 90, k10: 100, k11: 110, k12: 120, k13: 130, k14: 140, k15: 150,
  bt1: 10, bt2: 20, bt3: 30, bt4: 40, bt5: 50, bt6: 60, bt7: 70, bt8: 80, bt9: 90, f1: 149, f2: 249, f3: 349 }; // цена в рублях
const FRAME_BONUS = { f1: 149, f2: 249, f3: 349 }; // монет на игровой баланс за рамку
const ABUSE = { on: 0, mult: 50000 }; // глобальный режим «Admin Abuse», включает и выключает только админ
const EM = ["😊", "🤐", "😘", "😎", "🤡", "👍", "👎"];

/* ---------- хранилище ---------- */
let DB = { users: {}, orders: {}, lk: {} };
try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))); } catch (e) {}
let saveT = null;
const save = () => {
  if (saveT) return;
  saveT = setTimeout(() => {
    saveT = null;
    fs.writeFile(DATA_FILE + ".tmp", JSON.stringify(DB), e => { if (!e) fs.rename(DATA_FILE + ".tmp", DATA_FILE, () => {}); });
  }, 1500);
};
const getU = id => (has(DB.users, String(id)) ? DB.users[String(id)] : null);

/* ---------- связь ---------- */
const ONLINE = new Map(); // userId -> ws
const tx = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const sendU = (id, o) => tx(ONLINE.get(id), o);
const push = u => sendU(u.id, { t: "me", bal: u.bal, skins: u.skins, sel: u.sel, id: u.id, name: u.name });
const err = (id, m) => sendU(id, { t: "err", m });
const addGame = (u, n) => { if (ONLINE.has(u.id)) sendU(u.id, { t: "gadj", n }); else { u.pg = (u.pg || 0) + n; save(); } };

/* ---------- вход через Telegram ---------- */
function parseInit(init) {
  const p = new URLSearchParams(init), hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + "=" + v).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const h = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
  if (h !== hash) return null;
  if (Date.now() / 1000 - (+p.get("auth_date") || 0) > 86400 * 7) return null;
  try { return JSON.parse(p.get("user")); } catch (e) { return null; }
}
function auth(ws, m) {
  let tu = null;
  if (m.init) {
    if (BOT_TOKEN) tu = parseInit(String(m.init));
    else if (ALLOW_DEV) { try { tu = JSON.parse(new URLSearchParams(m.init).get("user")); } catch (e) {} }
  } else if (ALLOW_DEV && m.name) {
    const n = String(m.name).slice(0, 20);
    tu = { id: "dev_" + n, first_name: n };
  }
  if (!tu || !tu.id) return tx(ws, { t: "err", m: "Не удалось войти. Открой игру через Telegram" });
  const id = String(tu.id);
  let u = getU(id);
  if (!u) u = DB.users[id] = { id, bal: 0, gb: null, skins: ["k0"], sel: "k0", ban: 0, reason: "", pg: 0 };
  u.name = (((tu.first_name || "") + " " + (tu.last_name || "")).trim() || tu.username || "Игрок").slice(0, 24);
  u.username = tu.username || "";
  const old = ONLINE.get(id);
  if (old && old !== ws) { old.uid = null; try { old.close(); } catch (e) {} }
  ws.uid = id; ONLINE.set(id, ws); save();
  if (u.ban) return tx(ws, { t: "ban", m: u.reason });
  push(u);
  tx(ws, { t: "cfg", lk: DB.lk });
  if (u.pg) { tx(ws, { t: "gadj", n: u.pg }); u.pg = 0; save(); }
  if (ABUSE.on) tx(ws, { t: "abuse", on: 1, mult: ABUSE.mult, cd: 0 });
  const r = ROOMS[IN[id]];
  if (r) {
    if (r.dc && r.dc[id]) { clearTimeout(r.dc[id]); delete r.dc[id]; }
    if (!r.started) tx(ws, roomMsg(r));
    else if (r.kind === "durak") sendG(r);
    else abandon(r, id); // доску восстановить нельзя: считается выходом
  }
}

/* ---------- комнаты (дурак, шахматы, шашки) ---------- */
const ROOMS = Object.create(null), IN = Object.create(null);
const newCode = () => { let c; do { c = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[crypto.randomInt(24)]).join(""); } while (ROOMS[c]); return c; };
const roomMsg = r => ({ t: "room", code: r.code, max: r.max, host: r.host, bet: r.bet, kind: r.kind, pl: r.pl.map(p => ({ id: p.id, name: p.name, skin: p.skin })) });
const newP = u => ({ id: u.id, name: u.name, skin: u.sel, hand: [], out: 0 });
function closeRoom(r) {
  r.pl.forEach(p => delete IN[p.id]);
  if (r.dc) Object.values(r.dc).forEach(clearTimeout);
  delete ROOMS[r.code]; save();
}
function mkRoom(u, m) {
  if (IN[u.id]) return err(u.id, "Ты уже за столом");
  const kind = ["durak", "chess", "checkers"].includes(m.kind) ? m.kind : "durak";
  const bet = Math.floor(+m.n);
  if (!(bet >= 1)) return err(u.id, "Ставка от 1");
  if (u.bal < bet) return err(u.id, "Не хватает монет в банке. Пополни банк в «Бонусах»");
  const max = kind === "durak" && [2, 3, 4].includes(+m.max) ? +m.max : 2;
  u.bal -= bet;
  const r = { code: newCode(), kind, max, bet, host: u.id, pl: [newP(u)], started: 0, g: null };
  ROOMS[r.code] = r; IN[u.id] = r.code; push(u); save();
  tx(ONLINE.get(u.id), roomMsg(r));
}
function joinRoom(u, m) {
  if (IN[u.id]) return err(u.id, "Ты уже за столом");
  const r = ROOMS[String(m.code || "").toUpperCase()];
  if (!r || r.started) return err(u.id, "Стол не найден или игра уже идёт");
  if (r.pl.length >= r.max) return err(u.id, "Стол полный");
  if (u.bal < r.bet) return err(u.id, "Не хватает монет в банке: ставка " + r.bet);
  u.bal -= r.bet; r.pl.push(newP(u)); IN[u.id] = r.code; push(u); save();
  if (r.kind !== "durak" && r.pl.length === 2) return startBoard(r);
  r.pl.forEach(p => sendU(p.id, roomMsg(r)));
}
function startBoard(r) {
  r.started = 1; r.turn = "w";
  const w = Math.random() < 0.5 ? 0 : 1;
  r.pl[w].side = "w"; r.pl[1 - w].side = "b";
  r.pl.forEach((p, i) => sendU(p.id, { t: "gstart", kind: r.kind, side: p.side, opp: r.pl[1 - i].name, bet: r.bet }));
}
function leave(u) {
  const r = ROOMS[IN[u.id]];
  if (!r) return;
  if (r.started) return abandon(r, u.id);
  r.pl = r.pl.filter(p => p.id !== u.id); delete IN[u.id];
  u.bal += r.bet; push(u); sendU(u.id, { t: "room" });
  if (u.id === r.host || !r.pl.length) {
    r.pl.forEach(p => { const x = getU(p.id); x.bal += r.bet; delete IN[p.id]; push(x); sendU(p.id, { t: "room" }); });
    delete ROOMS[r.code];
  } else r.pl.forEach(p => sendU(p.id, roomMsg(r)));
  save();
}
function endBoard(r, loserId, draw, left) {
  r.pl.forEach(p => {
    const u = getU(p.id); let win, n;
    if (draw) { win = 2; n = r.bet; } else if (p.id === loserId) { win = 0; n = 0; } else { win = 1; n = r.bet * 2; }
    u.bal += n; push(u);
    sendU(p.id, { t: "end", kind: r.kind, win, n, left: left ? 1 : 0 });
  });
  closeRoom(r);
}
function abandon(r, id) {
  if (!ROOMS[r.code]) return;
  if (r.kind !== "durak") return endBoard(r, id, 0, 1);
  const n = r.pl.length, bonus = Math.floor(r.bet / (n - 1));
  r.pl.forEach(p => {
    const u = getU(p.id), me = p.id === id, amt = me ? 0 : r.bet + bonus;
    u.bal += amt; push(u);
    sendU(p.id, { t: "end", win: me ? 0 : 1, n: amt, durak: getU(id).name, left: 1 });
  });
  closeRoom(r);
}

/* ---------- дурак (подкидной) ---------- */
const rk = c => c % 9, su = c => Math.floor(c / 9);
const beats = (a, d, ts) => (su(a) === su(d) ? rk(d) > rk(a) : su(d) === ts && su(a) !== ts);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const alive = r => r.pl.filter(p => !p.out);
const nxt = (r, i) => { for (let k = 1; k <= r.pl.length; k++) { const j = (i + k) % r.pl.length; if (!r.pl[j].out) return j; } return i; };
const srt = (p, ts) => p.hand.sort((a, b) => (su(a) === ts) - (su(b) === ts) || su(a) - su(b) || rk(a) - rk(b));

function dStart(r) {
  r.started = 1;
  const deck = shuffle(Array.from({ length: 36 }, (_, i) => i)), ts = su(deck[0]);
  r.pl.forEach(p => { p.skin = getU(p.id).sel; p.out = 0; p.hand = deck.splice(deck.length - 6, 6); });
  let att = Math.floor(Math.random() * r.pl.length), best = 99;
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
  const n = r.pl.length, bonus = Math.floor(r.bet / (n - 1));
  r.pl.forEach(p => {
    const u = getU(p.id); let win = 2, amt = r.bet;
    if (loser && p.id === loser.id) { win = 0; amt = 0; } else if (loser) { win = 1; amt = r.bet + bonus; }
    u.bal += amt; push(u);
    sendU(p.id, { t: "end", win, n: amt, durak: loser ? loser.name : "" });
  });
  closeRoom(r);
}
function view(r, p) {
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
const sendG = r => r.pl.forEach(p => sendU(p.id, view(r, p)));
const dRoom = u => { const r = ROOMS[IN[u.id]]; return r && r.g && r.kind === "durak" ? r : null; };
const evAll = (r, m) => r.pl.forEach(p => sendU(p.id, { t: "ev", m }));
function pay(from, to, n) { const a = Math.min(n, from.bal); from.bal -= a; to.bal += a; push(from); push(to); save(); return a; }
function dCheat(u) {
  const r = dRoom(u); if (!r) return; const g = r.g, p = r.pl.find(x => x.id === u.id);
  if (p.out || !g.disc.length) return err(u.id, "Нечего подменять: бито пусто");
  if ((g.cheats[u.id] || 0) >= 2 || g.cb[u.id] === g.bout) return err(u.id, "Шулерить можно не чаще раза за ход (2 раза за игру)");
  const c = g.disc.splice(Math.floor(Math.random() * g.disc.length), 1)[0];
  p.hand.push(c); srt(p, g.ts); g.cheats[u.id] = (g.cheats[u.id] || 0) + 1; g.cb[u.id] = g.bout; g.sus[u.id] = g.bout;
  sendU(u.id, { t: "ev", m: "Карта из рукава у тебя! Не попадись", me: 1 }); sendG(r);
}
function dAcc(u, m) {
  const r = dRoom(u); if (!r) return; const g = r.g, t = r.pl.find(x => x.id === m.to);
  if (!t || t.id === u.id) return;
  if (g.ab[u.id] === g.bout) return err(u.id, "Обвинять можно раз за ход");
  g.ab[u.id] = g.bout;
  if (g.sus[t.id] && g.sus[t.id] >= g.bout - 1) {
    delete g.sus[t.id];
    if (t.hand.length) g.disc.push(t.hand.splice(Math.floor(Math.random() * t.hand.length), 1)[0]);
    const a = pay(getU(t.id), u, r.bet); evAll(r, u.name + " поймал шулера " + t.name + "! Штраф " + a + " 🪙");
  } else {
    const a = pay(u, getU(t.id), Math.ceil(r.bet / 2)); evAll(r, u.name + " ложно обвинил " + t.name + " и заплатил " + a + " 🪙");
  }
  sendG(r);
}

/* ---------- краш: общий раунд ---------- */
const CR = { ph: "wait", t0: Date.now(), cp: 1, bets: new Map(), hist: [], subs: new Set() };
const genCp = () => Math.min(200, Math.max(1, Math.floor(95 / (1 - Math.random())) / 100));
CR.cp = genCp();
function cashOut(id, c) {
  const b = CR.bets.get(id); if (!b || b.c) return;
  b.c = +c.toFixed(2);
  sendU(id, { t: "cwin", n: Math.floor(b.n * b.c), m: b.c });
}
setInterval(() => {
  let now = Date.now(), age = now - CR.t0;
  if (CR.ph === "wait" && age >= 7000) { CR.ph = "run"; CR.t0 = now; }
  else if (CR.ph === "run") {
    const m = Math.exp(age / 5000);
    if (m >= CR.cp) { CR.ph = "crash"; CR.t0 = now; CR.hist.unshift(CR.cp); CR.hist = CR.hist.slice(0, 12); }
    else for (const [id, b] of CR.bets) if (!b.c && b.au >= 1.1 && m >= b.au) cashOut(id, b.au);
  } else if (CR.ph === "crash" && age >= 3500) { CR.ph = "wait"; CR.t0 = now; CR.bets.clear(); CR.cp = genCp(); }
  if (!CR.subs.size) return;
  const o = { t: "cr", hist: CR.hist, ph: CR.ph, age: Date.now() - CR.t0, pl: [...CR.bets.values()].map(b => ({ n: b.name, b: b.n, c: b.c || 0 })) };
  if (CR.ph === "crash") o.cp = CR.cp;
  CR.subs.forEach(id => sendU(id, o));
}, 100);

/* ---------- админка ---------- */
const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const pwOk = pw => !!ADMIN_PW && crypto.timingSafeEqual(sha(pw || ""), sha(ADMIN_PW));
const ADMS = () => [...wss.clients].filter(c => c.adm);
function grantItem(u, k) {
  if (!RUB[k]) return false;
  if (!u.skins.includes(k)) {
    u.skins.push(k);
    if (FRAME_BONUS[k]) addGame(u, FRAME_BONUS[k]);
  }
  push(u); save(); return true;
}
function banUser(u, v, reason) {
  u.ban = v ? 1 : 0; u.reason = v ? String(reason || "").slice(0, 200) : "";
  if (v) {
    const r = ROOMS[IN[u.id]]; if (r) { if (r.started) abandon(r, u.id); else leave(u); }
    sendU(u.id, { t: "ban", m: u.reason });
  }
  save();
}
function adm(ws, m) {
  if ((ws.badPw || 0) >= 8) return;
  if (!pwOk(m.pw)) { ws.badPw = (ws.badPw || 0) + 1; return tx(ws, { t: "admr", bad: 1 }); }
  ws.adm = 1;
  const reply = s => tx(ws, { t: "admr", m: s });
  const u = m.id != null ? getU(m.id) : null;
  switch (m.op) {
    case "list": {
      const q = String(m.q || "").toLowerCase();
      let L = Object.values(DB.users);
      if (q === "#ban") L = L.filter(x => x.ban);
      else if (q) L = L.filter(x => x.id.toLowerCase().includes(q) || (x.name || "").toLowerCase().includes(q) || (x.username || "").toLowerCase().includes(q));
      L.sort((a, b) => (ONLINE.has(b.id) - ONLINE.has(a.id)) || (a.name || "").localeCompare(b.name || ""));
      const o = Object.values(DB.orders).filter(x => !x.status).map(x => ({ id: x.id, k: x.k, rub: x.rub, uid: x.uid, name: x.name }));
      return tx(ws, { t: "adml", u: L.slice(0, 60).map(x => ({ id: x.id, name: x.name, username: x.username, on: ONLINE.has(x.id) ? 1 : 0, ban: x.ban, bal: x.bal, gb: x.gb })), o, lk: DB.lk });
    }
    case "bank": if (!u) return reply("Игрок не найден"); u.bal = Math.max(0, Math.floor(u.bal + (+m.n || 0))); push(u); save(); return reply("Банк игрока: " + u.bal);
    case "game": if (!u) return reply("Игрок не найден"); addGame(u, Math.floor(+m.n || 0)); return reply("Игровой баланс изменён на " + Math.floor(+m.n || 0));
    case "ban": if (!u) return reply("Игрок не найден"); banUser(u, m.v, m.r); return reply(m.v ? "Забанен" : "Разбанен");
    case "lk": {
      const v = Math.max(0, Math.min(5, +m.v)); if (!(v >= 0) || typeof m.k !== "string") return reply("Некорректно");
      if (v === 1) delete DB.lk[m.k]; else DB.lk[m.k] = v; save();
      wss.clients.forEach(c => tx(c, { t: "cfg", lk: DB.lk })); return reply("Коэффициент " + m.k + " = " + v);
    }
    case "abuse": {
      if (m.v) {
        if (ABUSE.on) return reply("Абьюз уже запущен");
        ABUSE.on = 1; ABUSE.mult = Math.max(1, Math.min(1e9, Math.floor(+m.mult) || 50000));
        wss.clients.forEach(c => { if (c.uid) tx(c, { t: "abuse", on: 1, mult: ABUSE.mult, cd: 5 }); });
        return reply("Admin Abuse запущен у всех игроков");
      }
      ABUSE.on = 0;
      wss.clients.forEach(c => { if (c.uid) tx(c, { t: "abuse", on: 0 }); });
      return reply("Admin Abuse остановлен");
    }
    case "grant": if (!u) return reply("Игрок не найден"); return reply(grantItem(u, String(m.k)) ? "Выдано" : "Неизвестный предмет");
    case "ordd": {
      const o = has(DB.orders, m.oid) ? DB.orders[m.oid] : null; if (!o || o.status) return reply("Заказ уже обработан");
      const ou = getU(o.uid);
      if (m.yes) { o.status = 1; if (ou) grantItem(ou, o.k); } else o.status = 2;
      save(); sendU(o.uid, { t: "ordr", id: o.id, ok: m.yes ? 1 : 0 });
      return reply(m.yes ? "Заказ подтверждён, предмет выдан" : "Заказ отклонён");
    }
  }
}

/* ---------- обработчики сообщений игроков ---------- */
const H = {
  gb(u, m) { u.gb = Math.floor(+m.bal) || 0; },
  dep(u, m) { const n = Math.floor(+m.n); if (!(n >= 1) || n > 1e12) return; u.bal += n; push(u); save(); },
  wd(u, m) {
    const n = Math.floor(+m.n); if (!(n >= 1)) return;
    if (u.bal < n) return err(u.id, "Не хватает монет в банке");
    u.bal -= n; push(u); save(); sendU(u.id, { t: "wd", n });
  },
  send(u, m) {
    const n = Math.floor(+m.n); if (!(n >= 1)) return err(u.id, "Введи сумму");
    const q = String(m.to || "").trim().replace(/^@/, "").toLowerCase(); if (!q) return err(u.id, "Укажи ID или @username");
    const t = getU(q) || Object.values(DB.users).find(x => (x.username || "").toLowerCase() === q);
    if (!t) return err(u.id, "Игрок не найден");
    if (t.id === u.id) return err(u.id, "Нельзя отправить себе");
    if (u.bal < n) return err(u.id, "Не хватает монет в банке");
    u.bal -= n; t.bal += n; push(u); push(t); save();
    sendU(t.id, { t: "in", from: u.name, n });
  },
  skins(u, m) { // скины покупаются только за рубли и выдаются сервером; клиент может лишь выбрать уже купленный
    if (typeof m.sel === "string" && KSK.has(m.sel) && u.skins.includes(m.sel)) { u.sel = m.sel; save(); }
  },
  ord(u, m) {
    const id = String(m.id || "").slice(0, 20), k = String(m.k || "");
    if (!id || !RUB[k]) return;
    if (has(DB.orders, id)) { const o = DB.orders[id]; if (o.uid === u.id && o.status) sendU(u.id, { t: "ordr", id, ok: o.status === 1 ? 1 : 0 }); return; }
    if (u.skins.includes(k)) return;
    const o = DB.orders[id] = { id, k, rub: RUB[k], uid: u.id, name: u.name, status: 0, t: Date.now() }; save();
    ADMS().forEach(c => tx(c, { t: "ordn", o: { id, k, rub: o.rub, uid: u.id, name: u.name } }));
  },
  mk: mkRoom, jn: joinRoom, leave,
  start(u) {
    const r = ROOMS[IN[u.id]];
    if (!r || r.kind !== "durak" || r.started || r.host !== u.id) return;
    if (r.pl.length < 2) return err(u.id, "Нужно минимум 2 игрока");
    dStart(r);
  },
  play(u, m) { const r = dRoom(u); if (!r || !Number.isInteger(m.c)) return; dPlay(r, r.pl.findIndex(p => p.id === u.id), m); },
  act(u) { const r = dRoom(u); if (r) dAct(r, r.pl.findIndex(p => p.id === u.id)); },
  cheat: dCheat, acc: dAcc,
  st(u, m) {
    if (!EM.includes(m.e)) return;
    const r = ROOMS[IN[u.id]]; if (!r) return;
    r.pl.forEach(p => { if (p.id !== u.id) sendU(p.id, { t: "stk", id: u.id, e: m.e }); });
  },
  mv(u, m) {
    const r = ROOMS[IN[u.id]]; if (!r || !r.started || r.kind === "durak" || !m.m) return;
    const me = r.pl.find(p => p.id === u.id); if (me.side !== r.turn) return;
    r.turn = r.turn === "w" ? "b" : "w";
    const o = r.pl.find(p => p.id !== u.id); sendU(o.id, { t: "mv", m: m.m });
  },
  gres(u, m) {
    const r = ROOMS[IN[u.id]]; if (!r || !r.started || r.kind === "durak") return;
    if (m.r === "lose") endBoard(r, u.id, 0, 0); else if (m.r === "draw") endBoard(r, null, 1, 0);
  },
  csub(u) { CR.subs.add(u.id); },
  cunsub(u) { CR.subs.delete(u.id); },
  cbet(u, m) {
    const n = Math.floor(+m.n);
    if (CR.ph !== "wait" || CR.bets.has(u.id) || !(n >= 1) || n > 1e9) return;
    CR.bets.set(u.id, { name: u.name, n, au: +m.au || 0, c: 0 });
  },
  ccash(u) {
    if (CR.ph !== "run") return;
    const m = Math.exp((Date.now() - CR.t0) / 5000);
    if (m < CR.cp) cashOut(u.id, m);
  }
};

/* ---------- сервер ---------- */
const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" }); res.end("Lucky Nova server OK"); });
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
wss.on("connection", ws => {
  ws.isAlive = true; ws.cnt = 0;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", raw => {
    if (++ws.cnt > 60) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;
    try {
      if (m.t === "auth") return auth(ws, m);
      if (m.t === "adm") return adm(ws, m);
      const u = ws.uid && getU(ws.uid); if (!u) return;
      if (u.ban) return tx(ws, { t: "ban", m: u.reason });
      if (has(H, m.t)) H[m.t](u, m, ws);
    } catch (e) { console.error(e); }
  });
  ws.on("close", () => {
    const id = ws.uid; if (!id) return;
    if (ONLINE.get(id) === ws) ONLINE.delete(id);
    CR.subs.delete(id);
    const r = ROOMS[IN[id]];
    if (r) {
      if (!r.started) { const u = getU(id); if (u) leave(u); }
      else { r.dc = r.dc || {}; r.dc[id] = setTimeout(() => { if (ROOMS[r.code] && !ONLINE.has(id)) abandon(r, id); }, 60000); }
    }
  });
});
setInterval(() => { wss.clients.forEach(ws => { ws.cnt = 0; if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) {} }); }, 1000 * 25);
setInterval(() => wss.clients.forEach(ws => { ws.cnt = 0; }), 1000);
process.on("uncaughtException", e => console.error("uncaught", e));
process.on("unhandledRejection", e => console.error("unhandled", e));
server.listen(PORT, () => {
  console.log("Lucky Nova server on :" + PORT);
  if (!BOT_TOKEN && !ALLOW_DEV) console.warn("ВНИМАНИЕ: BOT_TOKEN не задан, вход через Telegram не заработает");
  if (!ADMIN_PW) console.warn("ВНИМАНИЕ: ADMIN_PW не задан, админка отключена");
});
