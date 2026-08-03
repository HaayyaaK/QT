import test from 'node:test';
import assert from 'node:assert/strict';
import { isMarketOpen, zonedWeekMinutes, calendarFor, sessionKey } from './marketHours.js';

// All fixtures are written as explicit UTC instants (Z suffix) so the tests
// assert the *conversion*, not the machine's local zone. A test that passed
// only on a machine set to New York would be worthless here.
const at = (iso) => new Date(iso).getTime();

test('zonedWeekMinutes: converts a UTC instant to week-minutes in the target zone', () => {
  // Fri 2026-08-07 20:00 UTC = 16:00 EDT (Fri) = day 5, 16*60 = 960
  assert.equal(zonedWeekMinutes(at('2026-08-07T20:00:00Z'), 'America/New_York'), 5 * 1440 + 960);
  // Same instant in Chicago is 15:00 CDT
  assert.equal(zonedWeekMinutes(at('2026-08-07T20:00:00Z'), 'America/Chicago'), 5 * 1440 + 900);
});

test('zonedWeekMinutes: midnight normalises to 0, not 1440', () => {
  // Mon 2026-08-03 04:00 UTC = Mon 00:00 EDT -> day 1, minute 0
  assert.equal(zonedWeekMinutes(at('2026-08-03T04:00:00Z'), 'America/New_York'), 1 * 1440);
});

test('crypto ignores the calendar entirely — open at a dead weekend hour', () => {
  assert.equal(calendarFor('crypto', 'BTCUSD'), null);
  // Sunday 08:00 UTC, deep in the FX weekend
  assert.equal(isMarketOpen('crypto', 'BTCUSD', at('2026-08-02T08:00:00Z')), true);
  assert.equal(isMarketOpen('crypto', 'ETHUSD', at('2026-08-02T08:00:00Z')), true);
});

test('FX closed across the weekend, open once Sunday 17:00 ET passes', () => {
  // Sunday 2026-08-02 13:19 UTC — the exact window the production dashboard
  // was observed firing FX alerts in. Must be closed.
  assert.equal(isMarketOpen('fx', 'EURUSD', at('2026-08-02T13:19:00Z')), false);
  // Sunday 20:59 UTC = 16:59 EDT, still shut
  assert.equal(isMarketOpen('fx', 'EURUSD', at('2026-08-02T20:59:00Z')), false);
  // Sunday 21:00 UTC = 17:00 EDT, open
  assert.equal(isMarketOpen('fx', 'EURUSD', at('2026-08-02T21:00:00Z')), true);
});

test('FX closes Friday 17:00 ET and stays shut through Saturday', () => {
  // Fri 2026-08-07 20:59 UTC = 16:59 EDT, still trading
  assert.equal(isMarketOpen('fx', 'GBPUSD', at('2026-08-07T20:59:00Z')), true);
  // Fri 21:00 UTC = 17:00 EDT, shut
  assert.equal(isMarketOpen('fx', 'GBPUSD', at('2026-08-07T21:00:00Z')), false);
  // Saturday, thoroughly shut
  assert.equal(isMarketOpen('fx', 'GBPUSD', at('2026-08-08T12:00:00Z')), false);
});

test('FX open through a normal midweek session', () => {
  assert.equal(isMarketOpen('fx', 'USDJPY', at('2026-08-05T12:00:00Z')), true);
  assert.equal(isMarketOpen('fx', 'USDJPY', at('2026-08-05T03:00:00Z')), true);
});

// The DST cases are the whole reason this module defers to Intl. In January
// New York is on EST (UTC-5), so the same 17:00 ET boundary sits at 22:00
// UTC instead of August's 21:00 UTC. A hardcoded offset breaks one of these.
test('FX rollover tracks DST: winter boundary is 22:00 UTC, not 21:00', () => {
  // Sunday 2026-01-11: 21:00 UTC = 16:00 EST — still closed (open in summer)
  assert.equal(isMarketOpen('fx', 'EURUSD', at('2026-01-11T21:00:00Z')), false);
  // 22:00 UTC = 17:00 EST — now open
  assert.equal(isMarketOpen('fx', 'EURUSD', at('2026-01-11T22:00:00Z')), true);
});

test('FX rollover tracks DST: summer boundary is 21:00 UTC', () => {
  // Same clock time in July, when New York is on EDT
  assert.equal(isMarketOpen('fx', 'EURUSD', at('2026-07-12T20:59:00Z')), false);
  assert.equal(isMarketOpen('fx', 'EURUSD', at('2026-07-12T21:00:00Z')), true);
});

test('gold uses the COMEX calendar: Friday 16:00 CT close, an hour before FX', () => {
  // Fri 2026-08-07 20:00 UTC = 15:00 CDT — COMEX still open
  assert.equal(isMarketOpen('fx', 'XAUUSD', at('2026-08-07T20:00:00Z')), true);
  // Fri 21:00 UTC = 16:00 CDT — COMEX shut...
  assert.equal(isMarketOpen('fx', 'XAUUSD', at('2026-08-07T21:00:00Z')), false);
  // ...while spot FX is still trading until 17:00 ET (= 21:00 UTC exactly,
  // so check just before) — confirms the two calendars really differ.
  assert.equal(isMarketOpen('fx', 'EURUSD', at('2026-08-07T20:30:00Z')), true);
});

test('gold observes the daily 16:00-17:00 CT maintenance break midweek', () => {
  // Wed 2026-08-05 21:30 UTC = 16:30 CDT — inside the break
  assert.equal(isMarketOpen('fx', 'XAUUSD', at('2026-08-05T21:30:00Z')), false);
  // 22:00 UTC = 17:00 CDT — session resumes
  assert.equal(isMarketOpen('fx', 'XAUUSD', at('2026-08-05T22:00:00Z')), true);
  // 21:00 UTC = 16:00 CDT — break starts exactly here
  assert.equal(isMarketOpen('fx', 'XAUUSD', at('2026-08-05T21:00:00Z')), false);
  // FX has no such break — same instant, still open
  assert.equal(isMarketOpen('fx', 'EURUSD', at('2026-08-05T21:30:00Z')), true);
});

test('sessionKey: crypto rolls at 00:00 UTC', () => {
  const before = sessionKey('crypto', 'BTCUSD', at('2026-08-05T23:59:00Z'));
  const after = sessionKey('crypto', 'BTCUSD', at('2026-08-06T00:01:00Z'));
  assert.notEqual(before, after, 'a new UTC day is a new session');
  // Stable within the day
  assert.equal(before, sessionKey('crypto', 'BTCUSD', at('2026-08-05T08:00:00Z')));
});

test('sessionKey: FX rolls at 17:00 New York, not at UTC midnight', () => {
  // Wed 20:00 UTC = 16:00 EDT — still Wednesday's session
  const beforeRoll = sessionKey('fx', 'EURUSD', at('2026-08-05T20:00:00Z'));
  // Wed 21:00 UTC = 17:00 EDT — Thursday's session has begun
  const afterRoll = sessionKey('fx', 'EURUSD', at('2026-08-05T21:00:00Z'));
  assert.notEqual(beforeRoll, afterRoll);
  // UTC midnight in between must NOT start a new session
  assert.equal(afterRoll, sessionKey('fx', 'EURUSD', at('2026-08-06T02:00:00Z')));
  // ...and it still matches later that same session, before the next roll
  assert.equal(afterRoll, sessionKey('fx', 'EURUSD', at('2026-08-06T19:00:00Z')));
});

test('sessionKey: FX roll tracks DST like the open does', () => {
  // January: 17:00 EST = 22:00 UTC, so 21:00 UTC is still the prior session
  const before = sessionKey('fx', 'EURUSD', at('2026-01-14T21:00:00Z'));
  const after = sessionKey('fx', 'EURUSD', at('2026-01-14T22:00:00Z'));
  assert.notEqual(before, after);
});

test('sessionKey: gold rolls on Chicago time, distinct from FX', () => {
  // 21:30 UTC = 16:30 CDT (before the 17:00 CT roll) but 17:30 EDT (after
  // the NY roll) — the two calendars must disagree here.
  const ts = at('2026-08-05T21:30:00Z');
  const goldNow = sessionKey('fx', 'XAUUSD', ts);
  const goldAfter = sessionKey('fx', 'XAUUSD', at('2026-08-05T22:30:00Z'));
  assert.notEqual(goldNow, goldAfter, 'gold rolls at 17:00 CT = 22:00 UTC');
  assert.ok(goldNow.startsWith('America/Chicago:'));
  assert.ok(sessionKey('fx', 'EURUSD', ts).startsWith('America/New_York:'));
});

test('sessionKey: month and year boundaries roll cleanly', () => {
  const a = sessionKey('fx', 'EURUSD', at('2026-08-31T21:30:00Z')); // -> Sep 1 session
  assert.ok(a.endsWith('2026-09-01'), `got ${a}`);
  const b = sessionKey('fx', 'EURUSD', at('2026-12-31T22:30:00Z')); // EST -> Jan 1 2027
  assert.ok(b.endsWith('2027-01-01'), `got ${b}`);
});

test('gold has no maintenance break on Sunday evening (session just opened)', () => {
  // Sun 2026-08-02 22:30 UTC = 17:30 CDT, after the 17:00 open
  assert.equal(isMarketOpen('fx', 'XAUUSD', at('2026-08-02T22:30:00Z')), true);
});
