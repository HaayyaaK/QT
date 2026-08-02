import test from 'node:test';
import assert from 'node:assert/strict';
import { groupLevels, computePivots, tickDirection, spreadTier } from './pivotLevels.js';

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

test('level2 updates only when a bucket breaches 50% of level3', () => {
  const base = computePivots([[100, 10], [200, 6]], {});
  assert.equal(base.level3.qty, 10);
  assert.equal(base.level2.price, 200, '6 >= 50% of 10, so it qualifies');

  // Now a book whose non-level3 buckets are all under half of level3 (10):
  // level2 must retain its previous value rather than dropping to a weak level.
  const next = computePivots([[100, 10], [700, 2]], base);
  assert.equal(next.level2.price, 200, 'retained — 2 is below the 5.0 threshold');
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
