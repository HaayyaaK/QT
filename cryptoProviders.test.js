// Run with: node --test
// Covers the provider registry's structural integrity (the kind of bug
// that's easy to introduce when adding/editing a provider — a missing
// symbol mapping fails silently at runtime otherwise) and the failover
// algorithm itself, independent of the browser/Component/React
// environment the real fetchKlines/connectBook implementations need.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, providerById, attemptWithFailover } from './cryptoProviders.js';

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
