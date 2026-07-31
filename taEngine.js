// Client-side technical-analysis math engine. Plain ES module, no deps.

export function sma(arr, period) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(arr, period) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) continue;
    if (prev == null) {
      if (i >= period - 1) {
        const seed = arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
        prev = seed;
        out[i] = seed;
      }
    } else {
      prev = arr[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = Math.max(diff, 0), loss = Math.max(-diff, 0);
    if (i <= period) {
      gains += gain; losses += loss;
      if (i === period) {
        const rs = losses === 0 ? 100 : gains / period / (losses / period || 1e-9);
        out[i] = 100 - 100 / (1 + rs);
      }
    } else {
      gains = (gains * (period - 1) + gain) / period;
      losses = (losses * (period - 1) + loss) / period;
      const rs = losses === 0 ? 100 : gains / (losses || 1e-9);
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signalP = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) => (emaFast[i] != null && emaSlow[i] != null) ? emaFast[i] - emaSlow[i] : null);
  const cleaned = macdLine.map(v => v == null ? 0 : v);
  const signalLine = ema(cleaned, signalP).map((v, i) => macdLine[i] == null ? null : v);
  const histogram = macdLine.map((v, i) => (v != null && signalLine[i] != null) ? v - signalLine[i] : null);
  return { macdLine, signalLine, histogram };
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] == null) continue;
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = mid[i];
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { mid, upper, lower };
}

// Wilder's smoothing (alpha = 1/period) — distinct from the 2/(period+1) EMA
// constant above. ATR/ADX/RSI are conventionally computed with this recursive
// form ("RMA") on every mainstream charting platform; using standard EMA here
// makes ATR/ADX disagree with e.g. the TradingView chart shown alongside them.
export function wilderSmooth(arr, period) {
  const out = new Array(arr.length).fill(null);
  let prev = null, seedSum = 0, seedCount = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v == null) continue;
    if (prev == null) {
      seedSum += v; seedCount++;
      if (seedCount === period) {
        prev = seedSum / period;
        out[i] = prev;
      }
    } else {
      // prev*(1 - 1/period) + v/period — weights must sum to 1. Missing the
      // /period on v here (i.e. `prev - prev/period + v`) adds each new raw
      // value at full weight on top of a barely-decayed prior average, which
      // doesn't converge — it ratchets upward every step. Caught via ADX
      // reading 575 on real EUR/USD data (ADX is bounded 0-100 by
      // definition, which made the divergence obvious; the same bug in
      // atr() is quieter since ATR has no natural upper bound to expose it).
      prev = prev + (v - prev) / period;
      out[i] = prev;
    }
  }
  return out;
}

export function atr(highs, lows, closes, period = 14) {
  const tr = highs.map((h, i) => {
    if (i === 0) return h - lows[i];
    return Math.max(h - lows[i], Math.abs(h - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  });
  return wilderSmooth(tr, period);
}

export function adx(highs, lows, closes, period = 14) {
  const len = highs.length;
  const plusDM = new Array(len).fill(0), minusDM = new Array(len).fill(0), tr = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  const smTR = wilderSmooth(tr, period), smPlus = wilderSmooth(plusDM, period), smMinus = wilderSmooth(minusDM, period);
  const dx = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    if (!smTR[i]) continue;
    const pdi = (smPlus[i] / smTR[i]) * 100;
    const mdi = (smMinus[i] / smTR[i]) * 100;
    dx[i] = (pdi + mdi) === 0 ? 0 : Math.abs(pdi - mdi) / (pdi + mdi) * 100;
  }
  const cleaned = dx.map(v => v == null ? 0 : v);
  return wilderSmooth(cleaned, period).map((v, i) => dx[i] == null ? null : v);
}

export function stochastic(highs, lows, closes, period = 14, smoothK = 3, smoothD = 3) {
  const rawK = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const h = Math.max(...highs.slice(i - period + 1, i + 1));
    const l = Math.min(...lows.slice(i - period + 1, i + 1));
    rawK[i] = h === l ? 50 : ((closes[i] - l) / (h - l)) * 100;
  }
  const kFilled = rawK.map(v => v == null ? 0 : v);
  const k = sma(kFilled, smoothK).map((v, i) => rawK[i] == null ? null : v);
  const kFilled2 = k.map(v => v == null ? 0 : v);
  const d = sma(kFilled2, smoothD).map((v, i) => k[i] == null ? null : v);
  return { k, d };
}

export function vwap(highs, lows, closes, volumes) {
  let cumPV = 0, cumV = 0;
  return closes.map((c, i) => {
    const typical = (highs[i] + lows[i] + c) / 3;
    cumPV += typical * volumes[i];
    cumV += volumes[i];
    return cumV === 0 ? null : cumPV / cumV;
  });
}

export function donchian(highs, lows, period = 20) {
  const upper = new Array(highs.length).fill(null);
  const lower = new Array(lows.length).fill(null);
  for (let i = period - 1; i < highs.length; i++) {
    upper[i] = Math.max(...highs.slice(i - period + 1, i + 1));
    lower[i] = Math.min(...lows.slice(i - period + 1, i + 1));
  }
  return { upper, lower };
}

// Paired-deletion: a non-finite x[i]/y[i] (should be impossible now that
// every kline source is sanitized at the boundary, see proxy-server's
// sanitizeOhlcv — but this is the correlation matrix's own last line of
// defense against ever rendering literal "NaN" text in the UI) drops just
// that one pair instead of poisoning every running sum for the rest of the
// series the way plain addition of a NaN/Infinity would.
export function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0, count = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i], yi = y[i];
    if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
    sx += xi; sy += yi; sxy += xi * yi; sx2 += xi * xi; sy2 += yi * yi; count++;
  }
  if (count < 3) return null;
  const num = count * sxy - sx * sy;
  const den = Math.sqrt((count * sx2 - sx * sx) * (count * sy2 - sy * sy));
  if (den === 0 || !Number.isFinite(den)) return null;
  const r = num / den;
  return Number.isFinite(r) ? r : null;
}

export function pctChanges(closes) {
  // Filters non-finite closes first rather than computing through them —
  // same defense-in-depth reasoning as pearson() above.
  const clean = closes.filter((v) => Number.isFinite(v));
  const out = [];
  for (let i = 1; i < clean.length; i++) out.push((clean[i] - clean[i - 1]) / clean[i - 1]);
  return out;
}

export function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

export function trendLabel(closes) {
  const e20 = last(ema(closes, 20)), e50 = last(ema(closes, 50));
  const c = last(closes);
  if (e20 == null || e50 == null) return 'flat';
  if (c > e20 && e20 > e50) return 'bull';
  if (c < e20 && e20 < e50) return 'bear';
  return 'flat';
}

// deterministic pseudo-random walk fallback for sources without free CORS-open history
export function simulateKlines(symbol, count = 200, basePrice) {
  let seed = 0;
  for (let i = 0; i < symbol.length; i++) seed = (seed * 31 + symbol.charCodeAt(i)) >>> 0;
  const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed / 4294967295); };
  let price = basePrice || (50 + rand() * 100);
  const closes = [], highs = [], lows = [], opens = [], volumes = [];
  for (let i = 0; i < count; i++) {
    const open = price;
    const drift = (rand() - 0.5) * price * 0.006;
    const close = Math.max(open + drift, 0.0001);
    const high = Math.max(open, close) + rand() * price * 0.002;
    const low = Math.min(open, close) - rand() * price * 0.002;
    opens.push(open); closes.push(close); highs.push(high); lows.push(low);
    volumes.push(1000 + rand() * 5000);
    price = close;
  }
  return { opens, closes, highs, lows, volumes };
}
