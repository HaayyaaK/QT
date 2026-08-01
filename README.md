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
- `cryptoProviders.js` — the crypto exchange provider registry (Kraken/
  Bitstamp/Gemini/Binance klines + order-book connectors) and the
  `attemptWithFailover` algorithm the Component uses to walk through them.
  See "Crypto: multi-exchange failover" below.
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

| Asset class | Priority order | Where it runs |
|---|---|---|
| Crypto (BTC/USD, ETH/USD) | **Kraken → Bitstamp → Gemini → Binance** (automatic failover + recovery) | Browser, direct (all four free/keyless/CORS-open) |
| FX majors & XAU | Yahoo Finance chart API → TwelveData → Alpha Vantage | **Proxy** (`/api/fx/klines`) — Yahoo has no CORS, TwelveData/Alpha Vantage need a key |
| Market news | NewsAPI.org | **Proxy** (`/api/news`) — needs a key |
| Macro / Fed data | FRED (Federal Reserve Economic Data) | **Proxy** (`/api/fred/snapshot`, `/api/fred/series`) — needs a key |
| Fear & Greed, BTC/ETH dominance | alternative.me, CoinGecko | Browser, direct (free/keyless/CORS-open) |

Any source in a fallback chain that fails moves to the next one; if every
source in a chain fails, the affected symbol/panel falls back to simulated
data (klines) or an explicit "not available" state (news/macro) — never a
broken or blank card with no explanation.

### Crypto: multi-exchange failover with automatic recovery

`cryptoProviders.js` is a self-contained provider registry — one entry per
exchange (REST klines fetcher + L2 order-book connector), so adding a fifth
exchange later means adding one entry there, not touching the failover logic
itself. `ACTIVE_PROVIDER` (`Component.cryptoActiveId` in
`TradingDashboard.html`, shown in the header when a crypto symbol is
selected) is a single state shared by both klines and the order book — only
one exchange is ever trusted at a time.

- **Forward failover:** a kline fetch failure or `MAX_PROVIDER_BOOK_FAILURES`
  (3) consecutive order-book connection failures moves `ACTIVE_PROVIDER` to
  the next lower-priority exchange. Never wraps back to a higher-priority one
  within the same failed request — that's the recovery check's job, below.
- **Recovery:** every 20s, if not already on Kraken, the dashboard probes
  each higher-priority exchange (top-down) with a real klines fetch; the
  first one that succeeds becomes the new `ACTIVE_PROVIDER` and the order
  book reconnects there. Matches: Kraken down → Bitstamp active → Kraken
  recovers → automatically back on Kraken.
- **Manual reconnect** (the "Reconnect" control, shown when `wsStatus` is
  `offline` — i.e. even Binance, the last resort, is down) resets straight
  to Kraken rather than retrying whatever failed last.
- **Order book strategy — read this before touching `cryptoProviders.js`:**
  Binance and Bitstamp push full L2 snapshots natively over WS. Kraken's WS
  v2 book channel and Gemini's WS feed are both *incremental-delta* streams
  that need local order-book state to stay correct long-term — meaningfully
  more infrastructure and a real source of subtle bugs. Kraken's connector
  here re-subscribes every ~3s for a fresh full snapshot instead of merging
  deltas; Gemini's connector polls its REST book endpoint every ~2s instead
  of using its WS feed at all. Both are still real, live exchange data —
  refreshed every 2-3s rather than on every individual book-level tick. This
  is a deliberate, documented tradeoff (see the comment at the top of
  `cryptoProviders.js`), not a hidden shortcut — and it matters more than it
  might sound, since Kraken is now the *primary* provider, not a rare
  fallback.

### Why FX/news/macro need a proxy and crypto doesn't

Crypto's four sources are all free, keyless, and send
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
- **No server-side caching in front of the free keyless APIs** (Kraken,
  Bitstamp, Gemini, Binance, CoinGecko, alternative.me) — every visitor's browser
  polls them independently. CoinGecko's free tier rate-limits fairly
  aggressively; a real spike in concurrent users could degrade the
  sentiment panel for everyone in that window. Fine for personal/low-traffic
  use; revisit with an edge cache if usage grows. (The keyed sources behind
  the proxy don't have this problem in the same way — see the proxy's own
  README for its rate-limiting notes.)
- **VS Code shows ~80 CSS diagnostics on `TradingDashboard.html` by
  default** ("identifier expected", "} expected", "Do not use empty
  rulesets") on nearly every styled element. These are IDE-only false
  positives: VS Code's built-in CSS language service validates the raw text
  inside every `style="..."` attribute, but this file's styles are full of
  `{{ expr }}` template placeholders (e.g. `style="background:{{ chip.style
  }}"`) resolved at runtime by the dc-runtime compiler, not by the
  browser's CSS parser — VS Code doesn't know that and chokes on the `{`
  `}` characters. `.vscode/settings.json` in this repo sets
  `"css.validate": false` to silence it (no real validation is lost — there
  are no standalone `.css` files here).

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

## Production deployment (IIS)

Target hostnames: `forex.hayyaak.com`, `trade.hayyaak.com`, `hayyaak.trade`.
Two files make this work, both in this repo:

- **`web.config`** — IIS config for this site: default document
  (`TradingDashboard.html`, not `index.html`), MIME types, security headers
  (deliberately not a second CSP — `TradingDashboard.html`'s own `<meta>`
  CSP is authoritative), a Cloudflare-safe HTTPS redirect, and a URL
  Rewrite + ARR rule that reverse-proxies `/api/*` to the local proxy
  (`http://127.0.0.1:8787`, loopback-only — see `server.js`'s `.listen()`
  call). That last part is *why* `TradingDashboard.html`'s
  `proxyBaseUrl` resolves to a same-origin relative `/api` path in
  production instead of a hardcoded host:port — same file, same origin,
  no CORS involved at all once the reverse-proxy rule is live.
- **`iis-setup.ps1`** — one-time server setup (new site + app pool +
  enabling ARR's proxy feature server-wide). Deliberately **not** run
  automatically — this machine also hosts a real, unrelated site
  (`hayyaak.com`) and any change to live IIS state should get a human's
  eyes on it first. Run it yourself, elevated: right-click PowerShell →
  Run as Administrator → `.\iis-setup.ps1`. It's idempotent (safe to
  re-run) and doesn't touch the existing `Default Web Site` at all — new
  site, new dedicated app pool, isolated physical path.

**What's confirmed vs. what still needs your action** (checked 2026-08-01):

| | Status |
|---|---|
| `forex.hayyaak.com` DNS | ✅ resolves (Cloudflare IPs, same pattern as `hayyaak.com`) |
| `hayyaak.trade` DNS | ✅ resolves (Cloudflare IPs, different zone) |
| `trade.hayyaak.com` DNS | ❌ **no DNS record at all** — add it wherever `hayyaak.com`'s other records live (likely Cloudflare) before this hostname can work |
| Cloudflare → this machine routing | ❓ unverified — DNS resolving to Cloudflare only confirms Cloudflare is the edge, not that these hostnames are proxied to *this* origin. Check in the Cloudflare dashboard. |
| Cloudflare SSL/TLS mode | ❓ unverified — if it's "Flexible", the http-only IIS bindings `iis-setup.ps1` creates are correct as-is. If "Full"/"Full (strict)", this box needs its own certificate bound to real HTTPS bindings, which `iis-setup.ps1` does not create. |
| Router/firewall reaching this box on 80/443 | ❓ unverified — can't be checked from inside the machine |
| IIS site + ARR reverse-proxy | ⏳ ready to create — run `iis-setup.ps1` |
| Proxy (`C:\proxy-server`) | ✅ running, hardened to loopback-only, all 4 provider keys configured |

Once `iis-setup.ps1` has been run and the proxy is running, verify the
reverse-proxy path end-to-end **from this machine**, independent of
DNS/Cloudflare/firewall:

```
curl.exe -H "Host: forex.hayyaak.com" http://127.0.0.1/api/fx/klines?symbol=EURUSD
```

A real klines JSON response back confirms IIS → ARR → the Node proxy is
wired correctly; anything else that's still broken at that point is a
DNS/Cloudflare/network question, not an IIS or app config one.

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

A fourth pass (2026-08-01) replaced the crypto data path entirely: fixed
ADX/ATR reading impossible values (ADX hit 575, bounded 0-100 by
definition — traced to a real weighting bug in `wilderSmooth()`, not a
data issue), fixed NaN cells in the correlation matrix (a Yahoo gap-bar
`null` leaking into the math unfiltered), then — at the user's request —
replaced Binance-as-primary/Kraken+Coinbase-as-fallback with a proper
multi-exchange failover system: Kraken → Bitstamp → Gemini → Binance, with
automatic forward failover and periodic automatic recovery back toward
Kraken. See "Crypto: multi-exchange failover" above and
`cryptoProviders.js` for the implementation.

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
