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

// Minimum grouped quantity for a bucket to count as a real second wall —
// half the CURRENT book's own average bucket size, not a fixed ratio of
// level3. Scales automatically per asset and per moment (a BTC book's
// average bucket is in BTC, an FX book's in lot notional) with no
// per-symbol table, and — unlike gauging against level3 specifically —
// stays meaningful when level3 is an outlier: a single dominant wall
// (level3 = 10, everything else ~0.5-0.8) pulls the average up just enough
// to keep excluding genuine dust, which was the actual production symptom
// this replaces (see computePivots' history note above the resolution
// order). Recomputed fresh on every call — there is deliberately no
// persisted "threshold" state, only the persisted price/qty levels it picks.
export function dynamicFloor(groups) {
  const qtys = (groups || []).map((g) => g.qty);
  if (!qtys.length) return 0;
  const avg = qtys.reduce((s, v) => s + v, 0) / qtys.length;
  return avg * 0.5;
}

// Finds the largest remaining bucket clearing `minQty` — a floor test: big
// enough to matter, not "small enough to look different from level3" (an
// earlier version of this function tried a gap-based test per an initial,
// more literal reading of the spec; verified against production data it let
// dust-sized buckets — 8% of level3's size — qualify as confident walls,
// since a *bigger* size difference passed the gap more easily. A floor
// answers the actual question, "is this a meaningful wall", not "is this
// sufficiently smaller than level3"). `groups` is already sorted
// qty-descending (groupLevels' contract), so the first match is the
// largest qualifying candidate.
function bestAboveFloor(groups, excludePrice, minQty) {
  return groups.find((g) => g.price !== excludePrice && g.qty >= minQty) || null;
}

// Apply the three persistence rules to one side of the book.
//
//   level3 — the strongest wall seen this session. Frozen: only replaced when
//            a new grouped quantity *reaches or exceeds* it. A weaker book
//            leaves it untouched, so it can point at a price whose liquidity
//            has since been consumed. That is the specified behaviour.
//   level2 — the next wall that is *actually significant*, not level3's
//            direct neighbour by rank — see the resolution order below.
//   level1 — fully dynamic: the largest remaining bucket, recomputed every
//            update, excluding whatever level2/level3 already occupy.
//
// level2 resolution, in order — the first three preserve the original
// structure exactly; only the qualifying test (now a dynamic floor instead
// of a fixed 50%-of-level3 ratio) and the fourth step are new:
//
//   1. A bucket at the normal granularity whose quantity clears
//      dynamicFloor(fine) — half the CURRENT book's own average bucket
//      size. This replaces an earlier fixed "50% of level3" ratio, which
//      used the same cutoff regardless of the book's actual shape: half of
//      level3 might be enormous on a deep BTC book and meaningless on a
//      thin one. A floor derived from the book's own average scales
//      automatically to whatever units and depth it's quoted in, without a
//      per-symbol table. (An earlier attempt at this used a *gap* test —
//      candidate must be smaller than level3 by some dynamic amount —
//      taken from a more literal reading of the original spec. Verified
//      against production data, that let dust-sized buckets, 8% of level3's
//      size, qualify as confident walls, since a bigger size difference
//      passed the gap more easily — the opposite of "significant". A floor
//      answers the actual question.)
//   2. Failing that, re-group into wider price windows and look again,
//      against a floor recomputed from THAT coarser distribution — not the
//      fine pass's floor. Aggregating raises bucket quantities, so judging
//      the coarse attempt by its own average (which rises too) keeps the
//      bar consistent instead of making the retry trivially easier. A thin
//      book often has its second wall spread across neighbouring ticks that
//      only clear the floor once aggregated, so this finds real walls the
//      fine pass splits apart rather than inventing one.
//   3. Failing that, retain a previously *qualified* level2 — UNLESS price
//      has since crossed it (see isStale below), in which case treat it the
//      same as having no retained value at all and fall through to step 4.
//      A genuine, still-relevant wall is never downgraded by a quiet moment;
//      a wall the market has since traded through is not "quiet", it's gone.
//   4. Failing that, surface the strongest remaining bucket flagged
//      `qualified: false`, so the row shows the runner-up and says it is
//      below the floor instead of rendering an unexplained blank.
//
// Only a book with a single bucket — nothing to be runner-up — yields null,
// which the card renders as an explicit "no second wall" state.
//
// Unlike level3, level2 does NOT get a "frozen forever, tagged breached"
// treatment when stale — that permanence is level3's entire point (the
// session high-water mark) and is deliberately not extended here. Found via
// live observation: a bid-side level2 sat at a fixed price 24-32 points
// above a falling mid — on the ask side of the market — for a sustained
// window, still rendered with full "qualified" confidence, because nothing
// ever re-evaluated whether a *retained* value was still plausible.
//
// `prev` is the same shape this returns, so callers just feed the last result
// back in. Pure — the caller owns when to reset (see the pivot key in the
// dashboard's book flush). `opts.mid` and `opts.side` ('asks'|'bids') are
// optional: omitting either just disables the staleness check (matches the
// pre-existing behaviour), so old call sites that don't pass them keep
// working.
export function computePivots(levels, prev = {}, opts = {}) {
  const { mid, side } = opts;
  // Same test the card's breach-tagging uses: has the mid moved past this
  // level, i.e. is it no longer on its own side of the market. With no mid
  // or no side supplied, nothing is ever considered stale.
  const isStale = (lvl) => {
    if (mid == null || !side || !lvl) return false;
    return side === 'asks' ? mid > lvl.price : mid < lvl.price;
  };
  const retainedLevel2 = prev.level2 && prev.level2.qualified && !isStale(prev.level2) ? prev.level2 : null;

  const fine = groupLevels(levels, opts.bucketCount || DEFAULT_BUCKETS);
  if (!fine.length) return { level1: null, level2: retainedLevel2, level3: prev.level3 || null };

  const strongest = fine[0];
  let level3 = prev.level3 || null;
  if (!level3 || strongest.qty >= level3.qty) level3 = { price: strongest.price, qty: strongest.qty };

  // Recomputed fresh every call — no persisted "threshold" state, only the
  // persisted price/qty picks it's used to make. Computed separately per
  // granularity rather than reusing the fine value for the coarse retry, so
  // the coarse pass is judged against its own (also-risen) average — see
  // step 2 above.
  const floor = dynamicFloor(fine);

  let candidate = bestAboveFloor(fine, level3.price, floor);
  let widened = false;
  let usedFloor = floor;
  if (!candidate) {
    const coarse = groupLevels(levels, opts.coarseBucketCount || COARSE_BUCKETS);
    const coarseFloor = dynamicFloor(coarse);
    candidate = bestAboveFloor(coarse, level3.price, coarseFloor);
    widened = !!candidate;
    if (widened) usedFloor = coarseFloor;
  }

  let level2;
  if (candidate) {
    level2 = { price: candidate.price, qty: candidate.qty, qualified: true, widened, floor: usedFloor };
  } else if (retainedLevel2) {
    level2 = retainedLevel2;
  } else {
    const runnerUp = fine.find((g) => g.price !== level3.price);
    level2 = runnerUp
      ? { price: runnerUp.price, qty: runnerUp.qty, qualified: false, widened: false, floor }
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
