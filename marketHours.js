// Market session hours, for gating anything that must only act on a live,
// actually-trading market (currently: the automated alert stream).
//
// Why this exists: a "did we get real data?" check is NOT the same question
// as "is the market open?". The FX proxy chain (Yahoo -> TwelveData ->
// Alpha Vantage) happily returns genuine last-session candles on a Sunday —
// real data, correctly marked source:'live', but describing a market that
// closed on Friday. Running breakout/crossover detection over those static
// candles re-fires the same signals as if they were happening now. So the
// alert gate needs a calendar, not just a data-quality flag.
//
// DST is handled by delegating to Intl/ICU with an IANA zone rather than
// doing UTC-offset arithmetic: FX rolls over at 17:00 *New York time*, which
// is 21:00 UTC in summer and 22:00 UTC in winter. Hardcoding either offset
// is wrong for half the year, and the changeover dates differ between the US
// and EU. Asking Intl for the wall-clock time in America/New_York sidesteps
// the whole problem — the platform's tz database is the source of truth.

const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MINUTES_PER_DAY = 1440;

// Minutes elapsed since Sunday 00:00 *in the given IANA zone*. Collapsing
// weekday+hour+minute into one number makes the session windows plain range
// comparisons instead of nested day/time conditionals.
export function zonedWeekMinutes(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(timestamp));
  const get = (type) => {
    const p = parts.find((x) => x.type === type);
    return p ? p.value : null;
  };
  const dow = DAY_INDEX[get('weekday')];
  if (dow === undefined) throw new Error(`unexpected weekday from Intl: ${get('weekday')}`);
  // Some ICU builds render midnight as "24" under hour12:false rather than
  // "00"; normalise so 24:00 Sunday doesn't land in Monday's range.
  let hour = parseInt(get('hour'), 10) % 24;
  const minute = parseInt(get('minute'), 10);
  return dow * MINUTES_PER_DAY + hour * 60 + minute;
}

const SUNDAY_OPEN = 17 * 60; // 17:00 local on Sunday, both calendars below

// Spot FX: continuous from Sunday 17:00 ET to Friday 17:00 ET (the 5pm New
// York rollover that defines the FX trading day).
const FX = {
  timeZone: 'America/New_York',
  open: SUNDAY_OPEN,
  close: 5 * MINUTES_PER_DAY + 17 * 60, // Friday 17:00 ET
};

// COMEX gold: Sunday 17:00 CT to Friday 16:00 CT, with a 60-minute
// maintenance break at 16:00-17:00 CT ahead of each new session.
const METAL = {
  timeZone: 'America/Chicago',
  open: SUNDAY_OPEN,
  close: 5 * MINUTES_PER_DAY + 16 * 60, // Friday 16:00 CT
  dailyBreak: { from: 16 * 60, to: 17 * 60, days: [1, 2, 3, 4] },
};

// Which calendar a symbol trades on. Crypto is deliberately absent — it has
// no session concept, so it never consults a calendar at all.
export function calendarFor(symbolType, symbolId) {
  if (symbolType === 'crypto') return null;
  if (symbolId === 'XAUUSD') return METAL;
  return FX;
}

// The gate. `symbolType` is the dashboard's own 'crypto' | 'fx' tag;
// `symbolId` distinguishes XAUUSD (metals calendar) from the FX majors.
// Returns true for crypto unconditionally — 24/7, no maintenance windows on
// any of the four exchanges in the failover chain (Kraken/Bitstamp/Gemini/
// Binance all run continuous books; scheduled maintenance is handled by the
// existing provider-failover path, not by a calendar).
export function isMarketOpen(symbolType, symbolId, timestamp = Date.now()) {
  const cal = calendarFor(symbolType, symbolId);
  if (!cal) return true;
  const wm = zonedWeekMinutes(timestamp, cal.timeZone);
  if (wm < cal.open || wm >= cal.close) return false;
  if (cal.dailyBreak) {
    const dow = Math.floor(wm / MINUTES_PER_DAY);
    const timeOfDay = wm % MINUTES_PER_DAY;
    if (cal.dailyBreak.days.includes(dow) && timeOfDay >= cal.dailyBreak.from && timeOfDay < cal.dailyBreak.to) {
      return false;
    }
  }
  return true;
}
