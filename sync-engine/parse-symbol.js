/**
 * Symbol parser — extracts structured fields from option symbols.
 *
 * Handles three formats in priority order:
 * 1. OCC format (Schwab positions):   COPX  270115C00105000
 * 2. Schwab native (transactions):     SPXW_040224C5245
 * 3. Description-string fallback:      "AAPL Jan 2027 150 Call"
 * 4. Plain equity:                     QQQ, NVDA
 *
 * Returns { underlying, instrumentType, putCall, strike, expiry, multiplier }
 */

const MONTHS = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
  JANUARY: '01', FEBRUARY: '02', MARCH: '03', APRIL: '04',
  JUNE: '06', JULY: '07', AUGUST: '08', SEPTEMBER: '09',
  OCTOBER: '10', NOVEMBER: '11', DECEMBER: '12',
};

function equityResult(symbol) {
  return {
    underlying: symbol,
    instrumentType: 'equity',
    putCall: null,
    strike: null,
    expiry: null,
    multiplier: 1,
  };
}

/**
 * OCC format: COPX  270115C00105000
 * Underlying: left-padded to 6 chars, trimmed. Date: YYMMDD. C/P. Strike: 8 digits / 1000.
 */
function parseOCC(symbol) {
  // OCC: 1-6 char underlying (space-padded to 6), then YYMMDD, then C/P, then 8-digit strike
  const match = symbol.match(/^([A-Z]{1,6})\s+(\d{6})([CP])(\d{8})$/);
  if (!match) return null;

  const [, underlying, dateStr, cp, strikeStr] = match;
  const yy = dateStr.slice(0, 2);
  const mm = dateStr.slice(2, 4);
  const dd = dateStr.slice(4, 6);
  const year = parseInt(yy) > 50 ? `19${yy}` : `20${yy}`;

  return {
    underlying: underlying.trim(),
    instrumentType: 'option',
    putCall: cp === 'C' ? 'call' : 'put',
    strike: parseInt(strikeStr) / 1000,
    expiry: `${year}-${mm}-${dd}`,
    multiplier: 100,
  };
}

/**
 * Schwab native: SPXW_040224C5245
 * Underlying: before _, strip trailing W for index options. Date: MMDDYY. C/P. Strike: digits after.
 */
function parseSchwabNative(symbol) {
  const match = symbol.match(/^([A-Z]+)_(\d{6})([CP])(\d+)$/);
  if (!match) return null;

  const [, rawUnderlying, dateStr, cp, strikeStr] = match;
  // Strip trailing W for index weeklys (SPXW→SPX, NDXW→NDX)
  const underlying = rawUnderlying.replace(/W$/, '');
  const mm = dateStr.slice(0, 2);
  const dd = dateStr.slice(2, 4);
  const yy = dateStr.slice(4, 6);
  const year = parseInt(yy) > 50 ? `19${yy}` : `20${yy}`;

  return {
    underlying,
    instrumentType: 'option',
    putCall: cp === 'C' ? 'call' : 'put',
    strike: parseFloat(strikeStr),
    expiry: `${year}-${mm}-${dd}`,
    multiplier: 100,
  };
}

/**
 * Description-string fallback: "AAPL Jan 2027 150 Call"
 * Parses human-readable name field when symbol format is unrecognized.
 */
function parseDescription(description) {
  if (!description) return null;

  // Pattern: TICKER Month Year Strike Call/Put
  const match = description.match(
    /^([A-Z]{1,6})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})\s+\$?(\d+(?:\.\d+)?)\s+(Call|Put)$/i
  );
  if (!match) return null;

  const [, underlying, monthStr, yearStr, strikeStr, cpStr] = match;
  const monthKey = monthStr.toUpperCase().slice(0, 3);
  const mm = MONTHS[monthKey];
  if (!mm) return null;

  return {
    underlying: underlying.toUpperCase(),
    instrumentType: 'option',
    putCall: cpStr.toLowerCase(),
    strike: parseFloat(strikeStr),
    // Description format only gives month/year — use last day of month as expiry
    expiry: `${yearStr}-${mm}-01`,
    multiplier: 100,
  };
}

/**
 * Parse a symbol (and optional description) into structured fields.
 *
 * @param {string} symbol - The ticker or option symbol
 * @param {string} [description] - Human-readable name (fallback for browser-scraped data)
 * @returns {{ underlying: string, instrumentType: string, putCall: string|null, strike: number|null, expiry: string|null, multiplier: number }}
 */
function parseSymbol(symbol, description) {
  if (!symbol) {
    // Try description-only parsing
    const descResult = parseDescription(description);
    if (descResult) return descResult;
    return equityResult('UNKNOWN');
  }

  const trimmed = symbol.trim();

  // 1. OCC format (spaces in symbol indicate OCC padding)
  if (/\s/.test(trimmed) && /[CP]\d{8}$/.test(trimmed)) {
    const occ = parseOCC(trimmed);
    if (occ) return occ;
  }

  // 2. Schwab native format (underscore separator)
  if (trimmed.includes('_')) {
    const schwab = parseSchwabNative(trimmed);
    if (schwab) return schwab;
  }

  // 3. Description-string fallback
  const descResult = parseDescription(description);
  if (descResult) return descResult;

  // 4. Plain equity
  return equityResult(trimmed);
}

module.exports = { parseSymbol };
