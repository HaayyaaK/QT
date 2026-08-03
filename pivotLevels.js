// Dynamic pivot levels (R1/R2/R3 on asks, S1/S2/S3 on bids) derived from
// grouped order-book liquidity, plus the mid-price tick and spread-width
// classification that the pivot card renders alongside them.
//
// Scope note: this runs over whatever depth the providers already supply
// (~10-12 levels per side, roughly a $4 band on BTC). That is a deliberate
// stability-over-reach choice — deepening the book would mean local
// order-book maintenance on Binance's diff stream and re-validating the
// failover chain. So these levels describe *immediate passive liquidity*
// within the top of book, not deep historical support/resistance. The card
// labels them accordingly.

// Collapse a side of the book into price buckets and sum the quantity in
// each. Bucket width is derived from the side's own price span rather than
// hardcoded, so the same code works for BTC at ~$63,000 and ETH at ~$3,200
// without a per-symbol tick table.
//
// Each bucket reports the price of its single largest resting order rather
// than the bucket's midpoint: that is the price a trader would actually see
// the wall sitting at.
export function groupLevels(levels, bucketCount = 8) {
  const clean = (levels || []).filter(
    (l) => Array.isArray(l) && Number.isFinite(l[0]) && Number.isFinite(l[1]) && l[1] > 0
  );
  if (!clean.length) return [];
  const prices = clean.map((l) => l[0]);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const width = (max - min) / bucketCount;
  if (!(width > 0)) {
    // Every level at one price — a single wall, not a distribution.
    return [{ price: min, qty: clean.reduce((s, l) => s + l[1], 0) }];
  }
  const buckets = new Map();
  for (const [price, qty] of clean) {
    const idx = Math.min(bucketCount - 1, Math.floor((price - min) / width));
    const b = buckets.get(idx) || { qty: 0, topPrice: price, topQty: -1 };
    b.qty += qty;
    if (qty > b.topQty) { b.topQty = qty; b.topPrice = price; }
    buckets.set(idx, b);
  }
  return [...buckets.values()]
    .map((b) => ({ price: b.topPrice, qty: b.qty }))
    .sort((a, b) => b.qty - a.qty || a.price - b.price);
}

// Default grouping granularity, and the coarser fallback used when the fine
// pass finds no second wall. Fewer buckets means wider price windows, which
// aggregates adjacent resting orders that individually miss the threshold.
export const DEFAULT_BUCKETS = 8;
export const COARSE_BUCKETS = 4;
export const LEVEL2_RATIO = 0.5;

function bestQualifying(groups, excludePrice, threshold) {
  return groups.find((g) => g.price !== excludePrice && g.qty >= threshold) || null;
}

// Apply the three persistence rules to one side of the book.
//
//   level3 — the strongest wall seen this session. Frozen: only replaced when
//            a new grouped quantity *reaches or exceeds* it. A weaker book
//            leaves it untouched, so it can point at a price whose liquidity
//            has since been consumed. That is the specified behaviour.
//   level2 — the 50%-of-level3 wall. See the resolution order below.
//   level1 — fully dynamic: the largest remaining bucket, recomputed every
//            update, excluding whatever level2/level3 already occupy.
//
// level2 resolution, in order — the first three preserve the original
// semantics exactly; only the fourth is new:
//
//   1. A bucket at the normal granularity clearing 50% of level3.
//   2. Failing that, re-group into wider price windows and look again. A
//      thin book often has its second wall spread across neighbouring ticks
//      that only clear the threshold once aggregated, so this finds real
//      walls the fine pass splits apart rather than inventing one.
//   3. Failing that, retain a previously *qualified* level2, exactly as
//      before — a genuine wall is never downgraded by a quiet moment.
//   4. Failing that, surface the strongest remaining bucket flagged
//      `qualified: false`, so the row shows the runner-up and says it is
//      under threshold instead of rendering an unexplained blank.
//
// Only a book with a single bucket — nothing to be runner-up — yields null,
// which the card renders as an explicit "no second wall" state.
//
// `prev` is the same shape this returns, so callers just feed the last result
// back in. Pure — the caller owns when to reset (see the pivot key in the
// dashboard's book flush).
export function computePivots(levels, prev = {}, opts = {}) {
  const fine = groupLevels(levels, opts.bucketCount || DEFAULT_BUCKETS);
  if (!fine.length) return { level1: null, level2: prev.level2 || null, level3: prev.level3 || null };

  const strongest = fine[0];
  let level3 = prev.level3 || null;
  if (!level3 || strongest.qty >= level3.qty) level3 = { price: strongest.price, qty: strongest.qty };

  const threshold = level3.qty * LEVEL2_RATIO;

  let candidate = bestQualifying(fine, level3.price, threshold);
  let widened = false;
  if (!candidate) {
    const coarse = groupLevels(levels, opts.coarseBucketCount || COARSE_BUCKETS);
    candidate = bestQualifying(coarse, level3.price, threshold);
    widened = !!candidate;
  }

  let level2;
  if (candidate) {
    level2 = { price: candidate.price, qty: candidate.qty, qualified: true, widened };
  } else if (prev.level2 && prev.level2.qualified) {
    level2 = prev.level2;
  } else {
    const runnerUp = fine.find((g) => g.price !== level3.price);
    level2 = runnerUp
      ? { price: runnerUp.price, qty: runnerUp.qty, qualified: false, widened: false }
      : null;
  }

  const candidate1 = fine.find(
    (g) => g.price !== level3.price && (!level2 || g.price !== level2.price)
  );
  const level1 = candidate1 ? { price: candidate1.price, qty: candidate1.qty, qualified: true } : null;

  return { level1, level2, level3 };
}

// Mid-price tick direction. Deliberately derived from the book's own mid
// rather than a trade feed: none of the four providers subscribe to a trade
// channel, and adding one (Gemini has no WebSocket at all today) would mean
// touching the failover path. So this reports "the mid moved", which is what
// the colour is documented to mean.
export function tickDirection(mid, prevMid) {
  if (mid == null || prevMid == null) return 'flat';
  if (mid > prevMid) return 'up';
  if (mid < prevMid) return 'down';
  return 'flat';
}

// Spread width as a fraction of mid, bucketed for colour. Relative rather
// than absolute so one set of thresholds covers every symbol.
export const SPREAD_TIERS = { tight: 1, widening: 5 }; // basis points

export function spreadTier(spread, mid) {
  if (spread == null || !Number.isFinite(spread) || !mid) return 'unknown';
  const bps = (spread / mid) * 10000;
  if (bps < SPREAD_TIERS.tight) return 'tight';
  if (bps < SPREAD_TIERS.widening) return 'widening';
  return 'wide';
}
