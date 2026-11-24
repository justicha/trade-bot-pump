import "./lib/test-env.mjs";
// elon-watch paper (KODING #25): lib/elon-paper.mjs (on-chain-time entries / exits, costs, skips, the
// offline path entry) and the lib/elon-watch.mjs core on synthetic pump events (keyword events, before /
// after matches, the five variants, paths, gaps). Pure, no network.
import assert from "node:assert/strict";

const P = await import("../lib/elon-paper.mjs");
const EW = await import("../lib/elon-watch.mjs");
const { pessimisticRoundTrip } = await import("../lib/pessimistic.mjs");
const { parseCreate, parseTrade } = await import("../lib/events.mjs");
const { createPayload, tradePayload } = await import("./mocks/ws-mock-shadow.mjs");
const { key, curveTradePayload, vTokAtFill } = await import("./mocks/ws-mock-census.mjs");
let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log(`ok - ${m}`);
};
const res = (fill) => ({ vSol: 30e9 + (fill / 100) * 85e9, vTok: P.CURVE_K / (30e9 + (fill / 100) * 85e9) });
const manualNet = (entry, exit, buySol, delayMs) => {
  const tok = (entry.vTok * buySol * 1e9) / (entry.vSol + buySol * 1e9);
  const ratio = (exit.vSol * tok) / (exit.vTok + tok) / 1e9 / buySol;
  const rt = pessimisticRoundTrip({ buySol, ratio, delayMs });
  return Math.round((rt.netPnl / buySol) * 100 * 100) / 100;
};

// 1. entry on ON-CHAIN time: first priced trade with second >= ceil(decision + delay); exits on the stream clock
{
  const book = P.createPaperBook({ buySol: 0.02, delayMs: 300, horizonsSec: [300, 900] });
  P.paperTrade(book, "M", { sec: 1000, res: res(10), recvMs: 1_000_100 });
  const p = P.paperOpen(book, { eventId: "e", variant: "first", mint: "M", decisionMs: 1_000_500, streamLagSec: 0.5, detectLagMs: 1200 });
  assert.equal(p.entryFromSec, 1001, "1000.5 s + 300 ms -> from second 1001");
  assert.equal(p.state, "pending", "the trade of second 1000 is before the decision");
  P.paperTrade(book, "M", { sec: 1000, res: res(11), recvMs: 1_000_900 }); // received after the decision, on-chain before it
  assert.equal(p.state, "pending", "a trade of an earlier on-chain second never fills, whenever it arrives");
  P.paperTrade(book, "M", { sec: 1001, res: null, recvMs: 1_001_100 });
  assert.equal(p.state, "pending", "a trade without reserves does not fill");
  // received 40 s late (a lagging public stream): still the price of on-chain second 1002
  P.paperTrade(book, "M", { sec: 1002, res: res(12), recvMs: 1_042_000 });
  assert.equal(p.state, "open");
  assert.equal(p.entrySec, 1002);
  assert.equal(p.entryLagSec, 40);
  P.paperTrade(book, "M", { sec: 1200, res: res(30), recvMs: 1_200_200 });
  P.paperTrade(book, "M", { sec: 1303, res: res(50), recvMs: 1_303_200 }); // after entry + 300: not the +5 min state
  P.paperClock(book, 1303);
  assert.deepEqual(P.paperTick(book), [], "+15 min not reached");
  P.paperClock(book, 1903);
  const [row] = P.paperTick(book);
  assert.equal(row.type, "elon_paper");
  assert.equal(row.priceSource, "onchain-trade");
  assert.equal(row.entrySec, 1002);
  assert.equal(row.exits[300].exitSec, 1200, "the last trade at or before entry + 300");
  assert.equal(row.exits[300].netPct, manualNet(res(12), res(30), 0.02, 300));
  assert.equal(row.exits[900].exitSec, 1303);
  assert.equal(row.exits[900].netPct, manualNet(res(12), res(50), 0.02, 300));
  assert.equal(row.netPct, row.exits[300].netPct);
  assert.equal(row.costsScheme, P.ELON_COSTS_SCHEME);
  assert.equal(row.streamLagSec, 0.5);
  assert.equal(row.detectLagMs, 1200);
  assert.equal(row.delayMs, 300);
  // a flat round trip loses the costs: pump 1% + 1%, slippage 54 bps x 2, two tx fees (0.000455 SOL each at
  // the default CU price = 4.55% of 0.02 SOL), impact of 0.02 SOL both legs: ~ -7.7% (gshadow v3: -7.63%)
  const flat = P.paperResult(res(20), res(20), 0.02);
  assert.ok(flat.netPct < -7.6 && flat.netPct > -7.9, `flat round trip ${flat.netPct}%`);
  ok("entry = first priced trade with on-chain second >= ceil(decision + delay), even when received 40 s late; exits = state at entry + h once the stream clock passed it; net = curve impact both legs + pessimisticRoundTrip");
}

// 2. skips, unfilled, curve end, shutdown
{
  const book = P.createPaperBook({ buySol: 0.02, delayMs: 200 });
  assert.equal(P.paperOpen(book, { eventId: "e", variant: "first", mint: "MAY", decisionMs: 5_000_000, info: { mayhem: true } }), null);
  assert.equal(P.paperOpen(book, { eventId: "e", variant: "first", mint: "Q", decisionMs: 5_000_000, info: { quoteMint: "USD1" } }), null);
  P.paperOpen(book, { eventId: "e", variant: "lead30", mint: "LATEQ", decisionMs: 5_000_000 });
  const skipQ = P.paperSkipMint(book, "LATEQ", "quote");
  assert.equal(skipQ[0].skip, "quote");
  P.paperOpen(book, { eventId: "e", variant: "lead60", mint: "DEAD", decisionMs: 5_000_000 });
  P.paperTrade(book, "END", { sec: 5000, res: res(90) });
  const pe = P.paperOpen(book, { eventId: "e", variant: "linked", mint: "END", decisionMs: 4_999_000 });
  assert.equal(pe.state, "open", "a trade already known at or after the entry second fills at once");
  P.paperTrade(book, "END", { sec: 5100, res: res(100), completed: true });
  const open = P.paperOpen(book, { eventId: "e2", variant: "first", mint: "OPEN", decisionMs: 5_000_000 });
  P.paperTrade(book, "OPEN", { sec: 5001, res: res(5) });
  assert.equal(open.state, "open");
  P.paperClock(book, 5062);
  let rows = P.paperTick(book);
  const skips = rows.filter((r) => r.skip);
  assert.deepEqual(skips.map((r) => r.skip).sort(), ["mayhem", "quote"]);
  assert.ok(skips.every((r) => r.netPct === null && r.final === "skipped"));
  const unf = rows.find((r) => r.mint === "DEAD");
  assert.equal(unf.final, "unfilled", "no trade within 60 s of the entry second (stream clock)");
  P.paperClock(book, 5901);
  rows = P.paperTick(book);
  const end = rows.find((r) => r.mint === "END");
  assert.equal(end.exits[300].venue, "curve-end");
  assert.equal(end.exits[300].exitSec, 5100);
  assert.equal(end.exits[300].netPct, manualNet(res(90), P.reservesFromPrice(P.STANDARD_CURVE_END), 0.02, 200));
  const fin = P.paperFinishAll(book);
  assert.equal(fin.length, 1);
  assert.equal(fin[0].mint, "OPEN");
  assert.equal(fin[0].final, "shutdown");
  assert.equal(fin[0].exits[900], null, "a horizon not reached stays null");
  assert.ok(Math.abs(P.priceFromFill(100) - P.STANDARD_CURVE_END) / P.STANDARD_CURVE_END < 1e-3, "fill 100 = the standard curve end");
  assert.ok(Math.abs(P.priceOf(P.reservesFromPrice(3e-8)) - 3e-8) < 1e-15);
  ok("skips (mayhem / other quote at open, a quote found later), unfilled after 60 s of stream clock, completion -> curve-end price, shutdown keeps unreached horizons null");
}

// 3. offline entry on a census_path row
{
  const pc = (f) => Number(P.priceFromFill(f).toPrecision(6));
  const row = { t0: 1000, t: [0, 2, 5, 70, 400], h: [1, 3, 20, 60, 40], pc: [pc(1), pc(3), null, pc(50), pc(40)], endT: 500, completeSec: null, holes: [[60, 65, "gap"]] };
  const r = P.evalPathEntry(row, { entryFromSec: 1003, buySol: 0.02, horizons: [60, 600] });
  assert.equal(r.entrySec, 1070, "the bucket of second 1005 has no price: the next priced one");
  assert.equal(r.exits[60].netPct, P.paperResult(P.reservesFromPrice(pc(50)), P.reservesFromPrice(pc(50)), 0.02).netPct);
  assert.equal(r.exits[600], null, "after endT: not covered");
  assert.equal(r.maxAtSec, 0);
  const r2 = P.evalPathEntry(row, { entryFromSec: 1001, buySol: 0.02, horizons: [60] });
  assert.equal(r2.entrySec, 1002);
  assert.equal(r2.maxAtSec, 68, "max from the bucket high fill");
  assert.ok(Math.abs(r2.maxMult - P.priceFromFill(60) / pc(3)) < 1e-3);
  assert.equal(r2.holes, true);
  const done = P.evalPathEntry({ ...row, completeSec: 100 }, { entryFromSec: 1001, buySol: 0.02, horizons: [300] });
  assert.equal(done.exits[300].venue, "curve-end");
  assert.equal(P.evalPathEntry({ ...row, mayhem: true }, { entryFromSec: 1001, buySol: 0.02 }).why, "mayhem");
  assert.equal(P.evalPathEntry(row, { entryFromSec: 2000, buySol: 0.02 }).why, "after-path");
  ok("offline path entry: first priced bucket at or after the entry second, exits from the last bucket <= exit (null after endT, curve end after completion), max from h, holes flagged, mayhem skipped");
}

// 4. the core: keyword events, before / after matches, variants, paths, gap
{
  const T = 1_900_000_000;
  const W = EW.createWatch({ buySol: 0.02, delayMs: 300, followSec: 600 });
  const C = (mint, name, symbol, ts, user = key(900)) => parseCreate(createPayload({ mint, creator: user, user, name, symbol, ts }));
  const tr = (mint, fill, ts, user, isBuy = true, sol = 0.5) => {
    const raw = tradePayload({ mint, user, realSol: (fill / 100) * 85e9, isBuy, ts, solLamports: sol * 1e9 });
    return [parseTrade(raw), raw];
  };
  const A = key(1), B = key(2), Cm = key(3), Q = key(4), X = key(5);
  const all = [];
  const run = (rows) => (all.push(...rows), rows);
  run(EW.onCreate(W, C(A, "Saturn Coin", "STC", T - 100), { nowMs: (T - 99) * 1000 }));
  run(EW.onCreate(W, C(X, "Jupiter", "JUP", T - 50), { nowMs: (T - 49) * 1000 }));
  const postId = "1990000000000000001";
  const post = { id: postId, postMs: T * 1000, kind: "post", text: "Saturn", refs: [], media: [], seenAtMs: T * 1000 + 2000, provider: "api" };
  let rows = run(EW.onPost(W, post, { nowMs: T * 1000 + 2000 }));
  assert.equal(rows[0].type, "elon_post");
  assert.equal(rows[0].detectLagMs, 2000);
  const kwRow = rows.find((r) => r.type === "elon_kw");
  assert.equal(kwRow.eventId, `${postId}:saturn`);
  assert.equal(kwRow.matchesBefore, 1);
  const mA = rows.find((r) => r.type === "elon_match");
  assert.equal(mA.mint, A);
  assert.equal(mA.side, "before");
  assert.equal(mA.fromIndex, true);
  assert.equal(mA.streamLagSec, 52, "local now - newest on-chain second");
  assert.equal(EW.onPost(W, post, { nowMs: T * 1000 + 2500 }).length, 0, "a post is processed once");
  rows = run(EW.onCreate(W, C(B, "Bob", "SATURN", T + 5), { nowMs: (T + 6) * 1000 }));
  assert.equal(rows[0].mint, B);
  assert.equal(rows[0].side, "after");
  assert.equal(rows[0].kind, "symbol");
  assert.equal(rows[0].dtSec, 5);
  run(EW.onCreate(W, C(Q, "Saturn Q", "SQ", T + 6), { nowMs: (T + 7) * 1000 }));
  run(EW.onCreate(W, C(Cm, "Saturn Moon", "SM", T + 7), { nowMs: (T + 8) * 1000 }));
  run(EW.onCreate(W, C(key(6), "Unrelated", "UNR", T + 8), { nowMs: (T + 9) * 1000 }));
  // trades: B gets 3 buyers after the post, A 1; Q turns out to be quoted in another mint
  for (const [m, f, s, u, b] of [[B, 2, T + 8, key(101)], [B, 3, T + 9, key(102)], [B, 4, T + 10, key(103)], [A, 5, T + 10, key(104)], [A, 4, T + 11, key(900), false]]) run(EW.onTrade(W, ...tr(m, f, s, u, b), { nowMs: (s + 1) * 1000 }));
  // three wallets bought A BEFORE the post (on-chain), delivered late: they must not count for the lead score
  for (const u of [201, 202, 203]) run(EW.onTrade(W, ...tr(A, 4, T - 10, key(u)), { nowMs: (T + 11) * 1000 }));
  const qraw = curveTradePayload({ mint: Q, user: key(105), ts: T + 9, vTok: vTokAtFill(2), quoteMint: key(77), sol: null });
  rows = run(EW.onTrade(W, parseTrade(qraw), qraw, { nowMs: (T + 10) * 1000 }));
  assert.ok(W.watches.get(Q).quoteMint, "the trade tail shows another quote mint");
  run(EW.onMeta(W, Cm, { meta: { twitter: `https://x.com/elonmusk/status/${postId}` } }, { nowMs: (T + 12) * 1000 }));
  run(EW.onTrade(W, ...tr(Cm, 3, T + 13, key(106)), { nowMs: (T + 14) * 1000 }));
  run(EW.tick(W, { nowMs: (T + 30) * 1000 + 10 }));
  run(EW.onTrade(W, ...tr(B, 6, T + 32, key(107)), { nowMs: (T + 33) * 1000 }));
  run(EW.onTrade(W, ...tr(A, 6, T + 32, key(108)), { nowMs: (T + 33) * 1000 }));
  run(EW.tick(W, { nowMs: (T + 60) * 1000 + 10 }));
  for (const m of [A, B, Cm]) run(EW.onTrade(W, ...tr(m, 8, T + 62, key(109)), { nowMs: (T + 63) * 1000 }));
  // a stream gap: 12 s without an event, then one
  run(EW.tick(W, { nowMs: (T + 75) * 1000 + 10 }));
  rows = run(EW.onTrade(W, ...tr(B, 10, T + 76, key(110)), { nowMs: (T + 76) * 1000 }));
  assert.equal(rows[0].type, "elon_gap");
  assert.equal(rows[0].source, "pump");
  // a repeat of the keyword within 24 h
  rows = run(EW.onPost(W, { ...post, id: "1990000000000000002", postMs: (T + 100) * 1000 }, { nowMs: (T + 101) * 1000 }));
  assert.equal(rows.find((r) => r.type === "elon_kw").repeat, true);
  // the clock passes every exit and the follow window
  rows = run(EW.onCreate(W, C(key(7), "Saturn Late", "SLATE", T + 705), { nowMs: (T + 706) * 1000 }));
  assert.ok(!rows.some((r) => r.type === "elon_match"), "a create after post + ELON_FOLLOW_SEC (of both posts) is not matched");
  for (const s of [T + 400, T + 1000, T + 1700]) {
    run(EW.onTrade(W, ...tr(X, 1, s, key(111)), { nowMs: (s + 1) * 1000 }));
    run(EW.tick(W, { nowMs: (s + 1) * 1000 }));
  }
  run(EW.finishAll(W, { nowMs: (T + 1702) * 1000 }));
  const paper = all.filter((r) => r.type === "elon_paper");
  const v = (name) => paper.filter((r) => r.variant === name && r.eventId === `${postId}:saturn`);
  assert.equal(v("first").length, 1);
  assert.equal(v("first")[0].mint, B, "first = the first create AFTER the post");
  assert.equal(v("first")[0].entrySec, T + 8);
  assert.ok(v("first")[0].exits[300] && v("first")[0].exits[900]);
  assert.equal(v("linked")[0].mint, Cm);
  assert.equal(v("linked")[0].entrySec, T + 13);
  assert.equal(v("lead30")[0].mint, B, "most unique buyers since the post");
  assert.deepEqual(v("lead30")[0].score, { mint: B, buyers: 3, inflowSol: 1.5, cands: 3 });
  assert.equal(v("lead60")[0].mint, B);
  const legs = v("basket3").filter((r) => !r.skip);
  assert.equal(legs.length, 3);
  assert.ok(legs.every((r) => Math.abs(r.buySol - 0.02 / 3) < 1e-12 && r.basket === `${postId}:saturn:b3`));
  assert.ok(!legs.some((r) => r.mint === Q), "the other-quote mint is not a candidate");
  assert.ok(paper.every((r) => "streamLagSec" in r && r.costsScheme === P.ELON_COSTS_SCHEME));
  const paths = all.filter((r) => r.type === "elon_path");
  assert.deepEqual(paths.map((p) => p.mint).sort(), [A, B, Cm, Q].sort());
  const pB = paths.find((p) => p.mint === B);
  assert.equal(pB.final, "follow");
  assert.equal(pB.t0, T + 5);
  assert.ok(pB.t.length === pB.o.length && pB.o.length === pB.nw.length && pB.pc.length === pB.t.length, "census_path columns");
  assert.ok(pB.holes.some((h) => h[2] === "gap"));
  assert.deepEqual(pB.events, [`${postId}:saturn`, "1990000000000000002:saturn"], "the repeat post followed it too (a before-match)");
  assert.equal(paths.find((p) => p.mint === Cm).linked, true);
  assert.equal(paths.find((p) => p.mint === A).launcherSells.length + paths.find((p) => p.mint === A).creatorSells.length, 1, "the launcher's sell");
  assert.ok(!all.some((r) => r.type === "elon_match" && r.mint === key(6)));
  const st = EW.stats(W);
  assert.equal(st.posts, 2);
  assert.equal(st.repeats, 1);
  assert.equal(st.detectLagMs.p50, 2000);
  ok("core: before match from the index, after matches from new creates; first / linked / lead30 / lead60 / basket3 on on-chain prices; other-quote skipped; repeat flag; gap row + path hole; elon_path in the census_path format");
}

// 5. completion ends the follow with a complete path; a mayhem trade tail turns the mint ineligible
{
  const T = 1_900_100_000;
  const W = EW.createWatch({ buySol: 0.02, delayMs: 300 });
  const M1 = key(21), M2 = key(22);
  EW.onPost(W, { id: "1990000000000000009", postMs: T * 1000, kind: "post", text: "Kekius", refs: [], media: [] }, { nowMs: T * 1000 + 500 });
  EW.onCreate(W, parseCreate(createPayload({ mint: M1, creator: key(5), name: "Kekius", symbol: "KEK", ts: T + 1 })), { nowMs: (T + 2) * 1000 });
  EW.onCreate(W, parseCreate(createPayload({ mint: M2, creator: key(5), name: "Kekius Max", symbol: "KM", ts: T + 1 })), { nowMs: (T + 2) * 1000 });
  const raw = tradePayload({ mint: M1, user: key(31), realSol: 85e9, ts: T + 3 });
  const rows = EW.onTrade(W, parseTrade(raw), raw, { nowMs: (T + 4) * 1000 });
  const p = rows.find((r) => r.type === "elon_path");
  assert.equal(p.final, "complete");
  assert.equal(p.migrated, true);
  assert.equal(p.completeSec, 2);
  assert.ok(!W.watches.has(M1));
  const mraw = curveTradePayload({ mint: M2, user: key(32), ts: T + 3, vTok: vTokAtFill(5), mayhem: true });
  EW.onTrade(W, parseTrade(mraw), mraw, { nowMs: (T + 4) * 1000 });
  assert.equal(W.watches.get(M2).mayhem, true);
  const out = [...EW.tick(W, { nowMs: (T + 31) * 1000 }), ...EW.finishAll(W, { nowMs: (T + 32) * 1000 })];
  const lead = out.find((r) => r.type === "elon_paper" && r.variant === "lead30");
  assert.equal(lead.skip, "no-candidate", "the completed mint is no longer watched and the mayhem one is ineligible");
  ok("completion -> elon_path final complete (migrated, completeSec); a mayhem trade tail makes the mint ineligible for the lead variants");
}

console.log(`elon-paper: ${passed} checks passed`);
