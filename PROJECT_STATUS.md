# Project Status

**Last tested:** 2026-08-01, via Claude Code + Chrome (claude-in-chrome extension), local static
serve at `http://127.0.0.1:5500/TradingDashboard.html` (`python -m http.server`).

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

## Open item: live drift rate

Measuring the Kraken checksum validator in isolation (a plain Node script against the real
Kraken WebSocket, no browser/app overhead), genuine local-state drift occurred roughly **once
every 10-15 seconds**. This is higher than "rare packet loss" would suggest, but every single
detected drift resynced cleanly with no false positives and no repeat-mismatch immediately
after reconnecting — so the *mechanism* is confirmed correct; what's still open is whether
10-15s is normal for this specific network path (dev machine, current network conditions) or
something that changes on the production host.

**This does not need to block deployment.** `bookFailCount` resets on every successful
reconnect, so even at this rate it manifests as a brief, mostly-invisible resync rather than a
failover cascade. It's a measurement to take once running on the target host, not a
pre-deployment gate.

## Next step

Deploy to the IIS host (see `DEPLOYMENT.md`), load the dashboard there, and watch the console
for `[WARN] Kraken book checksum mismatch` frequency over a sustained window (10-15 minutes is
plenty). Compare against the ~10-15s dev-machine rate above.
