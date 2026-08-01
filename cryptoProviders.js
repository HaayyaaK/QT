// Multi-exchange crypto market-data provider registry for BTC/USD & ETH/USD.
//
// Encapsulates REST klines + L2 order book per exchange behind one
// consistent interface (fetchKlines / connectBook) so the failover and
// health-monitoring logic in TradingDashboard.html doesn't need to know
// any exchange-specific request/response details. Priority order is the
// array order: Kraken (primary) -> Bitstamp -> Gemini -> Binance (final
// fallback).
//
// All four exchanges were verified live before writing this (real
// requests, not assumed from docs): REST endpoints, response shapes, and
// CORS headers for browser-direct access, plus a live WebSocket probe for
// each order-book feed.
//
// ORDER BOOK STRATEGY — read before changing anything here:
// Binance and Bitstamp push full L2 snapshots natively over WS on every
// update. Kraken's WS v2 "book" channel is an incremental-delta stream —
// its "snapshot" message only arrives once per subscription, then
// per-level "update" deltas follow (qty 0 = remove that price level).
// An earlier version of this file tried to force fresh snapshots by
// re-subscribing every ~3s instead of merging deltas — CONFIRMED LIVE to
// be broken: Kraken rejects a duplicate subscribe to an already-active
// channel ({"success":false,"error":"Already subscribed"}) rather than
// sending a new snapshot, so the book silently froze after the first
// message (found via real browser testing, reproduced with a standalone
// WS probe — see git history). Fixed by properly maintaining local
// order-book state: a Map per side, upserted/deleted by each delta,
// re-sorted and sliced to top-N on every update. This is what "handle
// sequence/out-of-order edge cases" normally warns you off doing
// casually — but the bug above proved the shortcut doesn't actually work,
// so this is the real thing now, not a shortcut.
// Gemini's WS market-data feed is the same class of incremental-delta
// stream (confirmed live: an "initial" snapshot as ~4900 individual
// per-level events, not one snapshot message) — building the same kind of
// local-state engine for it was judged not worth the additional surface
// area given Gemini is priority #3, not primary, and its REST order-book
// endpoint polled every ~2s was verified live to work correctly and
// continuously (sustained-update tested, not just a first-message check —
// see cryptoProviders.test.js and the session's live verification notes).
// That remains a deliberate, documented tradeoff: still real, live
// exchange data, refreshed every ~2s rather than on every tick.

function toPairs(arr, priceKey, qtyKey) {
  if (!Array.isArray(arr)) return [];
  return arr.map((row) => {
    if (Array.isArray(row)) return [+row[0], +row[1]];
    return [+row[priceKey], +row[qtyKey]];
  });
}

// ---------------------------------------------------------------- Kraken --
const KRAKEN_KLINE_MINUTES = { '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };

async function krakenKlines(nativeSymbol, interval, limit) {
  const minutes = KRAKEN_KLINE_MINUTES[interval] || 60;
  const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${nativeSymbol}&interval=${minutes}`);
  if (!r.ok) throw new Error('kraken http ' + r.status);
  const j = await r.json();
  if (j.error && j.error.length) throw new Error('kraken: ' + j.error.join(', '));
  const dataKey = Object.keys(j.result || {}).find((k) => k !== 'last');
  const rows = (dataKey && j.result[dataKey]) || [];
  if (rows.length < 20) throw new Error('kraken: insufficient data');
  const trimmed = rows.slice(-limit);
  return {
    opens: trimmed.map((r) => +r[1]), highs: trimmed.map((r) => +r[2]), lows: trimmed.map((r) => +r[3]),
    closes: trimmed.map((r) => +r[4]), volumes: trimmed.map((r) => +r[6]),
  };
}

// Applies Kraken's delta convention (qty 0 = remove, otherwise upsert) to
// a local price->qty Map. Exported for direct unit testing.
export function applyKrakenLevels(map, levels) {
  for (const lvl of levels || []) {
    if (lvl.qty === 0) map.delete(lvl.price);
    else map.set(lvl.price, lvl.qty);
  }
  return map;
}

// Derives the sorted top-N view from a price->qty Map. Exported for
// direct unit testing. side: 'bids' sorts descending (best/highest
// first), 'asks' ascending (best/lowest first) — standard L2 convention.
export function topLevels(map, side, n = 10) {
  const entries = [...map.entries()];
  entries.sort((a, b) => (side === 'bids' ? b[0] - a[0] : a[0] - b[0]));
  return entries.slice(0, n);
}

// CRC-32 (zlib/ISO-HDLC polynomial) — Kraken's v2 book checksum algorithm.
// Exported for direct unit testing.
export function crc32(str) {
  let crc = ~0;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i);
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

// Per Kraken's checksum spec: format each price/qty to the pair's fixed
// decimal precision, strip the decimal point, then strip leading zeros
// (trailing zeros stay — they're significant digits, not display noise).
// toFixed(decimals) is safe here even though JSON parsing already turned
// the wire value into a float: as long as `decimals` matches the pair's
// real precision, re-padding reconstructs the exact original digit string.
function krakenChecksumPart(n, decimals) {
  const s = n.toFixed(decimals).replace('.', '').replace(/^0+/, '');
  return s === '' ? '0' : s;
}

// Book-precision per pair, calibrated against Kraken's live feed (not
// documented anywhere obvious — verified by comparing candidate checksums
// against real `checksum` values across dozens of live messages until one
// combination matched consistently). Keyed by the wsSymbol used in the
// `book` subscription (bookSymbol from the registry below).
const KRAKEN_BOOK_PRECISION = {
  'BTC/USD': { priceDec: 1, qtyDec: 8 },
  'ETH/USD': { priceDec: 2, qtyDec: 8 },
};

// Exported for direct unit testing. bids/asks are [price, qty] pair arrays
// as returned by topLevels (already sorted/sliced to top-10 by the caller).
export function krakenBookChecksum(asks, bids, priceDec, qtyDec) {
  const part = (level) => krakenChecksumPart(level[0], priceDec) + krakenChecksumPart(level[1], qtyDec);
  return crc32(asks.map(part).join('') + bids.map(part).join(''));
}

function krakenConnectBook(wsSymbol, { onBook, onStatus }) {
  let ws = null, closed = false;
  let bidMap = new Map(), askMap = new Map(); // price -> qty, maintained locally
  const precision = KRAKEN_BOOK_PRECISION[wsSymbol];
  function emit() {
    onBook(topLevels(bidMap, 'bids'), topLevels(askMap, 'asks'));
  }
  // Verifies our locally-maintained book against Kraken's own checksum of
  // the same top-10x2 levels. This exists because the delta-merge above has
  // no way to notice a *missed* update on its own — a single dropped message
  // (a network hiccup, a backgrounded tab throttling timers, anything) would
  // otherwise leave bidMap/askMap silently wrong forever, with symptoms like
  // a crossed book (best bid > best ask) turning up later with no direct
  // link back to the cause. A checksum mismatch means "our state is
  // provably wrong, not just possibly stale" — so on mismatch we close the
  // real WebSocket outright (not the wrapper's close(), which suppresses
  // onStatus) so the *existing* onclose -> onStatus('closed') failure path
  // reconnects and gets a fresh snapshot, the same recovery Kraken's own
  // protocol expects. Reusing that path (rather than a silent resubscribe)
  // also means a persistently bad checksum still counts toward
  // MAX_PROVIDER_BOOK_FAILURES and eventually fails over, instead of looping
  // forever on Kraken if this calibration were ever wrong for some pair.
  function verifyChecksum(received) {
    if (!precision || received == null) return;
    const asks = topLevels(askMap, 'asks', 10), bids = topLevels(bidMap, 'bids', 10);
    if (asks.length < 10 || bids.length < 10) return; // checksum spec assumes full depth
    const computed = krakenBookChecksum(asks, bids, precision.priceDec, precision.qtyDec);
    if (computed !== received) {
      const bestAsk = asks[0][0], bestBid = bids[0][0];
      console.warn(
        `[WARN] Kraken book checksum mismatch on ${wsSymbol} at ${new Date().toISOString()}: ` +
        `computed=${computed} received=${received}, spread=${(bestAsk - bestBid).toFixed(precision.priceDec)} ` +
        `(best bid ${bestBid}, best ask ${bestAsk}) — forcing reconnect for a fresh snapshot`
      );
      if (ws) { try { ws.close(); } catch {} }
    }
  }
  function open() {
    if (closed) return;
    onStatus('connecting');
    ws = new WebSocket('wss://ws.kraken.com/v2');
    ws.onopen = () => {
      onStatus('connected');
      ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'book', symbol: [wsSymbol], depth: 10 } }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.channel !== 'book' || !Array.isArray(msg.data) || !msg.data[0]) return;
      const d = msg.data[0];
      if (msg.type === 'snapshot') {
        bidMap = new Map((d.bids || []).map((l) => [l.price, l.qty]));
        askMap = new Map((d.asks || []).map((l) => [l.price, l.qty]));
        emit();
        verifyChecksum(d.checksum);
      } else if (msg.type === 'update') {
        applyKrakenLevels(bidMap, d.bids);
        applyKrakenLevels(askMap, d.asks);
        emit();
        verifyChecksum(d.checksum);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => { if (!closed) onStatus('closed'); };
  }
  open();
  return {
    close() {
      closed = true;
      if (ws) { try { ws.close(); } catch {} }
    },
  };
}

// -------------------------------------------------------------- Bitstamp --
const BITSTAMP_KLINE_STEP_SEC = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

async function bitstampKlines(nativeSymbol, interval, limit) {
  const step = BITSTAMP_KLINE_STEP_SEC[interval] || 3600;
  const r = await fetch(`https://www.bitstamp.net/api/v2/ohlc/${nativeSymbol}/?step=${step}&limit=${Math.min(limit, 1000)}`);
  if (!r.ok) throw new Error('bitstamp http ' + r.status);
  const j = await r.json();
  const rows = j?.data?.ohlc || [];
  if (rows.length < 20) throw new Error('bitstamp: insufficient data');
  // Confirmed live: already chronological (oldest-first) — no reverse needed.
  return {
    opens: rows.map((r) => +r.open), highs: rows.map((r) => +r.high), lows: rows.map((r) => +r.low),
    closes: rows.map((r) => +r.close), volumes: rows.map((r) => +r.volume),
  };
}

function bitstampConnectBook(nativeSymbol, { onBook, onStatus }) {
  let ws = null, closed = false;
  function open() {
    if (closed) return;
    onStatus('connecting');
    ws = new WebSocket('wss://ws.bitstamp.net');
    ws.onopen = () => {
      onStatus('connected');
      ws.send(JSON.stringify({ event: 'bts:subscribe', data: { channel: `order_book_${nativeSymbol}` } }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.event === 'data' && msg.data) {
        onBook(toPairs(msg.data.bids), toPairs(msg.data.asks));
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => { if (!closed) onStatus('closed'); };
  }
  open();
  return {
    close() {
      closed = true;
      if (ws) { try { ws.close(); } catch {} }
    },
  };
}

// ---------------------------------------------------------------- Gemini --
const GEMINI_KLINE_TIMEFRAME = { '5m': '5m', '15m': '15m', '1h': '1hr', '4h': '6hr', '1d': '1day' };

async function geminiKlines(nativeSymbol, interval, limit) {
  const tf = GEMINI_KLINE_TIMEFRAME[interval] || '1hr';
  const r = await fetch(`https://api.gemini.com/v2/candles/${nativeSymbol}/${tf}`);
  if (!r.ok) throw new Error('gemini http ' + r.status);
  const rows = await r.json(); // newest-first, no server-side limit param
  if (!Array.isArray(rows) || rows.length < 20) throw new Error('gemini: insufficient data');
  const chron = rows.slice(0, limit).reverse();
  return {
    opens: chron.map((r) => +r[1]), highs: chron.map((r) => +r[2]), lows: chron.map((r) => +r[3]),
    closes: chron.map((r) => +r[4]), volumes: chron.map((r) => +r[5]),
  };
}

// REST polling, not WS — see the file-level note above.
function geminiConnectBook(nativeSymbol, { onBook, onStatus }) {
  const POLL_MS = 2000;
  let timer = null, closed = false, inFlight = false;
  async function poll() {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      const r = await fetch(`https://api.gemini.com/v1/book/${nativeSymbol}?limit_bids=12&limit_asks=12`);
      if (!r.ok) throw new Error('gemini http ' + r.status);
      const j = await r.json();
      onBook(toPairs(j.bids, 'price', 'amount'), toPairs(j.asks, 'price', 'amount'));
      onStatus('connected');
    } catch {
      if (!closed) onStatus('closed');
    } finally {
      inFlight = false;
    }
  }
  onStatus('connecting');
  poll();
  timer = setInterval(poll, POLL_MS);
  return {
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}

// --------------------------------------------------------------- Binance --
const BINANCE_KLINE_INTERVAL = { '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };

async function binanceKlines(nativeSymbol, interval, limit) {
  const iv = BINANCE_KLINE_INTERVAL[interval] || '1h';
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${nativeSymbol}&interval=${iv}&limit=${limit}`);
  if (!r.ok) throw new Error('binance http ' + r.status);
  const rows = await r.json();
  if (!rows || rows.length < 20) throw new Error('binance: insufficient data');
  return {
    opens: rows.map((r) => +r[1]), highs: rows.map((r) => +r[2]), lows: rows.map((r) => +r[3]),
    closes: rows.map((r) => +r[4]), volumes: rows.map((r) => +r[5]),
  };
}

function binanceConnectBook(nativeSymbol, { onBook, onStatus }) {
  let ws = null, closed = false;
  function open() {
    if (closed) return;
    onStatus('connecting');
    ws = new WebSocket(`wss://stream.binance.com:9443/ws/${nativeSymbol.toLowerCase()}@depth20@100ms`);
    ws.onopen = () => onStatus('connected');
    ws.onmessage = (ev) => {
      let b;
      try { b = JSON.parse(ev.data); } catch { return; }
      onBook(toPairs(b.bids), toPairs(b.asks));
    };
    ws.onerror = () => {};
    ws.onclose = () => { if (!closed) onStatus('closed'); };
  }
  open();
  return {
    close() {
      closed = true;
      if (ws) { try { ws.close(); } catch {} }
    },
  };
}

// ------------------------------------------------------------- Registry --
// Priority order = array order. klinesSymbol/bookSymbol translate our
// canonical internal ids (BTCUSD / ETHUSD) to each exchange's own native
// symbol format — this is the single place that mapping lives.
export const PROVIDERS = [
  {
    id: 'kraken',
    label: 'Kraken',
    klinesSymbol: { BTCUSD: 'XBTUSD', ETHUSD: 'ETHUSD' },
    bookSymbol: { BTCUSD: 'BTC/USD', ETHUSD: 'ETH/USD' },
    fetchKlines: krakenKlines,
    connectBook: krakenConnectBook,
  },
  {
    id: 'bitstamp',
    label: 'Bitstamp',
    klinesSymbol: { BTCUSD: 'btcusd', ETHUSD: 'ethusd' },
    bookSymbol: { BTCUSD: 'btcusd', ETHUSD: 'ethusd' },
    fetchKlines: bitstampKlines,
    connectBook: bitstampConnectBook,
  },
  {
    id: 'gemini',
    label: 'Gemini',
    klinesSymbol: { BTCUSD: 'btcusd', ETHUSD: 'ethusd' },
    bookSymbol: { BTCUSD: 'btcusd', ETHUSD: 'ethusd' },
    fetchKlines: geminiKlines,
    connectBook: geminiConnectBook,
  },
  {
    id: 'binance',
    label: 'Binance',
    klinesSymbol: { BTCUSD: 'BTCUSD', ETHUSD: 'ETHUSD' },
    bookSymbol: { BTCUSD: 'BTCUSD', ETHUSD: 'ETHUSD' },
    fetchKlines: binanceKlines,
    connectBook: binanceConnectBook,
  },
];

export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id);
}

// Generic priority-ordered failover walk: starting from `startId`, tries
// `attempt(provider)` on each provider from that point *forward only*
// (never wraps back to a higher-priority one already passed — recovery
// back toward the top is a separate, deliberate health-check concern, not
// something a single failed request should trigger). Returns the first
// success as `{ provider, result }`, or `null` if every remaining
// provider failed. `onProviderFailed(provider, error)` is called for each
// failure along the way, so the caller can log without this function
// knowing anything about logging.
//
// Pulled out as its own pure function (rather than inlined per call site)
// so the failover *algorithm* has exactly one implementation and is
// independently testable — see cryptoProviders.test.js.
export async function attemptWithFailover(providers, startId, attempt, onProviderFailed) {
  const startIdx = Math.max(providers.findIndex((p) => p.id === startId), 0);
  for (let i = startIdx; i < providers.length; i++) {
    const provider = providers[i];
    try {
      const result = await attempt(provider);
      return { provider, result };
    } catch (e) {
      if (onProviderFailed) onProviderFailed(provider, e);
    }
  }
  return null;
}
