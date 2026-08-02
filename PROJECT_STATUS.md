# Project Status

**Last tested:** 2026-08-02, via Claude Code + Brave (claude-in-chrome extension), production IIS
deployment at `https://fx.hayyaak.com/TradingDashboard.html` (see "Live drift rate" below).
Prior pass: 2026-08-01, local static serve at `http://127.0.0.1:5500/TradingDashboard.html`
(`python -m http.server`).

**Current commit:** `0ab4020` — "Fix crypto failover flapping, double-mount on load, and add
Kraken book checksum validation" (working tree clean at time of writing).

## What was tested this pass

1. **Baseline load** — clean, single Kraken connection, no console errors beyond the expected
   proxy-unreachable warning (proxy wasn't running locally).
2. **Full failover chain** — Kraken → Bitstamp → Gemini → Binance, forced via closing real
   WebSocket connections (not mocked) and, for Gemini, letting a real REST failure occur
   organically. Each transition logged cleanly (`order book failed 3x on X` →
   `Switching from X to Y`), chart and header badge tracked the active provider correctly.
3. **Recovery** — confirmed the health-check correctly walks back toward Kraken when it's
   healthy again.
4. **Symbol switching** — BTC/USD ↔ ETH/USD, both directions, clean in every provider state
   tested.
5. **5-minute passive soak** (no forced faults) — zero new console messages, stable single
   connection, order book tracked real market movement throughout.
6. **Full test suite** — `npm test` → 40/40 passing (22 `taEngine.test.js` + 18
   `cryptoProviders.test.js`, including 3 new checksum tests added this pass).

## Findings from this pass (all now fixed, see commit `0ab4020`)

| # | Finding | Fix | Verified how |
|---|---|---|---|
| 1 | Recovery/failover flapping — a provider could flap back and forth with no cooldown if its REST came back healthy before its WebSocket actually stabilized | 45s cooldown in `switchCryptoProvider`, gating only the backward/recovery direction | Forced a single failover, waited 28s (past one 20s health-check tick, still under the 45s cooldown) — confirmed no premature switch-back, twice |
| 2 | Double WebSocket connection on every page load | Gated `support.js`'s self-fetch/`updateHtml` behind `window.parent !== window` | Two independent fresh reloads, each showed exactly one `Connected to Kraken` / one proxy warning |
| 3 | Crossed order book (negative spread) reproduced on a single, never-interrupted connection | CRC-32 checksum validation against Kraken's real book-channel checksum; reconnects on mismatch | Real organic mismatches caught and cleanly recovered during testing; synthetic wrong-checksum injection also correctly detected; formula validated against live data with a controlled reconnect-based probe (23/23 detected drifts, zero repeat-mismatches after resync — confirms the formula itself, not just drift detection, is correct) |

## Live drift rate — measured on production host (2026-08-02)

Deployed to IIS on the hosting device (`QuantTerminal` site, `fx.hayyaak.com`, proxied through
Cloudflare) and watched the console for `[WARN] Kraken book checksum mismatch` over a
continuous ~14.5-minute window in Brave.

**Result: zero checksum mismatches**, versus the ~1-per-10-15s rate measured on the dev
machine's network path. This strongly suggests the dev-network path itself was the driver of
the drift rate, not something inherent to the delta stream — the checksum mechanism was never
even exercised in this run because the local book stayed in sync the whole time.

Other things re-confirmed during the same session:
- No double-connect on page load (single `Connected to Kraken` at load) — commit `0ab4020`'s
  fix holds on production.
- Order book, depth chart, sentiment/dominance panels, and the TradingView chart all rendered
  and updated continuously throughout with no visible hiccups.
- A `[INFO] Connected to Kraken` line reappeared roughly every ~7 minutes (2 occurrences after
  the initial load, evenly spaced) with no preceding warning or error — reads as an
  intentional periodic resubscribe rather than a fault, since no checksum warning, no visible
  order-book disruption, and no repeated pattern deviation accompanied it. Not yet root-caused
  in the code; worth a deliberate look if it recurs at exactly ~7min in a future longer soak.

## Market-hours gating for the alert stream (2026-08-02)

**Correction to an earlier assessment.** Gating `detectAlerts()` on `source === 'live'`
(commit `17ac3f2`) was reported as fixing the false-FX-signal problem. It does not, and the
reasoning behind it was wrong: it assumed a closed FX market means no live data. In fact the
proxy chain returns genuine last-session candles on a Sunday — verified directly,
`/api/fx/klines?symbol=EURUSD` returns `source: "yahoo"` with 119 real closes — which
`getKlinesForInterval()` then relabels `source: 'live'`. The gate only ever caught the case
where the proxy was entirely unreachable.

Measured on the production dashboard on Sunday 2026-08-02 14:21 UTC (FX shut since Friday),
running the real alert conditions over the real proxy data that the dashboard itself was
receiving:

| Symbol | Proxy source | Would have fired |
|---|---|---|
| USD/JPY | yahoo | RSI oversold |
| NZD/USD | yahoo | MACD bearish crossover |
| USD/CAD | yahoo | MACD bearish crossover |
| EUR/USD, GBP/USD, AUD/USD, USD/CHF | yahoo | — |
| XAU/USD | twelvedata | — |

Three signals on a closed market, all from real data. That is the bug the original report
described, and `source === 'live'` would not have stopped any of them.

Fixed by adding `marketHours.js` — session calendars consulted at the top of `detectAlerts()`:

- **Crypto** — no calendar; 24/7 on all four providers in the failover chain. Exchange
  maintenance is handled by provider failover, not by a schedule.
- **FX majors** — Sunday 17:00 to Friday 17:00 *America/New_York*.
- **XAU/USD** — COMEX: Sunday 17:00 to Friday 16:00 *America/Chicago*, plus the daily
  16:00–17:00 CT maintenance break Mon–Thu.

DST is delegated to `Intl.DateTimeFormat` with IANA zone names rather than UTC-offset
arithmetic, because the FX rollover is 21:00 UTC in summer and 22:00 UTC in winter — any
hardcoded offset is wrong for half the year. `marketHours.test.js` asserts both boundaries
explicitly (11 tests).

After the fix, the same production dashboard shows `0 SIGNALS` in the same window.

## Open items

- **Failover chain not yet validated on production.** Kraken → Bitstamp → Gemini → Binance and
  the 45s recovery cooldown were verified on the dev machine (commit `0ab4020`) but never
  forced on the hosting device. `DEPLOYMENT.md` lists this as worth re-confirming.
- **Longer soak (60+ min)** to confirm whether checksum mismatches are genuinely near-zero in
  production or just rare, and whether the ~7-minute Kraken reconnect is periodic. Traced as
  far as: no client-side reconnect timer exists in `cryptoProviders.js` or
  `TradingDashboard.html`, so it originates server-side (Kraken idle timeout) or at an
  intermediate hop. Recovery is clean either way.
- **Backlog: holiday calendars.** `marketHours.js` handles weekly sessions and DST but not Good
  Friday, Christmas, or other market holidays — alerts can still fire on those days, and the
  data-source indicator will read "● LIVE DATA" rather than "◐ LAST CLOSE". Deliberately out of
  scope for this release (weekly gating removes the large majority of the noise); documented
  user-facing in README "Known limitations" #7. Remaining work is fixed-date plus
  Easter-relative holiday tables per venue.
- **Watch post-deploy: `alertFlags` across a session boundary.** The gate returns early without
  writing `alertFlags`, so flags stay frozen at the last open-market evaluation. Analysis says
  this is correct — alert conditions are pure functions of the candle array, which does not
  change while the venue is shut, so there is no state to drift. The first evaluation after
  reopen therefore compares Monday's conditions against Friday's flags, which is exactly the
  intended "has this changed since we last really looked?" semantics. Worth confirming against a
  real weekend boundary anyway.
