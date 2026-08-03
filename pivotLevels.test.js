import test from 'node:test';
import assert from 'node:assert/strict';
import { groupLevels, computePivots, tickDirection, spreadTier, dynamicFloor } from './pivotLevels.js';

test('groupLevels: sums quantity per bucket and reports the dominant price', () => {
  // Two clusters: ~100 with a 5.0 wall, ~110 with a 2.0 wall
  const levels = [[100, 1], [100.5, 5], [101, 0.5], [110, 2], [110.5, 0.5]];
  const g = groupLevels(levels, 4);
  assert.equal(g[0].price, 100.5, 'largest bucket reports its biggest resting order');
  assert.ok(g[0].qty > g[1].qty, 'sorted by grouped quantity descending');
});

test('groupLevels: ignores malformed and non-positive levels', () => {
  const g = groupLevels([[100, 1], [101, 0], [NaN, 5], [102, -3], ['x', 1], null], 4);
  assert.equal(g.reduce((s, b) => s + b.qty, 0), 1);
});

test('groupLevels: all levels at one price collapse to a single wall', () => {
  const g = groupLevels([[100, 2], [100, 3]], 8);
  assert.deepEqual(g, [{ price: 100, qty: 5 }]);
});

test('groupLevels: empty input yields no groups', () => {
  assert.deepEqual(groupLevels([], 8), []);
  assert.deepEqual(groupLevels(null, 8), []);
});

test('level3 freezes and does NOT move when later books are weaker', () => {
  const strong = [[100, 10], [200, 1]];
  const first = computePivots(strong, {});
  assert.equal(first.level3.price, 100);
  assert.equal(first.level3.qty, 10);

  // A much weaker book arrives — level3 must stay put
  const weak = [[300, 2], [400, 1]];
  const second = computePivots(weak, first);
  assert.equal(second.level3.price, 100, 'frozen at the original price');
  assert.equal(second.level3.qty, 10);
});

test('level3 moves when a new grouped quantity reaches or exceeds it', () => {
  const first = computePivots([[100, 10]], {});
  // Exactly equal must replace it — spec says "reaches or exceeds"
  const equal = computePivots([[500, 10]], first);
  assert.equal(equal.level3.price, 500);
  const bigger = computePivots([[900, 11]], equal);
  assert.equal(bigger.level3.price, 900);
});

test('level2 updates only when a bucket clears the dynamic floor', () => {
  const base = computePivots([[100, 10], [200, 6]], {});
  assert.equal(base.level3.qty, 10);
  // floor = avg([10,6]) * 0.5 = 4; 6 >= 4 clears it.
  assert.equal(base.level2.price, 200, '6 clears the floor (avg([10,6])*0.5 = 4)');

  // Now a book whose non-level3 bucket (2) is under the floor recomputed
  // from THIS book (avg([10,2])*0.5 = 3; 2 < 3): level2 must retain its
  // previous value rather than dropping to a weak level.
  const next = computePivots([[100, 10], [700, 2]], base);
  assert.equal(next.level2.price, 200, 'retained — 2 is below the recomputed floor of 3');
});

test('level1 is fully dynamic and never collides with level2/level3', () => {
  const s1 = computePivots([[100, 10], [200, 6], [300, 3]], {});
  assert.equal(s1.level3.price, 100);
  assert.equal(s1.level2.price, 200);
  assert.equal(s1.level1.price, 300, 'largest remaining bucket');

  // level1 tracks the newest book even while the other two are pinned
  const s2 = computePivots([[100, 10], [200, 6], [800, 4]], s1);
  assert.equal(s2.level3.price, 100, 'still frozen');
  assert.equal(s2.level1.price, 800, 'moved with the book');
  assert.notEqual(s2.level1.price, s2.level2.price);
  assert.notEqual(s2.level1.price, s2.level3.price);
});

test('level2 falls back to the runner-up, flagged below threshold, on a thin book', () => {
  // One wall dwarfs everything — the exact production case where S2 rendered
  // a confident-looking wall out of dust (0.8, 8% of level3's size) under an
  // earlier gap-based attempt at this. floor = avg([10,0.8,0.5])*0.5 ≈ 1.88;
  // 0.8 doesn't clear it.
  const p = computePivots([[100, 10], [200, 0.8], [300, 0.5]], {});
  assert.equal(p.level3.qty, 10);
  assert.ok(p.level2, 'must not be blank');
  assert.equal(p.level2.qualified, false, 'flagged as under the floor');
  assert.equal(p.level2.price, 200, 'strongest remaining bucket');
  assert.notEqual(p.level1.price, p.level2.price, 'level1 still distinct');
});

test('widening the price window finds a wall the fine pass split apart', () => {
  // Three parcels (300/340/380, 1.4 each) stay in separate fine buckets and
  // individually miss the fine floor (computed from [10, 1.4, 1.4, 1.4],
  // avg 3.45, floor 1.775 — each parcel is under it). Widening to 4 coarse
  // buckets merges two of them (340+380 -> 2.8), which clears the COARSE
  // floor (computed from the coarser [10, 2.8, 1.4], avg 4.73, floor 2.37 —
  // 2.8 clears it). Verified against the real module before writing this
  // fixture, not derived by hand: a floor test behaves oppositely from the
  // old gap/ratio tests here — aggregating RAISES a candidate's quantity,
  // which helps it clear a floor (the opposite of a gap test, where
  // aggregating raises the bar right along with the candidate).
  const levels = [[100, 10], [300, 1.4], [340, 1.4], [380, 1.4]];
  const fine = groupLevels(levels, 8);
  const fineFloor = dynamicFloor(fine);
  assert.ok(
    fine.filter(g => g.price !== 100).every(g => g.qty < fineFloor),
    'fixture must genuinely miss the floor at fine granularity'
  );
  const p = computePivots(levels, {});
  assert.equal(p.level3.qty, 10);
  assert.equal(p.level2.qualified, true, 'aggregated parcels clear the coarse floor');
  assert.equal(p.level2.widened, true, 'and it took the wider window to see it');
  assert.equal(p.level2.price, 340, 'the merged bucket, reported at its largest resting order');
  assert.equal(p.level2.qty, 2.8, '340 + 380 combined');
});

test('a genuinely qualified level2 is never downgraded to the fallback', () => {
  const base = computePivots([[100, 10], [200, 6]], {});
  assert.equal(base.level2.qualified, true);
  // Book thins out — the old behaviour (retain) must still win over the
  // new runner-up fallback.
  const next = computePivots([[100, 10], [700, 0.2]], base);
  assert.equal(next.level2.price, 200, 'retained');
  assert.equal(next.level2.qualified, true);
});

test('an unqualified level2 is replaced as soon as a real wall appears', () => {
  const thin = computePivots([[100, 10], [200, 0.8]], {});
  assert.equal(thin.level2.qualified, false);
  const recovered = computePivots([[100, 10], [500, 7]], thin);
  assert.equal(recovered.level2.price, 500);
  assert.equal(recovered.level2.qualified, true);
});

// Regression coverage for a design mistake caught before it shipped: a
// gap-based qualifying test ("candidate must be smaller than level3 by some
// dynamic amount") was tried first, from a literal reading of the original
// spec. It let dust — a bucket at 8% of level3's size — qualify as a
// confident wall, because a BIGGER size difference from level3 passed the
// gap test more easily. That's backwards: a floor answers "is this
// significant", which is the actual question; a gap only answers "is this
// different from level3", which dust trivially satisfies.
test('dynamicFloor scales with the book, not with level3 specifically', () => {
  // Same relative shape (one dominant wall, rest under 10% of it), two very
  // different absolute scales — BTC-sized quantities and FX-notional-sized
  // quantities. The floor must scale with each book's own units.
  const btcLike = groupLevels([[63000, 12], [63010, 0.9], [63020, 0.7]], 8);
  const fxLike = groupLevels([[1.085, 2_400_000], [1.086, 180_000], [1.087, 140_000]], 8);
  const btcFloor = dynamicFloor(btcLike);
  const fxFloor = dynamicFloor(fxLike);
  assert.ok(btcFloor > 1 && btcFloor < 10, `BTC floor should be BTC-scale, got ${btcFloor}`);
  assert.ok(fxFloor > 100_000 && fxFloor < 2_000_000, `FX floor should be notional-scale, got ${fxFloor}`);
});

test('dust does not qualify as level2 no matter how far it is from level3', () => {
  // The exact failure mode the gap-based attempt had: an 8%-of-level3 bucket
  // (10 vs 0.8) must NOT read as a confident, non-muted wall.
  const p = computePivots([[100, 10], [200, 0.8]], {});
  assert.equal(p.level2.qualified, false, 'dust must not qualify merely for being far from level3 in size');
});

// Staleness invalidation: live production observation. A bid-side (support)
// level2 sat at a fixed price 24-32 points above a falling mid — on the ASK
// side of the market — for a sustained window, still rendered with full
// "qualified" confidence, because retention (the branch covered by the two
// tests above) never re-checked whether the retained value was still
// plausible once the market moved past it.

test('a retained ask-side level2 is invalidated once mid rises above it (no longer real resistance)', () => {
  const base = computePivots([[100, 10], [102, 6]], {}, { mid: 99, side: 'asks' });
  assert.equal(base.level2.price, 102);
  assert.equal(base.level2.qualified, true);
  // Book thins (nothing new qualifies) AND mid has risen past 102 — the
  // retained ask level is now below the market, i.e. not resistance at all.
  const next = computePivots([[100, 10], [700, 0.2]], base, { mid: 105, side: 'asks' });
  assert.notEqual(next.level2 && next.level2.price, 102, 'stale, wrong-side retention must not survive');
});

test('a retained bid-side level2 is invalidated once mid falls below it (no longer real support)', () => {
  const base = computePivots([[100, 10], [98, 6]], {}, { mid: 99, side: 'bids' });
  assert.equal(base.level2.price, 98);
  const next = computePivots([[100, 10], [10, 0.2]], base, { mid: 95, side: 'bids' });
  assert.notEqual(next.level2 && next.level2.price, 98, 'stale, wrong-side retention must not survive');
});

test('a retained level2 that is still on the correct side of mid survives exactly as before', () => {
  const base = computePivots([[100, 10], [102, 6]], {}, { mid: 99, side: 'asks' });
  // mid has moved but 102 is still >= mid — genuinely still resistance.
  const next = computePivots([[100, 10], [700, 0.2]], base, { mid: 101, side: 'asks' });
  assert.equal(next.level2.price, 102, 'still on the correct side — retention holds');
  assert.equal(next.level2.qualified, true);
});

test('omitting mid/side disables the staleness check entirely (backward compatible)', () => {
  // Old call sites (or a caller that genuinely has no mid yet) keep the
  // pre-existing unconditional-retention behaviour.
  const base = computePivots([[100, 10], [200, 6]], {});
  const next = computePivots([[100, 10], [700, 0.2]], base); // no opts at all
  assert.equal(next.level2.price, 200, 'no mid/side supplied — retention is unconditional, as before');
});

test('staleness check also applies on the empty-book early-return path', () => {
  const base = computePivots([[100, 10], [102, 6]], {}, { mid: 99, side: 'asks' });
  assert.equal(base.level2.price, 102);
  // Book goes fully empty AND mid has moved past the retained level.
  const next = computePivots([], base, { mid: 105, side: 'asks' });
  assert.equal(next.level2, null, 'stale retained value must not survive the empty-book path either');
});

test('a single-bucket book yields no level2 at all (explicit empty state)', () => {
  const p = computePivots([[100, 3]], {});
  assert.equal(p.level3.price, 100);
  assert.equal(p.level2, null, 'nothing to be runner-up');
  assert.equal(p.level1, null);
});

test('an empty book preserves frozen levels and clears only the dynamic one', () => {
  const seeded = computePivots([[100, 10], [200, 6]], {});
  const empty = computePivots([], seeded);
  assert.equal(empty.level3.price, 100);
  assert.equal(empty.level2.price, 200);
  assert.equal(empty.level1, null);
});

test('the same logic applies symmetrically to bids (support side)', () => {
  // Bids are descending; grouping is side-agnostic
  const bids = [[63000, 1], [62995, 8], [62990, 2]];
  const p = computePivots(bids, {});
  assert.equal(p.level3.price, 62995, 'strongest support wall');
});

test('tickDirection: up, down, flat, and unknown-on-first-update', () => {
  assert.equal(tickDirection(101, 100), 'up');
  assert.equal(tickDirection(99, 100), 'down');
  assert.equal(tickDirection(100, 100), 'flat');
  assert.equal(tickDirection(100, null), 'flat', 'no previous mid yet');
  assert.equal(tickDirection(null, 100), 'flat');
});

test('spreadTier: classifies by relative width so it works across symbols', () => {
  // BTC ~63000: a $0.10 spread is extremely tight (0.016 bps)
  assert.equal(spreadTier(0.1, 63000), 'tight');
  // ~3.7 bps — noticeably wider, e.g. the thinner Binance BTCUSD book
  assert.equal(spreadTier(23.43, 63000), 'widening');
  // ~15 bps — a real liquidity gap
  assert.equal(spreadTier(95, 63000), 'wide');
  // Same relative widths classify identically on a low-priced symbol
  assert.equal(spreadTier(0.005, 3200), 'tight');
  assert.equal(spreadTier(1.0, 3200), 'widening');
  assert.equal(spreadTier(10, 3200), 'wide');
});

test('spreadTier: guards missing or nonsensical inputs', () => {
  assert.equal(spreadTier(null, 63000), 'unknown');
  assert.equal(spreadTier(1, null), 'unknown');
  assert.equal(spreadTier(NaN, 63000), 'unknown');
});
