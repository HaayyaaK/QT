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
- `marketHours.js` — session calendars. Gates the alert stream (`isMarketOpen`)
  and supplies the daily-roll identity the pivot card resets on
  (`sessionKey`). Delegates DST to `Intl` with IANA zone names rather than
  UTC-offset arithmetic. See "Liquidity walls" below.
- `pivotLevels.js` — grouped-liquidity walls: bucketing, the R1/R2/R3 +
  S1/S2/S3 persistence rules, mid-tick direction, and spread-width tiers.
- **`C:\proxy-server`** (separate project, *not* inside this repo — see below)
  — local API proxy holding third-party keys server-side.
- `assets/` — PWA manifest, favicons and app icons. Served at `/assets`; the
  shared self-hosted fonts are mounted separately at `/vendor` by
  `iis-setup.ps1` precisely so they don't shadow this folder.

## Tracked symbols

Navigator row 1 (FX majors): EUR/USD, GBP/USD, USD/JPY, USD/CHF, AUD/USD,
NZD/USD, USD/CAD. Row 2 (metals + crypto): XAU/USD, BTC/USD, ETH/USD.

XAU/USD keeps `type: 'fx'` — that drives its data path (proxy klines, no L2
book) and its COMEX calendar. Only the navigator `group` puts it beside crypto.

## Liquidity walls (R1/R2/R3 · S1/S2/S3)

Three grouped-liquidity levels per side of the book, drawn as a mirrored
ladder — R1 and S1 nearest the mid, the frozen extremes furthest out.

Derived from the ~10-12 levels the L2 ladder already shows, which on BTC/USD
spans roughly $4. These are **immediate passive liquidity, not deep
support/resistance**; the book depth was deliberately left alone rather than
risk the validated failover path.

| Level | Behaviour |
|---|---|
| R3 / S3 | Strongest wall of the session. Frozen — only replaced when a grouped quantity *reaches or exceeds* it, so it can outlive the liquidity it describes. |
| R2 / S2 | The 50%-of-R3 wall. Resolution order below. |
| R1 / S1 | Fully dynamic, recomputed every book update. |

R2/S2 resolves in four steps, so the row is never blank without saying why:

1. A bucket at normal granularity clearing 50% of R3.
2. Otherwise re-group into wider price windows and look again — a thin book
   often splits one real wall across neighbouring ticks. Shown as "grouped".
3. Otherwise retain a previously *qualified* level; a real wall is never
   downgraded by a quiet moment.
4. Otherwise show the strongest runner-up, muted and dashed, noted "below 50%".

A single-bucket book shows an explicit "no second wall in book".

Frozen levels reset on symbol change, on provider change after a failover, and
at the venue's session roll (00:00 UTC crypto, 17:00 local FX/metals). L2
levels carry no timestamps and no history, so the session boundary — not a
date filter — is what scopes them to "today".

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
- **Data-staleness watchdog:** connection status (open/closed/error) is
  *not* sufficient health monitoring on its own — a real bug proved this
  (see below). `connectCryptoBook` tracks the time since the last actual
  `onBook` update and treats "still connected, but no data in >15s" the
  same as a hard failure, escalating through the same failover path.
- **TradingView chart follows `ACTIVE_PROVIDER`** too (`tvSymbolFor()` —
  `KRAKEN:BTCUSD` / `BITSTAMP:BTCUSD` / `GEMINI:BTCUSD` / `BINANCE:BTCUSD`),
  remounting on every provider switch, shown in the "ADVANCED CHART" panel
  header. TradingView's own symbol-search API blocks automated/curl
  verification (bot protection, 403s even with browser-realistic headers),
  so this couldn't be confirmed the same way as every other exchange
  integration in this project — confirmed instead by the user directly in
  TradingView, all four symbols exist as listed above. The existing
  chart-widget error detection (`widgetErrors.chart`, "Chart widget
  blocked" / Retry) remains the safety net regardless.
- **Order book strategy — read this before touching `cryptoProviders.js`:**
  Binance and Bitstamp push full L2 snapshots natively over WS — simple to
  consume. Kraken's WS v2 book channel is an incremental-delta stream: a
  **real bug**, found via live browser testing and confirmed with a
  standalone WS probe, is that an earlier version tried to force fresh data
  by re-subscribing to the same channel every ~3s instead of merging
  deltas — Kraken rejects a duplicate subscribe
  (`{"success":false,"error":"Already subscribed"}`) rather than sending a
  new snapshot, so the book silently froze after the very first message.
  Fixed by properly maintaining local order-book state (`applyKrakenLevels`
  / `topLevels` in `cryptoProviders.js`, unit-tested) — a `Map` per side,
  upserted/deleted by each delta, re-sorted to top-10 on every update.
  Even with correct merging, an incremental stream has no way to notice a
  **missed** delta on its own — confirmed live as a crossed book (best bid
  above best ask) on a connection that was never actually interrupted, just
  one dropped message. Kraken's `book` channel ships a CRC-32 checksum of
  the top-10 bids/asks specifically to catch this; `krakenBookChecksum` in
  `cryptoProviders.js` validates it after every snapshot/update and forces a
  reconnect (fresh snapshot) on mismatch. The formatting isn't documented
  anywhere obvious — calibrated by comparing candidate checksums against
  Kraken's real live values: price at the pair's fixed tick decimals (1 for
  BTC/USD, 2 for ETH/USD), qty at 8 decimals, asks-then-bids, concatenated
  and CRC-32'd. **Observed live drift rate on this dev machine: roughly one
  genuine mismatch every 10-15s** — high enough to be worth re-measuring
  from wherever this is actually deployed (network path affects delta-loss
  rate) before assuming it's universal. Each detected mismatch is a clean,
  fast reconnect, not a failover — `bookFailCount` resets on the next
  successful connection, so this doesn't cascade into a provider switch.
  Gemini's WS feed is the same class of incremental stream (confirmed live:
  its "initial" snapshot arrives as ~4900 individual per-level events, not
  one message) — building the same local-state engine for it was judged not
  worth the added surface area given Gemini is priority #3, not primary,
  and its REST order-book endpoint (polled every ~2s) was verified live to
  work correctly *and continuously* — sustained-update tested over 10s, not
  just a first-message check, after the Kraken bug above made clear that
  distinction matters. That remains a deliberate, documented tradeoff, not
  a bug: still real, live exchange data, refreshed every ~2s rather than on
  every tick.

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

Runs via Node's built-in test runner (`node --test`, no external dependencies,
auto-discovers every `*.test.js` — no separate invocation per file) — 74 tests
total:

- `taEngine.test.js` (22) — SMA/EMA/RSI/MACD/Bollinger/Wilder-smoothing/
  ATR/ADX/Donchian/Pearson/trend-label/simulateKlines against a fixed OHLCV
  fixture.
- `cryptoProviders.test.js` (18) — provider registry integrity, the
  `attemptWithFailover` algorithm, Kraken order-book merging
  (`applyKrakenLevels`/`topLevels`), and the Kraken book-checksum validator
  (`crc32`/`krakenBookChecksum`, tested against a real captured live
  snapshot — see "Crypto: multi-exchange failover" below).
- `marketHours.test.js` (16) — session windows for FX and COMEX, both DST
  boundaries asserted explicitly (the FX roll is 21:00 UTC in summer and
  22:00 in winter, so a hardcoded offset is wrong half the year), plus
  `sessionKey` daily rolls across DST, month and year boundaries.
- `pivotLevels.test.js` (18) — bucketing, level3 freeze/replace-on-equal, all
  four level2 resolution paths (qualified, widened, retained, runner-up
  fallback), level1 collision avoidance, and spread tiers across price scales.

The proxy has its own separate test suite — see its README.

## Production deployment (IIS)

Live at **`https://fx.hayyaak.com`** (the site binds this hostname only).
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

`iis-setup.ps1` also maps one virtual directory: **`/vendor` →
`C:\inetpub\wwwroot\assets`**, the shared folder holding the self-hosted
Inter and JetBrains Mono woff2 files. It is deliberately *not* mounted at
`/assets` — the site has its own `assets\` folder (PWA manifest, icons) and a
vdir there would shadow it completely, 404'ing those files regardless of
what's on disk. `web.config` registers the `.webmanifest` and `.svg` MIME
types, without which IIS returns 404.3 for them.

**Deployment status** (verified 2026-08-03):

| | Status |
|---|---|
| `fx.hayyaak.com` DNS | ✅ resolves via Cloudflare |
| Cloudflare → this machine routing | ✅ confirmed — the dashboard loads over `https://fx.hayyaak.com` end to end |
| IIS site + app pool + ARR reverse-proxy | ✅ created and serving (`iis-setup.ps1` has been run) |
| `/vendor` fonts + `/assets` manifest and icons | ✅ all serving with correct MIME types |
| Proxy (`C:\proxy-server`) | ✅ running, loopback-only, all 4 provider keys configured |
| Crypto failover chain + 45s cooldown | ✅ validated against the live box — see `PROJECT_STATUS.md` |
| Cloudflare SSL/TLS mode | ❓ unverified — if "Flexible", the http-only bindings `iis-setup.ps1` creates are correct as-is. If "Full"/"Full (strict)", this box needs its own certificate bound to real HTTPS bindings, which `iis-setup.ps1` does not create. |

Note there is no separate deploy step: IIS serves `TradingDashboard.html`
directly from this working directory, so a saved file is live immediately.
Git here is version control, not a deployment pipeline.

### PWA manifest and icons

`assets/site.webmanifest` carries the install metadata (name, theme/background
`#0a0d12`, `display: standalone`) and references the 192/512 PNG icons plus an
SVG and a maskable SVG whose artwork stays inside Android's 80% safe zone.
`TradingDashboard.html` links it with a **relative** href, because this file is
served both from the site root (`fx.hayyaak.com/`) and from a subpath on the
default site — a root-absolute path would only resolve on one of them.

Two things are required for it to load rather than fail silently: the CSP
declares `manifest-src 'self'` (the page's `default-src 'none'` blocks manifest
fetches outright), and `web.config` maps the `.webmanifest` MIME type.

Once `iis-setup.ps1` has been run and the proxy is running, verify the
reverse-proxy path end-to-end **from this machine**, independent of
DNS/Cloudflare/firewall:

```
curl.exe -H "Host: fx.hayyaak.com" http://127.0.0.1/api/fx/klines?symbol=EURUSD
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

A fifth pass (2026-08-01, same day) fixed a real bug the user found via
live browser testing: the L2 order book and depth chart were frozen after
the first update. Root cause was Kraken's order-book connector — see
"Order book strategy" above for the full story (Kraken rejects a
repeated-subscribe attempt instead of sending fresh data; fixed with
proper incremental order-book merging, now unit-tested). Also added the
data-staleness watchdog that should have caught this class of bug on its
own (connection-status monitoring alone isn't sufficient — a socket can
stay technically "connected" while silently delivering nothing), and wired
the TradingView chart to follow `ACTIVE_PROVIDER` instead of a fixed
Binance mapping, which had been a real gap against the original spec.

A sixth pass (2026-08-01, same day, commit `0ab4020`) fixed three bugs found
via live browser failover testing:

1. **Recovery/failover flapping** — the 20s recovery health-check had no
   cooldown, so a provider whose REST klines came back healthy could
   immediately trigger a switch-back while its WebSocket was still unstable,
   producing rapid Kraken↔Bitstamp flapping. Fixed with a 45s cooldown in
   `switchCryptoProvider` itself (covers every path that can move back
   toward a higher-priority provider, not just the explicit health-check);
   forward failover on a real live failure stays immediate, ungated.
2. **Double connection on every page load** — `support.js`'s boot sequence
   unconditionally self-fetched the page and called `updateHtml()`, racing
   the initial mount and causing `TradingDashboard.html`'s `Component` to
   mount twice, briefly opening two live Kraken connections before the
   first was torn down. Fixed by gating that refetch behind `window.parent
   !== window` (only relevant when an actual live-editor host is attached —
   same condition `notifyHost()` already used).
3. **Kraken book checksum validation**, described above under "Order book
   strategy" — catches missed deltas that the incremental merge alone can't
   detect.

**Status: ready for production testing on IIS.** All three fixes are
committed and unit-tested (40/40 passing); see `PROJECT_STATUS.md` for the
live-browser test results this pass was based on, and `DEPLOYMENT.md` for
moving this repo + the proxy to a hosting device.

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
7. **Market holidays are not modelled.** `marketHours.js` gates the alert
   stream on weekly session hours and handles DST correctly, but knows
   nothing about Good Friday, Christmas, Thanksgiving, or any other market
   holiday. On those days FX and XAU/USD are closed while the calendar still
   reports them open, so the alert stream can fire signals derived from the
   previous session's static candles — the same class of false signal that
   weekly gating fixes for weekends. The "◐ LAST CLOSE · MARKET CLOSED"
   indicator is subject to the same gap and will read "● LIVE DATA" on a
   holiday. Tracked as a follow-up; fixed-date and Easter-relative holiday
   tables are the remaining work.
