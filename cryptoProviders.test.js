// Run with: node --test
// Covers the provider registry's structural integrity (the kind of bug
// that's easy to introduce when adding/editing a provider — a missing
// symbol mapping fails silently at runtime otherwise) and the failover
// algorithm itself, independent of the browser/Component/React
// environment the real fetchKlines/connectBook implementations need.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, providerById, attemptWithFailover, applyKrakenLevels, topLevels } from './cryptoProviders.js';

test('PROVIDERS: priority order is Kraken -> Bitstamp -> Gemini -> Binance', () => {
  assert.deepEqual(PROVIDERS.map((p) => p.id), ['kraken', 'bitstamp', 'gemini', 'binance']);
});

test('PROVIDERS: every provider has klinesSymbol + bookSymbol mappings for both BTCUSD and ETHUSD', () => {
  for (const p of PROVIDERS) {
    for (const symbolId of ['BTCUSD', 'ETHUSD']) {
      assert.ok(p.klinesSymbol[symbolId], `${p.id} missing klinesSymbol.${symbolId}`);
      assert.ok(p.bookSymbol[symbolId], `${p.id} missing bookSymbol.${symbolId}`);
    }
  }
});

test('PROVIDERS: every provider exposes fetchKlines and connectBook as functions', () => {
  for (const p of PROVIDERS) {
    assert.equal(typeof p.fetchKlines, 'function', `${p.id}.fetchKlines`);
    assert.equal(typeof p.connectBook, 'function', `${p.id}.connectBook`);
    assert.equal(typeof p.label, 'string', `${p.id}.label`);
  }
});

test('providerById: finds by id, returns undefined for an unknown id', () => {
  assert.equal(providerById('kraken').label, 'Kraken');
  assert.equal(providerById('binance').label, 'Binance');
  assert.equal(providerById('does-not-exist'), undefined);
});

test('attemptWithFailover: returns the active provider immediately when it succeeds', async () => {
  const seen = [];
  const outcome = await attemptWithFailover(PROVIDERS, 'kraken', async (p) => {
    seen.push(p.id);
    return 'kraken-data';
  });
  assert.deepEqual(seen, ['kraken']);
  assert.equal(outcome.provider.id, 'kraken');
  assert.equal(outcome.result, 'kraken-data');
});

test('attemptWithFailover: walks forward through failures and returns the first success', async () => {
  const seen = [];
  const outcome = await attemptWithFailover(PROVIDERS, 'kraken', async (p) => {
    seen.push(p.id);
    if (p.id === 'kraken' || p.id === 'bitstamp') throw new Error(`${p.id} down`);
    return `${p.id}-data`;
  });
  assert.deepEqual(seen, ['kraken', 'bitstamp', 'gemini']);
  assert.equal(outcome.provider.id, 'gemini');
});

test('attemptWithFailover: starts from the given active id, never wraps back to a higher-priority one already passed', async () => {
  // Starting from 'gemini' (already failed over past kraken/bitstamp
  // earlier) must never re-try kraken/bitstamp within this call — that's
  // the recovery health-check's job, on its own schedule, not something
  // every single failed request should attempt.
  const seen = [];
  await attemptWithFailover(PROVIDERS, 'gemini', async (p) => {
    seen.push(p.id);
    throw new Error('down');
  });
  assert.deepEqual(seen, ['gemini', 'binance']);
});

test('attemptWithFailover: returns null when every remaining provider fails (final fallback is the caller\'s job)', async () => {
  const outcome = await attemptWithFailover(PROVIDERS, 'kraken', async () => {
    throw new Error('down');
  });
  assert.equal(outcome, null);
});

test('attemptWithFailover: calls onProviderFailed for each failure, not for the eventual success', async () => {
  const failed = [];
  await attemptWithFailover(
    PROVIDERS,
    'kraken',
    async (p) => {
      if (p.id !== 'binance') throw new Error(`${p.id} down`);
      return 'ok';
    },
    (p, e) => failed.push({ id: p.id, message: e.message })
  );
  assert.deepEqual(failed.map((f) => f.id), ['kraken', 'bitstamp', 'gemini']);
  assert.ok(failed.every((f) => f.message.includes('down')));
});

test('attemptWithFailover: an unknown startId falls back to trying from the top of the list', async () => {
  const seen = [];
  const outcome = await attemptWithFailover(PROVIDERS, 'not-a-real-provider', async (p) => {
    seen.push(p.id);
    return 'ok';
  });
  assert.deepEqual(seen, ['kraken']);
  assert.equal(outcome.provider.id, 'kraken');
});

// applyKrakenLevels / topLevels: regression coverage for a real bug found
// via live browser testing — an earlier version tried to keep Kraken's
// book fresh by re-subscribing every ~3s instead of merging deltas, which
// silently froze the book after the first message (Kraken rejects a
// duplicate subscribe rather than sending a new snapshot). These two
// functions are the fix: local order-book state, updated incrementally.

test('applyKrakenLevels: upserts a price level', () => {
  const map = new Map([[100, 1]]);
  applyKrakenLevels(map, [{ price: 100, qty: 2 }, { price: 101, qty: 0.5 }]);
  assert.deepEqual([...map.entries()].sort(), [[100, 2], [101, 0.5]]);
});

test('applyKrakenLevels: qty 0 removes the price level', () => {
  const map = new Map([[100, 1], [101, 2]]);
  applyKrakenLevels(map, [{ price: 100, qty: 0 }]);
  assert.deepEqual([...map.entries()], [[101, 2]]);
});

test('applyKrakenLevels: a snapshot followed by updates changes the book — this is the actual regression', () => {
  // Mirrors what connectBook does: seed from a snapshot, then apply two
  // rounds of deltas. If this ever regresses to snapshot-only handling,
  // the book after round 2 would equal the book after round 1 — frozen.
  let bidMap = new Map([[100, 1], [99, 2]]);
  applyKrakenLevels(bidMap, [{ price: 100, qty: 1.5 }]); // round 1: price move
  const afterRound1 = topLevels(bidMap, 'bids');
  applyKrakenLevels(bidMap, [{ price: 99, qty: 0 }, { price: 98, qty: 3 }]); // round 2: level removed + added
  const afterRound2 = topLevels(bidMap, 'bids');
  assert.notDeepEqual(afterRound1, afterRound2, 'book must actually change between update rounds, not freeze');
  assert.deepEqual(afterRound2, [[100, 1.5], [98, 3]]);
});

test('topLevels: bids sort descending (best/highest first), asks ascending (best/lowest first)', () => {
  const map = new Map([[100, 1], [102, 1], [101, 1]]);
  assert.deepEqual(topLevels(map, 'bids').map((l) => l[0]), [102, 101, 100]);
  assert.deepEqual(topLevels(map, 'asks').map((l) => l[0]), [100, 101, 102]);
});

test('topLevels: slices to n', () => {
  const map = new Map(Array.from({ length: 20 }, (_, i) => [i, 1]));
  assert.equal(topLevels(map, 'bids', 5).length, 5);
  assert.equal(topLevels(map, 'bids').length, 10); // default n
});
