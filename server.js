"use strict";
/* Lucky Nova: сервер банка и «Дурака онлайн» (2–4 игрока). Монеты виртуальные.
   Запуск: npm i && BOT_TOKEN=токен_бота node server.js   (без BOT_TOKEN работает тестовый режим) */
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 8080, TOKEN = process.env.BOT_TOKEN || "", FILE = path.join(__dirname, "data.json");
const SKIDS = ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8"], EMO = ["😊", "🤐", "😘", "😎", "🤡", "👍", "👎"];
let DB = { users: {} };
try { DB = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) {}
let dirty = false; const save = () => { dirty = true; };
setInterval(() => { if (dirty) { dirty = false; fs.writeFile(FILE, JSON.stringify(DB), () => {}); } }, 3000).unref();

const ON = {}, ROOMS = {}, IN = {}, TMR = {};
const send = (id, o) => { const w = ON[id]; if (w && w.readyState === 1) w.send(JSON.stringify(o)); };
const U = id => DB.users[id], push = u => send(u.id, { t: "me", id: u.id, name: u.name, bal: u.bal, skins: u.skins, sel: u.sel });
const err = (id, m) => send(id, { t: "err", m });
const rk = c => c % 9, su = c => Math.floor(c / 9), beats = (a, d, ts) => su(a) === su(d) ? rk(d) > rk(a) : su(d) === ts && su(a) !== ts;
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function check(init) {
  const p = new URLSearchParams(init), h = p.get("hash"); p.delete("hash");
  const s = [...p.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
  const key = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
  if (crypto.createHmac("sha256", key).update(s).digest("hex") !== h) return null;
  const u = JSON.parse(p.get("user")); return { id: String(u.id), name: u.first_name || u.username || "Игрок", username: u.username || "" };
}
function auth(ws, m) {
  let p = null;
  if (TOKEN) { try { p = m.init && check(m.init); } catch (e) {} }
  else p = { id: "dev_" + (m.name || "guest"), name: m.name || "Гость", username: "" };
  if (!p) { ws.send(JSON.stringify({ t: "err", m: "Ошибка авторизации" })); return; }
  const u = DB.users[p.id] || (DB.users[p.id] = { id: p.id, name: p.name, username: p.username, bal: 0, skins: ["k0"], sel: "k0" });
  u.name = p.name; u.username = p.username; ws.uid = p.id;
  if (ON[p.id] && ON[p.id] !== ws) try { ON[p.id].close(); } catch (e) {}
  ON[p.id] = ws; clearTimeout(TMR[p.id]); save(); push(u);
  const r = ROOMS[IN[p.id]]; if (r) r.g ? send(p.id, view(r, r.pl.find(x => x.id === p.id))) : roomView(r);
}
const newCode = () => { let c; do c = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]).join(""); while (ROOMS[c]); return c; };

/* ---------- столы ---------- */
function roomView(r) {
  r.pl.forEach(p => send(p.id, { t: "room", code: r.code, bet: r.bet, max: r.max, host: r.host, me: p.id, pl: r.pl.map(x => ({ id: x.id, name: x.name, skin: x.skin })) }));
}
function join(r, u) {
  u.bal -= r.bet; r.pl.push({ id: u.id, name: u.name, skin: u.sel, hand: [], out: 0 }); IN[u.id] = r.code; save(); push(u);
  if (r.pl.length === r.max) start(r); else roomView(r);
}
function mk(u, m) {
  if (IN[u.id]) return err(u.id, "Ты уже за столом");
  const bet = Math.floor(+m.n), max = [2, 3, 4].includes(+m.max) ? +m.max : 2;
  if (!(bet >= 1)) return err(u.id, "Неверная ставка");
  if (u.bal < bet) return err(u.id, "Не хватает монет в банке");
  const c = newCode(); join(ROOMS[c] = { code: c, bet, max, host: u.id, pl: [], g: null }, u);
}
function jn(u, m) {
  const r = ROOMS[String(m.code || "").toUpperCase()];
  if (IN[u.id]) return err(u.id, "Ты уже за столом");
  if (!r) return err(u.id, "Стол не найден");
  if (r.g) return err(u.id, "Игра уже идёт");
  if (r.pl.length >= r.max) return err(u.id, "Стол заполнен");
  if (u.bal < r.bet) return err(u.id, "Не хватает монет в банке (нужно " + r.bet + ")");
  join(r, u);
}
function close(r) { r.pl.forEach(p => delete IN[p.id]); delete ROOMS[r.code]; }
function leave(u) {
  const r = ROOMS[IN[u.id]]; if (!r) return;
  if (r.g) return abandon(r, u.id);
  if (r.host === u.id) { r.pl.forEach(p => { U(p.id).bal += r.bet; send(p.id, { t: "room", code: null }); push(U(p.id)); }); close(r); }
  else { u.bal += r.bet; r.pl = r.pl.filter(p => p.id !== u.id); delete IN[u.id]; send(u.id, { t: "room", code: null }); push(u); roomView(r); }
  save();
}
function begin(u) {
  const r = ROOMS[IN[u.id]];
  if (!r || r.g || r.host !== u.id) return;
  if (r.pl.length < 2) return err(u.id, "Нужно минимум 2 игрока");
  start(r);
}

/* ---------- игра ---------- */
const alive = r => r.pl.filter(p => !p.out);
const nxt = (r, i) => { for (let k = 1; k <= r.pl.length; k++) { const j = (i + k) % r.pl.length; if (!r.pl[j].out) return j; } return i; };
const srt = (p, ts) => p.hand.sort((a, b) => (su(a) === ts) - (su(b) === ts) || su(a) - su(b) || rk(a) - rk(b));
function start(r) {
  const deck = shuffle(Array.from({ length: 36 }, (_, i) => i)), ts = su(deck[0]);
  r.pl.forEach(p => { p.skin = U(p.id).sel; p.out = 0; p.hand = deck.splice(deck.length - 6, 6); });
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
function play(r, i, m) {
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
  const n = r.pl.length, bonus = Math.floor(r.bet / (n - 1));
  r.pl.forEach(p => {
    const u = U(p.id); let win = 2, amt = r.bet;
    if (loser && p.id === loser.id) { win = 0; amt = 0; } else if (loser) { win = 1; amt = r.bet + bonus; }
    u.bal += amt; send(p.id, { t: "end", win, n: amt, durak: loser ? loser.name : "" }); push(u);
  });
  close(r); save();
}
function abandon(r, id) {
  const n = r.pl.length, bonus = Math.floor(r.bet / (n - 1));
  r.pl.forEach(p => { const u = U(p.id), me = p.id === id, amt = me ? 0 : r.bet + bonus; u.bal += amt; send(p.id, { t: "end", win: me ? 0 : 1, n: amt, durak: U(id).name, left: 1 }); push(u); });
  close(r); save();
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
const sendG = r => r.pl.forEach(p => send(p.id, view(r, p)));
const room = u => { const r = ROOMS[IN[u.id]]; return r && r.g ? r : null; };
function ev(r, m) { r.pl.forEach(p => send(p.id, { t: "ev", m })); }
function pay(from, to, n) { const a = Math.min(n, from.bal); from.bal -= a; to.bal += a; push(from); push(to); save(); return a; }
function cheat(u) {
  const r = room(u); if (!r) return; const g = r.g, p = r.pl.find(x => x.id === u.id);
  if (p.out || !g.disc.length) return err(u.id, "Нечего подменять: бито пусто");
  if ((g.cheats[u.id] || 0) >= 2 || g.cb[u.id] === g.bout) return err(u.id, "Шулерить можно не чаще раза за ход (2 раза за игру)");
  const c = g.disc.splice(Math.floor(Math.random() * g.disc.length), 1)[0];
  p.hand.push(c); srt(p, g.ts); g.cheats[u.id] = (g.cheats[u.id] || 0) + 1; g.cb[u.id] = g.bout; g.sus[u.id] = g.bout;
  send(u.id, { t: "ev", m: "Карта из рукава у тебя! Не попадись", me: 1 }); sendG(r);
}
function acc(u, m) {
  const r = room(u); if (!r) return; const g = r.g, t = r.pl.find(x => x.id === m.to);
  if (!t || t.id === u.id) return;
  if (g.ab[u.id] === g.bout) return err(u.id, "Обвинять можно раз за ход");
  g.ab[u.id] = g.bout;
  if (g.sus[t.id] && g.sus[t.id] >= g.bout - 1) {
    delete g.sus[t.id]; if (t.hand.length) { g.disc.push(t.hand.splice(Math.floor(Math.random() * t.hand.length), 1)[0]); }
    const a = pay(U(t.id), u, r.bet); ev(r, u.name + " поймал шулера " + t.name + "! Штраф " + a + " 🪙");
  } else { const a = pay(u, U(t.id), Math.ceil(r.bet / 2)); ev(r, u.name + " ложно обвинил " + t.name + " и заплатил " + a + " 🪙"); }
  sendG(r);
}

/* ---------- сообщения ---------- */
function handle(ws, m) {
  if (m.t === "auth") return auth(ws, m);
  const u = ws.uid && U(ws.uid); if (!u) return;
  const n = Math.floor(+m.n);
  switch (m.t) {
    case "dep": if (n >= 1) { u.bal += n; save(); push(u); } break;
    case "wd": if (n >= 1 && u.bal >= n) { u.bal -= n; save(); push(u); send(u.id, { t: "wd", n }); } else err(u.id, "Не хватает монет в банке"); break;
    case "send": {
      const q = String(m.to || "").replace(/^@/, "").toLowerCase(), v = Object.values(DB.users).find(x => x.id.toLowerCase() === q || (x.username || "").toLowerCase() === q);
      if (!v || v.id === u.id) return err(u.id, "Игрок не найден");
      if (!(n >= 1) || u.bal < n) return err(u.id, "Не хватает монет в банке");
      u.bal -= n; v.bal += n; save(); push(u); push(v); send(v.id, { t: "in", from: u.name, n }); break;
    }
    case "skins": {
      const own = (Array.isArray(m.own) ? m.own : []).filter(x => SKIDS.includes(x)); u.skins = [...new Set(["k0", ...own])];
      u.sel = u.skins.includes(m.sel) ? m.sel : "k0"; const r = ROOMS[IN[u.id]];
      if (r && !r.g) { r.pl.find(x => x.id === u.id).skin = u.sel; roomView(r); } save(); push(u); break;
    }
    case "mk": mk(u, m); break;
    case "jn": jn(u, m); break;
    case "start": begin(u); break;
    case "leave": leave(u); break;
    case "play": { const r = room(u); if (r) play(r, r.pl.findIndex(x => x.id === u.id), { c: m.c | 0, tgt: m.tgt }); break; }
    case "act": { const r = room(u); if (r) act(r, r.pl.findIndex(x => x.id === u.id)); break; }
    case "st": {
      const r = ROOMS[IN[u.id]]; if (!r || !EMO.includes(m.e) || Date.now() - (ws.ls || 0) < 800) return; ws.ls = Date.now();
      r.pl.forEach(p => send(p.id, { t: "stk", id: u.id, e: m.e })); break;
    }
    case "cheat": cheat(u); break;
    case "acc": acc(u, m); break;
  }
}
function onConn(ws) {
  ws.on("message", d => { let m; try { m = JSON.parse(d); } catch (e) { return; } try { handle(ws, m); } catch (e) { console.error(e); } });
  ws.on("close", () => {
    const id = ws.uid; if (!id || ON[id] !== ws) return; delete ON[id];
    const r = ROOMS[IN[id]]; if (!r) return;
    if (!r.g) { leave(U(id)); return; }
    TMR[id] = setTimeout(() => { const rr = ROOMS[IN[id]]; if (rr && rr.g && !ON[id]) abandon(rr, id); }, 60000);
  });
}
module.exports = { onConn, DB };
if (require.main === module) {
  const idx = path.join(__dirname, "index.html");
  const srv = http.createServer((q, s) => {
    if (q.url === "/health") return s.end("ok");
    fs.readFile(idx, (e, d) => { if (e) { s.end("Lucky Nova server"); } else { s.setHeader("Content-Type", "text/html; charset=utf-8"); s.end(d); } });
  });
  const { WebSocketServer } = require("ws"); new WebSocketServer({ server: srv }).on("connection", onConn);
  srv.listen(PORT, () => console.log("Lucky Nova server on :" + PORT + (TOKEN ? "" : " (тестовый режим без BOT_TOKEN)")));
}
