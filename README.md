# Quant/Terminal Dashboard

A single-file, client-only crypto/FX trading terminal: live order book, technical
indicators, multi-timeframe trend, correlation matrix, alert stream, macro/news
snapshots, and embedded TradingView widgets.

Crypto sources are called directly from the browser (all free, keyless, CORS-open).
FX/metals, market news, and macro data go through a small local proxy — see
[Data sources](#data-sources) below for why.

## Running locally

1. **Start the proxy** (required for FX klines, market news, and the macro
   snapshot — crypto and the TradingView widgets work without it):
   ```
   cd C:\proxy-server
   copy .env.example .env
   REM edit .env, fill in whichever API keys you have — see its README.md
   npm start
   ```
2. **Open the dashboard.** Either open `TradingDashboard.html` directly, or
   (recommended — avoids some browsers' extra restrictions on `file://`
   origins for fetch/WebSocket) serve it with any static file server:
   ```
   npx serve .
   # or the VS Code "Live Server" extension
   ```

If the proxy isn't running, the dashboard still works — FX symbols fall back
to simulated data (clearly disclosed, see Known limitations) and the macro/news
panels show a "not running" state with a Retry button, instead of failing silently.

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
- **`C:\proxy-server`** (separate project, *not* inside this repo — see below)
  — local API proxy holding third-party keys server-side.

## Tracked symbols

BTC/USD, ETH/USD, EUR/USD, GBP/USD, USD/JPY, AUD/USD, NZD/USD, USD/CAD,
USD/CHF, XAU/USD.

## Data sources

| Asset class | Primary | Fallback chain | Where it runs |
|---|---|---|---|
| Crypto (BTC, ETH) | Binance public klines + WS depth | Kraken public OHLC → Coinbase Exchange public candles | Browser, direct (all free/keyless/CORS-open) |
| FX majors & XAU | Yahoo Finance chart API | TwelveData → Alpha Vantage | **Proxy** (`/api/fx/klines`) — Yahoo has no CORS, TwelveData/Alpha Vantage need a key |
| Market news | NewsAPI.org | — | **Proxy** (`/api/news`) — needs a key |
| Macro / Fed data | FRED (Federal Reserve Economic Data) | — | **Proxy** (`/api/fred/snapshot`, `/api/fred/series`) — needs a key |
| Fear & Greed, BTC/ETH dominance | alternative.me, CoinGecko | — | Browser, direct (free/keyless/CORS-open) |

Any source in a fallback chain that fails moves to the next one silently; if
every source in a chain fails, the affected symbol/panel falls back to
simulated data (klines) or an explicit "not available" state (news/macro) —
never a broken or blank card with no explanation.

### Why FX/news/macro need a proxy and crypto doesn't

Crypto's three sources are all free, keyless, and send
`Access-Control-Allow-Origin` — a browser can call them directly, nothing to
proxy. FX/news/macro don't have that luxury: Yahoo Finance's chart API sends
no CORS headers at all (confirmed live — the browser blocks the response
before any body is read, no matter what), and TwelveData/Alpha
Vantage/NewsAPI/FRED all require an API key, which can never be embedded in
client-side JS without exposing it to every visitor. `C:\proxy-server` (see
its own README.md there) is a small, zero-dependency Node server that holds
those keys in a `.env` file and makes the actual third-party calls
server-side, where CORS doesn't apply and the key never leaves the machine
running the proxy. It lives in its own directory, entirely outside this
repo, specifically so a key can never accidentally end up in a file this
project might publish or share.

## Known limitations

- **FX falls back to simulated data if the proxy isn't running**, or if
  Yahoo/TwelveData/Alpha Vantage all fail for a given symbol. This is now
  the exception rather than the rule (previously guaranteed, since the
  browser-direct Yahoo call was always CORS-blocked) — start the proxy to
  get real FX data. Still disclosed via the **"SIMULATED DATA"** banner and
  the dataSource chip either way.
- **Macro Snapshot / Market News panels need the proxy plus real API keys**
  in its `.env` (`FRED_API_KEYS`, `NEWSAPI_API_KEYS`). Without them, each
  panel shows its own "not running" / "not configured" state with a Retry
  button — never a silent blank.
- **Benign console warnings on load.** The page briefly shows raw
  `{{ depthBidPath }}` / `{{ depthAskPath }}` text as an SVG `d` attribute
  before the runtime hydrates, which the browser's native SVG parser logs as
  an "Expected moveto path command" error. This is inherent to the template
  runtime's pre-hydration paint and resolves itself within milliseconds — it
  is not a functional bug.
- **No server-side caching in front of the free keyless APIs** (Binance,
  Kraken, Coinbase, CoinGecko, alternative.me) — every visitor's browser
  polls them independently. CoinGecko's free tier rate-limits fairly
  aggressively; a real spike in concurrent users could degrade the
  sentiment panel for everyone in that window. Fine for personal/low-traffic
  use; revisit with an edge cache if usage grows. (The keyed sources behind
  the proxy don't have this problem in the same way — see the proxy's own
  README for its rate-limiting notes.)

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
- `http://127.0.0.1:8787` / `http://localhost:8787` (connect-src) — the
  proxy's default address. `query1.finance.yahoo.com` is deliberately **not**
  listed here: the browser no longer calls it directly (see Data sources).
- `api.kraken.com` / `api.exchange.coinbase.com` (connect-src) — the crypto
  fallback chain.

If you add a new external script/API/embed, add its origin to the CSP or it
will be silently blocked. **Test any CSP change in a real browser with
DevTools open before treating it as done** — this project shipped an
enforcing CSP once without that step and it broke every TradingView widget
plus the live order book (wrong WS port, missing frame-src origin, missing
`'unsafe-inline'` in script-src). Prefer rolling out a new/changed CSP as
`Content-Security-Policy-Report-Only` first if you can.

If you run the proxy on a different host/port, update both the
`PROXY_BASE_URL` resolution in `TradingDashboard.html`'s constructor (or
pass `?proxy=http://host:port` in the URL — no file edit needed) **and**
this CSP's `connect-src`, or the browser will silently block the calls.

## Testing

```
npm test
```

Runs `taEngine.test.js` via Node's built-in test runner (`node --test`, no
external dependencies) — covers SMA/EMA/RSI/MACD/Bollinger/Wilder-smoothing/
ATR/ADX/Donchian/Pearson/trend-label/simulateKlines against a fixed OHLCV
fixture. The proxy has its own separate test suite — see its README.

## Status

This repo went through an audit-and-fix pass (2026-07-31) that closed all
Critical/High/Medium findings, a follow-up pass the same day that fixed a
first-try CSP shipped enforcing instead of report-only (broke all four
TradingView widgets, the WS order book, and a `<table>` rewrite of the
correlation matrix — all fixed, see git history for specifics), and a third
pass (same day) that:

- Added the local proxy (`C:\proxy-server`) and wired FX klines through it
  (Yahoo → TwelveData → Alpha Vantage), fixing the FX-CORS limitation at its
  root instead of only disclosing it.
- Added Kraken and Coinbase as client-side crypto fallbacks behind Binance.
- Added the **Macro Snapshot** (FRED) and **Market News** (NewsAPI) panels.
- Gave the correlation-matrix card a fixed height with sticky row/column
  headers, matching the sector-heatmap card beside it instead of growing
  unbounded to fit all 10 rows.

**Deferred to next phase (Low severity, not yet addressed):**

1. ETH dominance bar width is hardcoded to 2× its labeled value, purely for
   visual comparison against the BTC bar — should scale both against a shared
   maximum instead.
2. `TradingDashboard.html` mixes markup, inline `style=""` strings, and the
   `Component` class in one file — fine for a single-file artifact deploy,
   worth extracting if this stops being one.
3. `macd()`/`stochastic()` zero-pad `null` values before smoothing, causing a
   few bars of warm-up distortion right at the boundary where real values
   start (low impact — confined to bars typically off-screen).
4. Symbol list, refresh intervals, and alert thresholds (RSI 70/30, volume
   3× 20-SMA, ATR 2× 14/20-avg) are hardcoded inline in the `Component`
   class — fine for now, extract to a config object if they need to become
   user-tunable.
5. No URL-persisted state beyond `?proxy=` — selected symbol and heatmap tab
   reset on reload.
6. Google Fonts / TradingView embed scripts have no Subresource Integrity
   (Google Fonts genuinely can't — it's per-UA-negotiated; TradingView's
   embed scripts could, in principle, but they're versioned by TradingView,
   not pinned by us).
