# Quant/Terminal Dashboard

A single-file, client-only crypto/FX trading terminal: live order book, technical
indicators, multi-timeframe trend, correlation matrix, alert stream, and embedded
TradingView widgets. No backend — every data source is called directly from the
browser.

## Running locally

Open `TradingDashboard.html` directly, or (recommended, avoids some browsers'
extra restrictions on `file://` origins for fetch/WebSocket) serve it with any
static file server, e.g.:

```
npx serve .
# or the VS Code "Live Server" extension
```

## Files

- `TradingDashboard.html` — markup template + the app's `Component` class (state,
  data fetching, alert detection, rendering).
- `taEngine.js` — dependency-free technical-analysis math (SMA/EMA/RSI/MACD/
  Bollinger/ATR/ADX/Stochastic/VWAP/Donchian/Pearson correlation + a deterministic
  simulated-kline fallback).
- `support.js` — **generated, vendored runtime** ("GENERATED from
  dc-runtime/src/*.ts — do not edit. Rebuild with `bun run build`"). Compiles the
  `{{ }}` / `sc-if` / `sc-for` template syntax in `TradingDashboard.html` to React,
  and evaluates the `Component` class via `new Function(...)`. Its source
  (`dc-runtime/`) isn't part of this repository — treat it as a third-party
  dependency, not application code. It loads React 18.3.1, ReactDOM 18.3.1, and
  Babel Standalone 7.29.0 from `unpkg.com` with pinned versions and SRI hashes
  (see `support.js` around `REACT_URL`/`REACT_SRI`) — that pattern is worth
  reusing for anything else pulled from a CDN.

## Tracked symbols

BTC/USD, ETH/USD (Binance, live REST + WS order book), EUR/USD, GBP/USD,
USD/JPY, AUD/USD, NZD/USD, USD/CAD, USD/CHF, XAU/USD (Yahoo Finance chart API,
see limitation below).

## Known limitations

- **FX/metal symbols run on simulated data.** `query1.finance.yahoo.com` does
  not send CORS headers for browser origins — confirmed against a live
  `localhost` origin, the request is blocked before any response body is read.
  `getKlinesForInterval()` catches this and falls back to
  `taEngine.simulateKlines()` (a deterministic random walk), which is why all 8
  FX/metal symbols normally show a **"SIMULATED DATA"** banner and an amber
  "○ SIMULATED" chip in the Indicator Snapshot panel. A real fix needs either a
  server-side proxy for the Yahoo endpoint or a CORS-friendly paid FX data
  vendor — both are infrastructure decisions outside what a static HTML file
  can do on its own, and are not implemented here on purpose (routing through
  a public third-party CORS proxy would trade one trust problem for another).
- **Benign console warnings on load.** The page briefly shows raw
  `{{ depthBidPath }}` / `{{ depthAskPath }}` text as an SVG `d` attribute
  before the runtime hydrates, which the browser's native SVG parser logs as
  an "Expected moveto path command" error. This is inherent to the template
  runtime's pre-hydration paint (every interpolated attribute does this; the
  SVG `path` `d` attribute is just the one the browser's parser validates and
  logs a warning for) and resolves itself within milliseconds — it is not a
  functional bug.
- **No server-side caching.** Every visitor's browser independently polls
  Binance, CoinGecko, and alternative.me. CoinGecko's free tier rate-limits
  fairly aggressively; a real spike in concurrent users could degrade the
  sentiment panel for everyone in that window. Fine for personal/low-traffic
  use; revisit with an edge cache if usage grows.
- **No API keys anywhere.** Keep it that way unless a server-side proxy exists
  first — this is a client-only app, so anything embedded here is visible to
  every visitor.

## Content-Security-Policy

`TradingDashboard.html` sets a CSP meta tag scoped to the exact origins this
app talks to. Notes on the less-obvious entries (each confirmed against a
real Brave/Chromium console, not assumed):

- `'unsafe-eval'` (script-src) — required by `support.js`'s `evalDcLogic()`,
  which runs the `Component` class via `new Function(...)`; that's how the
  vendored template runtime works, not something this file can avoid without
  replacing the runtime.
- `'unsafe-inline'` (script-src) — required because TradingView's widget
  loader scripts (loaded from the allowlisted `s3.tradingview.com`)
  dynamically inject their own inline bootstrap `<script>` tags with no
  `src`; without this, all four TradingView widgets fail to render. Since
  `'unsafe-eval'` already concedes arbitrary code execution for this app,
  this doesn't meaningfully lower the bar further.
- `'unsafe-inline'` (style-src) — panel styling is authored as inline
  `style="..."` attributes throughout the template (extracting those to a
  stylesheet is tracked as deferred work below).
- `wss://stream.binance.com:9443` (connect-src) — the port must be listed
  explicitly. A CSP source with no port only matches the scheme's *default*
  port (443 for wss); Binance's public stream runs on 9443, a non-default
  port, so omitting it silently blocks the WebSocket.
- `tradingview-widget.com` / `*.tradingview-widget.com` (frame-src) —
  TradingView serves the actual iframe content from this separate domain,
  not a subdomain of `tradingview.com`, so the `*.tradingview.com` wildcard
  does not cover it.

If you add a new external script/API/embed, add its origin to the CSP or it
will be silently blocked. **Test any CSP change in a real browser with
DevTools open before treating it as done** — this project shipped an
enforcing CSP once without that step and it broke every TradingView widget
plus the live order book (wrong WS port, missing frame-src origin, missing
`'unsafe-inline'` in script-src). Prefer rolling out a new/changed CSP as
`Content-Security-Policy-Report-Only` first if you can.

## Testing

```
npm test
```

Runs `taEngine.test.js` via Node's built-in test runner (`node --test`, no
external dependencies) — covers SMA/EMA/RSI/MACD/Bollinger/Wilder-smoothing/
ATR/ADX/Donchian/Pearson/trend-label/simulateKlines against a fixed OHLCV
fixture.

## Status

This repo went through an audit-and-fix pass (2026-07-31) that closed all
Critical/High/Medium findings:

- Added a CSP; fixed a `script.innerHTML` → `textContent` DOM-injection idiom.
- Disclosed simulated-FX-data honestly instead of showing it as "live" (see
  limitation above).
- Fixed ATR/ADX to use Wilder smoothing instead of standard EMA (previously
  disagreed with the embedded TradingView chart's own ATR/ADX).
- Fixed a race condition where switching symbols quickly could apply the
  previous symbol's multi-timeframe data under the new symbol's label.
- Wired up a real "offline" WebSocket state (previously retried forever with
  no way to tell the user the connection was actually dead) plus a manual
  Reconnect control.
- Parallelized the per-symbol/per-timeframe kline fetches.
- Memoized `renderVals()`'s derived panels so the 1-second clock tick no
  longer forces a full recompute of every panel.
- Converted every clickable `<div>` (symbol chips, heatmap tabs, widget retry
  buttons) to real `<button>` elements — keyboard-operable, with a visible
  focus ring.
- Added landmark elements (`<header>`/`<main>`), a page `<h1>`, heading-level
  panel titles, `aria-label`s on the sentiment gauge and depth-chart SVG, and
  ARIA table roles (`role="table"/"row"/"columnheader"/"rowheader"/"cell"`)
  on the correlation matrix grid.
- Added this README, `package.json`, and a `taEngine.js` test suite.

A follow-up pass (same day) fixed a first-try CSP that was shipped enforcing
instead of report-only and broke, live: all four TradingView widgets (wrong
`frame-src` origin), the WebSocket order book/depth chart (wrong `connect-src`
port), and the correlation matrix (a `<table>` rewrite that didn't survive
contact with the runtime — reverted to the div/ARIA-role version above). See
the Content-Security-Policy section for the specifics. Also set the
correlation-matrix and sector-heatmap cards to an even 50/50 split instead of
the matrix spanning 2 columns.

**Deferred to next phase (Low severity, not yet addressed):**

1. ETH dominance bar width is hardcoded to 2× its labeled value, purely for
   visual comparison against the BTC bar — should scale both against a shared
   maximum instead.
2. `TradingDashboard.html` mixes markup, ~90 inline `style=""` strings, and
   the `Component` class in one file — fine for a single-file artifact deploy,
   worth extracting if this stops being one.
3. `macd()`/`stochastic()` zero-pad `null` values before smoothing, causing a
   few bars of warm-up distortion right at the boundary where real values
   start (low impact — confined to bars typically off-screen).
4. Symbol list, refresh intervals, and alert thresholds (RSI 70/30, volume
   3× 20-SMA, ATR 2× 14/20-avg) are hardcoded inline in the `Component`
   class — fine for now, extract to a config object if they need to become
   user-tunable.
5. No URL-persisted state — selected symbol and heatmap tab reset on reload.
6. Google Fonts / TradingView embed scripts have no Subresource Integrity
   (Google Fonts genuinely can't — it's per-UA-negotiated; TradingView's
   embed scripts could, in principle, but they're versioned by TradingView,
   not pinned by us).
