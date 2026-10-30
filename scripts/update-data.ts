#!/usr/bin/env bun
/// <reference types="bun" />
import { readFile as outputReadFile, readdir as outputReadDir } from 'node:fs/promises';
import { createHash as outputCreateHash } from 'node:crypto';
import { join as outputJoin } from 'node:path';
import { fileURLToPath as outputFileURLToPath } from 'node:url';

// Console presentation; no changes to provider requests or persisted data.
/** Presentation only: no requests, writes, filtering, or changes to updater state. */

const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
/** Presentation only: per-fund retry and fallback notices are printed when VERBOSE is enabled. */
const outputVerbose = (): boolean => /^(1|true|yes|on)$/i.test((globalThis as any).process?.env?.VERBOSE ?? '');
function outputNote(message: string): void { if (outputVerbose()) console.warn(message); }
/** Names are the canonical environment knobs, not internal parser properties. */
function outputConfigEntries(config: Record<string, any>): [string, string][] {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    requestSleepSeconds: 'REQUEST_SLEEP', categories: 'CATEGORY',
    aumRange: 'AUM', terRange: 'TER', dividendYieldRange: 'DIVIDEND_YIELD', secYieldRange: 'SEC_YIELD',
    performanceRanges: 'PERFORMANCE', totalReturnRanges: 'TOTAL_RETURN',
    skipVanEck: 'SKIP_VANECK', skipProShares: 'SKIP_PROSHARES',
    skipWisdomTree: 'SKIP_WISDOMTREE', skipGoldmanSachs: 'SKIP_GOLDMANSACHS',
    skipGlobalX: 'SKIP_GLOBALX', skipNorthernTrust: 'SKIP_NORTHERNTRUST',
  };
  const range = (v: any): string => typeof v === 'string' ? v : v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    if (['proxyGapMs', 'fetchTimeoutMs', 'retryDelayMs'].includes(key)) continue;
    const name = aliases[key] ?? (/^[A-Z0-9_]+$/.test(key) ? key : key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
    if (name === 'PERFORMANCE' || name === 'TOTAL_RETURN') {
      for (const period of ['YTD', '1Y', '3Y', '5Y', '10Y']) values.set(`${name}_${period}`, range(value?.[period]));
    } else if (['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD'].includes(name)) {
      values.set(name, range(value));
    } else {
      values.set(name, value instanceof Set ? [...value].join(',') || 'all' : Array.isArray(value) ? value.join(',') || 'all' : outputClean(value));
    }
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return [...values].sort(([a], [b]) => {
    const ai = first.indexOf(a), bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}
function outputConfigValue(key: string, value: string): string {
  if (/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key)) return '<redacted>';
  if (key === 'TICKERS' && ['', 'null', 'undefined'].includes(value)) return 'all';
  return outputClean(value);
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${outputConfigValue(key, value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
function outputStable(value: any): any {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, outputStable(value[key])]));
  return value;
}
function outputContentKey(value: unknown): string { return JSON.stringify(outputStable(value)) ?? 'null'; }
async function outputInspectFund(root: URL | string, ticker: string): Promise<{ digest: string; meta: any }> {
  const dir = outputJoin(root instanceof URL ? outputFileURLToPath(root) : root, 'funds', ticker);
  const hash = outputCreateHash('sha256');
  async function visit(path: string): Promise<void> {
    const entries = await outputReadDir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await visit(outputJoin(path, entry.name));
      else if (entry.name.endsWith('.json')) {
        const text = await outputReadFile(outputJoin(path, entry.name), 'utf8').catch(() => '');
        hash.update(outputJoin(path.slice(dir.length), entry.name));
        try { hash.update(outputContentKey(JSON.parse(text))); } catch { hash.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await outputReadFile(outputJoin(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  return { digest: hash.digest('hex'), meta };
}
const outputCount = (value: any): unknown => typeof value === 'number' ? value : Array.isArray(value) ? value.length : value?.totalRows ?? value?.rows?.length ?? null;
const outputScalar = (value: any): any => value && typeof value === 'object' ? value.display ?? value.value ?? null : value;
const outputUnits: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, THOUSAND: 1e3, MILLION: 1e6, BILLION: 1e9, TRILLION: 1e12 };
function outputMoney(value: any): string {
  const raw = value && typeof value === 'object' && typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)(K|M|B|T|Thousand|Million|Billion|Trillion)?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * (outputUnits[match[2]?.toUpperCase() ?? ''] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
/** Yields: rounded to 2 decimals without trailing zeros; placeholders are omitted like null. */
function outputPercent(value: any): unknown {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Number(raw.toFixed(2)) : null;
  const text = String(raw).trim().replace(/%$/, '').trim();
  if (['', '-', '—', '--', 'n/a'].includes(text.toLowerCase())) return null;
  const number = Number(text.replace(/,/g, ''));
  return Number.isFinite(number) ? Number(number.toFixed(2)) : outputClean(raw);
}
function outputFundLine(index: number, total: number, ticker: string, status: string, data: any = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = data.metrics ?? {};
  // Presentation only. Keep valid zero/false values; omit unavailable fields.
  // outputMoney returns the string 'null' for an unavailable monetary value.
  const field = (key: string, value: unknown): string =>
    value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const sources = [
    field('official', data.officialHistoryCount),
    field('yahoo', data.yahooHistoryCount),
  ].filter(part => part !== '').join(' ');
  const detail = [
    field('port', data.portId ?? data.portfolioId),
    field('history', outputCount(data.history ?? data.historyCount)),
    sources ? `(${sources})` : '',
    field('holdings', outputCount(data.holdings ?? data.holdingsCount)),
    field('divs', outputCount(data.worksheets?.Distributions ?? data.distributions)),
    field('netAssets', outputMoney(data.netAssets ?? data.aum)),
    field('total', outputMoney(data.totalFundNetAssets ?? data.totalNetAssets)),
    field('div', outputPercent(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputPercent(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${`${String(index).padStart(width)}/${total}`.padEnd(8)} ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  const tally = new Map<string, number>();
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      const final = status ?? (before.digest === after.digest ? 'unchanged' : 'updated');
      tally.set(final, (tally.get(final) ?? 0) + 1);
      console.log(outputFundLine(++completed, total, ticker, final, { ...after.meta, ...extra }, reason));
    },
    /** First [ done ] line: the statuses of every fund line this reporter printed. */
    summary(startedAt: number): string {
      const order = ['updated', 'unchanged', 'kept', 'skipped', 'failed'];
      const statuses = [...order, ...[...tally.keys()].filter(status => !order.includes(status))];
      return `[ done     ] ${completed} fund${completed === 1 ? '' : 's'}: ${statuses.map(status => `${tally.get(status) ?? 0} ${status}`).join(', ')} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    },
  };
}
/** Second [ done ] line: published totals. */
function outputCounts(funds: number, holdings: number, history: number): string {
  return `[ done     ] counts: ${funds.toLocaleString('en-US')} funds / ${holdings.toLocaleString('en-US')} holdings rows / ${history.toLocaleString('en-US')} history rows`;
}

/**
 * @file NEOS static feed updater.
 *
 * Zero runtime dependencies: `node:fs/promises` + global `fetch` only, run with
 * Bun. Writes the deterministic `api/neos/**` tree the browser app reads.
 *
 * Source ladder:
 *   (a) official neosfunds.com ETF lineup table ..... fund universe, name,
 *       (`#explore-etfs` → `#etf-table`)              category grouping,
 *                                                     declared frequency,
 *                                                     distribution rate,
 *                                                     30-day SEC yield,
 *                                                     management fee,
 *                                                     net assets, inception
 *   (b) official per-fund page ...................... Fund Details (CUSIP, ISIN,
 *       (`https://neosfunds.com/<ticker>/`)            NAV, market price, daily
 *                                                      change, exchange, net
 *                                                      assets, shares
 *                                                      outstanding), the
 *                                                      Distribution Information
 *                                                      block, the Distribution
 *                                                      History calendar, the
 *                                                      monthly/quarterly
 *                                                      performance tables, the
 *                                                      "Growth of $10,000 at NAV"
 *                                                      daily index and the
 *                                                      document links
 *   (c) official daily full-holdings CSV ............ every position, market
 *       (admin-ajax download_holdings_csv)             value, weight, net assets
 *   (d) SEC EDGAR Form N-PORT-P ..................... holdings fallback only
 *       (NEOS ETF Trust CIK 0001848758)                (EDGAR_FALLBACK=1)
 *   (e) Yahoo Finance chart API ..................... daily Close / Adj Close /
 *                                                      Volume, and the dividend
 *                                                      history as a fallback
 *   (f) browser N-PORT dropzone ..................... user-supplied override
 *
 * The neosfunds.com endpoints are the issuer's own public downloads: the ETF
 * lineup table is server-rendered, the per-fund page carries every headline
 * figure, and `admin-ajax.php?action=download_holdings_csv&ticker=<T>` returns
 * the same CSV the site's own "Download Full Holdings" button hands a visitor.
 * Nothing is scraped from a client-rendered widget and no value is invented:
 * a metric NEOS does not publish stays `null` and the app renders `—`.
 */
import { appendFile, mkdir, readFile, readdir, writeFile, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- TLS trust store (identical in every ETF repo) ---
const SYSTEM_CA_MARKER = 'ETF_UPDATER_SYSTEM_CA';
const CERT_ERROR = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to get (?:local )?issuer certificate|self[- ]signed certificate|certificate has expired/i;

export function isCertError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  return CERT_ERROR.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`) || (e?.cause ? isCertError(e.cause) : false);
}

export function systemCaActive(env: Record<string, string | undefined> = process.env, execArgv: string[] = process.execArgv): boolean {
  return execArgv.includes('--use-system-ca') || env.NODE_USE_SYSTEM_CA === '1' || env[SYSTEM_CA_MARKER] === '1';
}

export function reexecWithSystemCa(): never {
  const child = Bun.spawnSync([process.execPath, '--use-system-ca', ...process.argv.slice(1)], {
    env: { ...process.env, [SYSTEM_CA_MARKER]: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}

/** mode: auto (restart once on an untrusted-certificate error), true (restart now), false (never). */
export function installSystemCa(mode: string, reexec: () => never = reexecWithSystemCa, active: boolean = systemCaActive()): void {
  if (mode === 'false' || active) return;
  if (mode === 'true') reexec();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await realFetch(...args); }
    catch (error) {
      if (!isCertError(error)) throw error;
      console.error('[ notice   ] TLS certificate not trusted; restarting once with --use-system-ca');
      return reexec();
    }
  }) as typeof fetch;
}

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let API_ROOT = path.join(REPO_ROOT, 'api', 'neos');
/** Tests point the updater at a temporary feed directory. */
export function setApiRootForTests(dir: string): void {
  API_ROOT = dir;
}

export const NEOS_SITE = 'https://neosfunds.com';
export const NEOS_LINEUP_URL = `${NEOS_SITE}/#explore-etfs`;
export const NEOS_ADMIN_AJAX_URL = `${NEOS_SITE}/wp-admin/admin-ajax.php`;
/** NEOS ETF Trust — the registrant that files Form N-PORT-P for the ETFs (Investment Company Act file 811-23645). */
export const NEOS_ETF_TRUST_CIK = '0001848758';
export const NEOS_ETF_TRUST_FILE_NUMBER = '811-23645';

/** Canonical slug for a fund page. Every NEOS fund page is the lowercase ticker. */
export function neosFundPageUrl(ticker: string): string {
  return `${NEOS_SITE}/${sanitizeTicker(ticker).toLowerCase()}/`;
}

/**
 * The official daily holdings download behind the fund page's
 * "Download Full Holdings" button. `etf-pages.js` builds exactly this URL
 * (`${etf_ajax.ajax_url}?action=download_holdings_csv&ticker=${ticker}`) and
 * saves it as `NEOS Holdings - <TICKER> Holdings.csv`.
 */
export function neosHoldingsCsvUrl(ticker: string): string {
  return `${NEOS_ADMIN_AJAX_URL}?action=download_holdings_csv&ticker=${sanitizeTicker(ticker)}`;
}

export function neosProvenanceHoldingsUrl(ticker: string): string {
  return `${NEOS_ADMIN_AJAX_URL}?action=download_holdings_csv&ticker=${sanitizeTicker(ticker)}`;
}

export const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

/**
 * Explicit period1/period2 (Yahoo ignores `range` when period1=0). HISTORY_RANGE is
 * `max` (period1=0) or `Ny` (N * 365.25 days before `nowMs`).
 */
export function yahooChartUrl(ticker: string, range: string = 'max', nowMs: number = Date.now()): string {
  const clean = sanitizeTicker(ticker);
  const period2 = Math.floor(nowMs / 1000);
  const years = /^(\d+)y$/i.exec(range.trim());
  if (!years && range.trim().toLowerCase() !== 'max') throw new Error(`HISTORY_RANGE: expected max or Ny, received "${range}"`);
  const period1 = years ? Math.max(0, Math.floor(period2 - Number(years[1]) * 365.25 * 86_400)) : 0;
  return `${YAHOO_CHART_URL}/${encodeURIComponent(clean)}?period1=${period1}&period2=${period2}` +
    '&interval=1d&events=div%7Csplit&includeAdjustedClose=true';
}

export function yahooChartProvenanceUrl(ticker: string): string {
  return `${YAHOO_CHART_URL}/${encodeURIComponent(sanitizeTicker(ticker))}?period1=0&period2=9999999999&interval=1d&events=div%7Csplit&includeAdjustedClose=true`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function pad3(value: number): string {
  return String(value).padStart(3, '0');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sanitizeTicker(raw: unknown): string {
  return String(raw ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function cleanText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u00ae\u2122]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A cell that reads as missing. KEYS on the normalized text, so `N/A` and `--` behave. */
const MISSING_CELL = new Set(['', '-', '--', '---', '—', '–', 'n/a', 'na', 'none', 'null', 'nan']);

export function isMissingCell(raw: unknown): boolean {
  const text = cleanText(raw).toLowerCase();
  return MISSING_CELL.has(text);
}

/**
 * Expand the scientific notation some providers emit and undo the `$`, `%`,
 * thousands separators and parentheses negatives before parsing.
 * `"2.97E8"` -> `"297057744"`, `"$-201,630.00"` -> `"-201630.00"`.
 */
export function normalizeNumberText(raw: unknown): string {
  let text = cleanText(raw);
  if (!text) return '';
  if (isMissingCell(text)) return '';
  const negativeParentheses = /^\((.*)\)$/.exec(text);
  if (negativeParentheses) text = `-${negativeParentheses[1]}`;
  text = text.replace(/[$,%\s*\u2020\u2021\u2022]/g, '');
  text = text.replace(/([eE])([+-]?\d+)$/, (_m, e: string, exp: string) => `E${exp}`);
  if (/^-?\d*\.?\d+[eE][+-]?\d+$/.test(text)) {
    const parsed = Number(text);
    if (Number.isFinite(parsed)) return String(parsed);
  }
  return text;
}

export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = normalizeNumberText(value);
  if (!text || text === '-' || text === '+') return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  // Some providers emit a denormal sentinel instead of null.
  if (Math.abs(parsed) < 1e-290 && parsed !== 0) return null;
  return parsed;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function formatAumDisplay(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

export function formatMoneyText(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(2)}`;
}

export function formatPercentText(value: number | null, digits = 2): string {
  return value === null ? '—' : `${value.toFixed(digits)}%`;
}

/** `08/29/2022` -> `Aug 29 2022`; ISO and `August 29, 2022` also accepted. */
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function toIsoDate(raw: unknown): string {
  // ISO, U.S. and month-name dates: pure calendar text, the same day in every time zone (shared calendar-dates block)
  return calendarIso(cleanText(raw)) ?? '';
}

/** Which definition stands behind `metrics.dividendYield`: NEOS publishes one figure, its Distribution Rate. */
export type DividendYieldBasis = 'official-distribution-rate';
export const DIVIDEND_YIELD_BASIS: DividendYieldBasis = 'official-distribution-rate';
export function yieldBasisFor(dividendYield: number | null | undefined): DividendYieldBasis | null {
  return typeof dividendYield === 'number' && Number.isFinite(dividendYield) ? DIVIDEND_YIELD_BASIS : null;
}
/** Exhaustive text per code (meta.json `yields.dividendYieldKind`). */
export const YIELD_KIND_BY_BASIS: Record<DividendYieldBasis, string> = {
  'official-distribution-rate': 'official NEOS Distribution Rate (latest distribution annualized / ex-date NAV)',
};
/** Kept index rows (unselected, filtered out, failed, SKIP_NEOS) carry the same key set: the code follows the yield the row holds. */
export function withYieldBasis<T extends object>(entry: T): T { // not `{ metrics?: any }`: that weak type rejects CatalogEntry, which has no `metrics` key
  const old = ((entry as { metrics?: any }).metrics ?? {}) as Record<string, unknown>;
  const metrics: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(old)) {
    if (key === 'dividendYieldBasis') continue;
    metrics[key] = value;
    if (key === 'dividendYieldText') metrics.dividendYieldBasis = yieldBasisFor(old.dividendYield as number | null);
  }
  if (!('dividendYieldBasis' in metrics)) metrics.dividendYieldBasis = yieldBasisFor(old.dividendYield as number | null);
  return { ...entry, metrics };
}

/** Honest label for how `metrics` returns are computed (STANDARD.md 9a). */
export const RETURNS_BASIS = 'official NEOS fund page NAV total returns (month-end Performance table); 3/5/10 Yr cumulative derived from the published annualized figures';

/** ISO date the published returns are as of: the Performance table date (not the NAV date), or null when unknown. */
export function performanceAsOf(tableDate: unknown): string | null {
  return toIsoDate(tableDate) || null;
}

/** `08/29/2022` -> `Aug 29 2022`. Returns the cleaned input when unparseable. */
export function formatNeosDate(raw: unknown): string {
  const iso = toIsoDate(raw);
  if (!iso) return cleanText(raw);
  const [year, month, day] = iso.split('-');
  return `${MONTH_SHORT[Number(month) - 1]} ${day} ${year}`;
}

/** Chronological comparator for the display dates this feed publishes (`Aug 29 2022`). */
export function compareDisplayDates(a: string, b: string): number {
  const left = toIsoDate(a);
  const right = toIsoDate(b);
  if (left && right) return left < right ? -1 : left > right ? 1 : 0;
  return String(a).localeCompare(String(b));
}

export function todayStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type Range = { min: number; max: number };
export type ReturnPeriod = 'YTD' | '1Y' | '3Y' | '5Y' | '10Y';
const RETURN_PERIODS: readonly ReturnPeriod[] = ['YTD', '1Y', '3Y', '5Y', '10Y'];
type RangeMap = Partial<Record<ReturnPeriod, Range>>;

type UpdaterConfig = {
  concurrency: number;
  requestSleep: number;
  maxFetches: number;
  holdingsPageSize: number;
  historyPageSize: number;
  storeRawDownloads: boolean;
  maxRetries: number;
  tickers: string[];
  historyRange: string;
  category: string;
  secUa: string;
  skipYahoo: boolean;
  skipNeos: boolean;
  edgarFallback: boolean;
  aumRange?: Range & { source?: string };
  terRange?: Range;
  dividendYieldRange?: Range;
  secYieldRange?: Range;
  performanceRanges: RangeMap;
  totalReturnRanges: RangeMap;
  /** Test hooks (not controls): per-attempt timeout, retry delay, soft run deadline. */
  timeoutMs?: number;
  retryDelayMs?: number;
  deadlineMs?: number;
};

const AUM_PRESET_BOUNDS = {
  nano: { min: 0, max: 10_000_000 },
  micro: { min: 10_000_000, max: 300_000_000 },
  small: { min: 300_000_000, max: 2_000_000_000 },
  mid: { min: 2_000_000_000, max: 10_000_000_000 },
  large: { min: 10_000_000_000, max: undefined },
} as const;
type AumPreset = keyof typeof AUM_PRESET_BOUNDS;

const AMOUNT_SUFFIXES: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

function envValue(env: Record<string, string | undefined>, name: string, aliases: string[] = []): string {
  for (const key of [name, ...aliases]) {
    const value = env[key];
    if (value !== undefined && value !== '') return String(value).trim();
  }
  return '';
}

function parsePositiveInt(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseNonNegativeFloat(raw: string, fallback: number): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoolean(raw: string, fallback = false): boolean {
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
}

/**
 * Strict `min:max` range. `""` and `":"` mean "no restriction"; percent and `$`
 * signs are optional; exactly one colon is required; a configured min must not
 * exceed max.
 */
export function parseRange(raw: string, label: string): Range | undefined {
  const text = cleanText(raw);
  if (!text || text === ':') return undefined;
  const parts = text.split(':');
  if (parts.length !== 2) {
    throw new Error(`${label}: expected "min:max" with exactly one colon, received "${raw}"`);
  }
  const parseBound = (value: string, side: 'min' | 'max'): number => {
    const cleaned = value.replace(/[$,%\s]/g, '');
    if (!cleaned) return side === 'min' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed)) throw new Error(`${label}: "${value}" is not a number`);
    return parsed;
  };
  const range = { min: parseBound(parts[0], 'min'), max: parseBound(parts[1], 'max') };
  if (range.min > range.max) throw new Error(`${label}: min ${range.min} is greater than max ${range.max}`);
  return range;
}

function parseAumBound(bound: string): number | undefined {
  const cleaned = bound.replace(/[$,\s]/g, '');
  if (!cleaned) return undefined;
  const preset = AUM_PRESET_BOUNDS[cleaned.toLowerCase() as AumPreset];
  if (preset) return preset.min;
  const match = /^(-?\d+(?:\.\d+)?)([KMBT])?$/i.exec(cleaned);
  if (!match) throw new Error(`AUM: "${bound}" is not an amount, a K/M/B/T suffix or a preset`);
  const base = Number(match[1]);
  const suffix = match[2] ? AMOUNT_SUFFIXES[match[2].toUpperCase()] : 1;
  return base * suffix;
}

export function parseAumRange(raw: string): (Range & { source?: string }) | undefined {
  const text = cleanText(raw);
  if (!text || text === ':') return undefined;
  const presetOnly = AUM_PRESET_BOUNDS[text.toLowerCase() as AumPreset];
  // A bare preset (`AUM=micro`) is the whole range, exactly as in the siblings.
  if (presetOnly) return { min: presetOnly.min, max: presetOnly.max ?? Number.POSITIVE_INFINITY, source: raw };
  const parts = text.split(':');
  if (parts.length !== 2) throw new Error(`AUM: expected "min:max" with exactly one colon, received "${raw}"`);

  const leftPreset = AUM_PRESET_BOUNDS[parts[0].replace(/[$,\s]/g, '').toLowerCase() as AumPreset];
  const rightPreset = AUM_PRESET_BOUNDS[parts[1].replace(/[$,\s]/g, '').toLowerCase() as AumPreset];

  let min = parseAumBound(parts[0]);
  let max: number | undefined;
  if (rightPreset && !/\d/.test(parts[1])) {
    // A preset on the right contributes its exclusive upper bound; `large` has none.
    max = rightPreset.max;
  } else {
    max = parseAumBound(parts[1]);
  }
  if (leftPreset && !/\d/.test(parts[0])) min = leftPreset.min;
  const range = {
    min: min ?? Number.NEGATIVE_INFINITY,
    max: max ?? Number.POSITIVE_INFINITY,
    source: raw,
  };
  if (range.min > range.max) throw new Error(`AUM: min ${range.min} is greater than max ${range.max}`);
  return range;
}

function parseRanges(env: Record<string, string | undefined>, prefix: 'PERFORMANCE' | 'TOTAL_RETURN'): RangeMap {
  const ranges: RangeMap = {};
  for (const period of RETURN_PERIODS) {
    const raw = envValue(env, `${prefix}_${period}`);
    if (!raw) continue;
    const range = parseRange(raw, `${prefix}_${period}`);
    if (range) ranges[period] = range;
  }
  return ranges;
}

const SEC_UA_DEFAULT = 'daggerok ETF feed daggerok@gmail.com';

export function readConfig(env: Record<string, string | undefined> = process.env): UpdaterConfig {
  return {
    concurrency: parsePositiveInt(envValue(env, 'CONCURRENCY'), 2),
    requestSleep: parseNonNegativeFloat(envValue(env, 'REQUEST_SLEEP'), 1.5),
    maxFetches: parseNonNegativeInt(envValue(env, 'MAX_FETCHES'), 0),
    holdingsPageSize: parsePositiveInt(envValue(env, 'HOLDINGS_PAGE_SIZE'), 250),
    historyPageSize: parsePositiveInt(envValue(env, 'HISTORY_PAGE_SIZE', ['HISTORICAL_PAGE_SIZE']), 1000),
    storeRawDownloads: parseBoolean(envValue(env, 'STORE_RAW_DOWNLOADS')),
    maxRetries: parsePositiveInt(envValue(env, 'MAX_RETRIES'), 3),
    tickers: envValue(env, 'TICKERS')
      .split(/[\s,;]+/)
      .map(sanitizeTicker)
      .filter(Boolean),
    historyRange: envValue(env, 'HISTORY_RANGE') || 'max',
    category: cleanText(envValue(env, 'CATEGORY')),
    secUa: envValue(env, 'SEC_UA') || SEC_UA_DEFAULT,
    skipYahoo: parseBoolean(envValue(env, 'SKIP_YAHOO')),
    skipNeos: parseBoolean(envValue(env, 'SKIP_NEOS')),
    edgarFallback: parseBoolean(envValue(env, 'EDGAR_FALLBACK'), true),
    aumRange: parseAumRange(envValue(env, 'AUM')),
    terRange: parseRange(envValue(env, 'TER'), 'TER'),
    dividendYieldRange: parseRange(envValue(env, 'DIVIDEND_YIELD'), 'DIVIDEND_YIELD'),
    secYieldRange: parseRange(envValue(env, 'SEC_YIELD'), 'SEC_YIELD'),
    performanceRanges: parseRanges(env, 'PERFORMANCE'),
    totalReturnRanges: parseRanges(env, 'TOTAL_RETURN'),
  };
}

const USAGE = `
NEOS ETF static feed updater (zero dependencies, run with Bun).

  bun ./scripts/update-data.ts [-h|--help]

Defaults live in scripts/update-data.config.json (flat object, string values).
Precedence: config file < workflow advanced JSON < nonblank workflow inputs <
environment variable. Defaults below are the checked-in file values.

  MAX_FETCHES          0     Funds to process. 0 = full pass. A positive value
                             resumes after the committed cursor in
                             api/neos/update-state.json.
  REQUEST_SLEEP        2     Minimum seconds between request starts.
                             neosfunds.com throttles bursts with an SSL reset,
                             so keep this at 1.5s or more.
  CONCURRENCY          2     Parallel fund workers (starts stay globally paced).
  MAX_RETRIES          3     Retries (>= 1) for network errors and 408/425/429/5xx.
  TICKERS              ""    Space/comma separated tickers. ANDed with the other
                             filters, never overriding them.
  CATEGORY             ""    Keep only this NEOS asset-class heading.
  AUM                  :     "min:max" dollars, K/M/B/T suffixes, or a preset:
                             nano <$10M | micro $10M-$300M | small $300M-$2B |
                             mid $2B-$10B | large >=$10B
  TER                  :     "min:max" expense ratio percent.
  DIVIDEND_YIELD       :     "min:max" distribution-rate percent.
  SEC_YIELD            :     "min:max" 30-day SEC yield percent.
  PERFORMANCE_YTD|1Y|3Y|5Y|10Y   "min:max" official fund-page NAV return percent.
  TOTAL_RETURN_YTD|1Y|3Y|5Y|10Y  "min:max" derived cumulative total return percent.
  HOLDINGS_PAGE_SIZE   250   Rows per holdings page file.
  HISTORY_PAGE_SIZE    1000  Rows per history page file (alias
                             HISTORICAL_PAGE_SIZE).
  HISTORY_RANGE        max   Yahoo chart range used for daily history
                             ("max", "10y", "5y", ...).
  STORE_RAW_DOWNLOADS  false 1|true|yes|y|on writes api/neos/raw/**.
  SEC_UA               "daggerok ETF feed daggerok@gmail.com"
                             Declared User-Agent for SEC EDGAR requests
                             (redacted in config logs; blank uses this value).
  EDGAR_FALLBACK       true  Use Form N-PORT-P when a fund has no holdings CSV.
  SKIP_YAHOO           false Skip Yahoo Finance (daily history, dividend fallback).
  SKIP_NEOS            false Skip neosfunds.com entirely (keeps committed data).
  VERBOSE              false Print per-fund retry and fallback notices.
  USE_SYSTEM_CA        auto  auto|true|false. auto restarts once with Bun's --use-system-ca
                             on an untrusted-certificate error; true always uses the
                             system CA store; false never restarts.

Range syntax is strict "min:max" with exactly one colon; "" and ":" mean no
restriction; a configured min must not exceed max.

Examples:

  TICKERS="SPYI QQQI CSHI" bun ./scripts/update-data.ts
  MAX_FETCHES=5 bun ./scripts/update-data.ts
  AUM="1B:" TER=":0.70" bun ./scripts/update-data.ts
  CATEGORY="Fixed Income" bun ./scripts/update-data.ts
`;

// ---------------------------------------------------------------------------
// Politeness & fetching
// ---------------------------------------------------------------------------

// One pacing lane per concurrent worker. The slot is reserved synchronously (before
// any await), so N simultaneous callers get N distinct lanes instead of all picking
// the same one; each lane starts a request at most every REQUEST_SLEEP seconds.
let lastRequestAtLanes: number[] = [0];

/** Reserve the earliest slot: returns the lane and the time its request may start. Pure apart from mutating `lanes`. */
export function reserveSlot(lanes: number[], gapMs: number, now: number): { lane: number; startAt: number } {
  let lane = 0;
  for (let i = 1; i < lanes.length; i += 1) if (lanes[i] < lanes[lane]) lane = i;
  const startAt = Math.max(now, lanes[lane] + gapMs);
  lanes[lane] = startAt;
  return { lane, startAt };
}

async function paceRequests(config: UpdaterConfig): Promise<void> {
  const { startAt } = reserveSlot(lastRequestAtLanes, Math.max(0, config.requestSleep * 1000), Date.now());
  const wait = startAt - Date.now();
  if (wait > 0) await sleep(wait);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Per-attempt budget covering headers AND body. */
export const FETCH_TIMEOUT_MS = 45_000;

/**
 * Fetch and read the body inside the retry loop: a stalled socket, a timeout (AbortSignal)
 * or a retryable status is retried up to MAX_RETRIES times; any other status fails at once.
 */
export async function fetchRetried<T>(
  url: string,
  headers: Record<string, string>,
  config: UpdaterConfig,
  label: string,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    await paceRequests(config);
    try {
      const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(config.timeoutMs ?? FETCH_TIMEOUT_MS) });
      if (response.ok) return await read(response);
      // neosfunds.com answers 403 from its WAF while throttling, and the CSV
      // endpoint answers 200 with an HTML error page when the ticker is unknown.
      if (!RETRY_STATUS.has(response.status) && response.status !== 403) {
        throw Object.assign(new Error(`${label}: HTTP ${response.status}`), { permanent: true });
      }
      lastError = new Error(`${label}: HTTP ${response.status}`);
    } catch (error) {
      if ((error as { permanent?: boolean }).permanent) throw error;
      lastError = error;
    }
    if (attempt < config.maxRetries) await sleep(config.retryDelayMs ?? 1500 * (attempt + 1));
  }
  throw new Error(`${label}: ${errorMessage(lastError)}`);
}

export async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  config: UpdaterConfig,
  label: string = url,
): Promise<Response> {
  return fetchRetried(url, headers, config, label, async (response) => response);
}

function browserHeaders(): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

function yahooHeaders(): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json,text/plain,*/*',
  };
}

function secHeaders(config: UpdaterConfig): Record<string, string> {
  return { 'User-Agent': config.secUa, Accept: 'application/json,application/xml,text/html,*/*' };
}

async function fetchText(url: string, headers: Record<string, string>, config: UpdaterConfig, label = url): Promise<string> {
  return fetchRetried(url, headers, config, label, (response) => response.text());
}

async function fetchBytes(url: string, headers: Record<string, string>, config: UpdaterConfig, label = url): Promise<Uint8Array> {
  return fetchRetried(url, headers, config, label, async (response) => new Uint8Array(await response.arrayBuffer()));
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

export function decodeHtmlEntities(text: string): string {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&rsquo;/gi, '’')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&reg;/gi, '')
    .replace(/&trade;/gi, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripTags(fragment: string): string {
  return decodeHtmlEntities(String(fragment ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export type HtmlTable = string[][];

/**
 * Split one `<tr>` into its cell texts.
 *
 * neosfunds.com ships several rows with a MISSING `</td>` (the ticker column of
 * XSPI/XQQI/XBCI/NEHI/MLPI/NLSI and the first cell of the Fund Details table),
 * so cells are cut on `<td` opening tags rather than paired with `</td>`: a
 * regex that requires a closing tag silently merges three columns into one.
 */
export function splitRowCells(rowHtml: string): string[] {
  const cells: string[] = [];
  const openings = [...rowHtml.matchAll(/<(td|th)\b[^>]*>/gi)];
  for (let index = 0; index < openings.length; index += 1) {
    const start = openings[index].index! + openings[index][0].length;
    const end = index + 1 < openings.length ? openings[index + 1].index! : rowHtml.length;
    let chunk = rowHtml.slice(start, end);
    // Drop a trailing closing tag only; a missing one must not swallow the value.
    chunk = chunk.replace(/<\/t[dh]>\s*$/i, '');
    cells.push(stripTags(chunk));
  }
  return cells;
}

export function parseHtmlTables(html: string): HtmlTable[] {
  const tables: HtmlTable[] = [];
  const tablePattern = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  for (const match of html.matchAll(tablePattern)) {
    const rows: HtmlTable = [];
    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    for (const row of match[1].matchAll(rowPattern)) {
      cellsLoop: {
        // An unclosed final row would otherwise be dropped by the row regex, so
        // each row body is additionally scanned for orphan cells.
        const cells = splitRowCells(row[1]);
        if (cells.length) rows.push(cells);
        break cellsLoop;
      }
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

/** The `<table>` whose `id="..."` matches, or null. */
export function tableById(html: string, id: string): HtmlTable | null {
  const pattern = new RegExp(`<table\\b[^>]*id=["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>([\\s\\S]*?)<\\/table>`, 'i');
  const match = pattern.exec(html);
  if (!match) return null;
  const rows: HtmlTable = [];
  for (const row of match[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = splitRowCells(row[1]);
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** Raw `<tr>` HTML of the table whose `id` matches, so markup-level hooks (the ticker CSS class) survive. */
export function tableRowsByIdRaw(html: string, id: string): string[] {
  const pattern = new RegExp(`<table\\b[^>]*id=["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>([\\s\\S]*?)<\\/table>`, 'i');
  const match = pattern.exec(html);
  if (!match) return [];
  return [...match[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => row[1]);
}

/** Text of the first element carrying `id="..."`. */
export function elementTextById(html: string, id: string): string | null {
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*id=["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
  const match = pattern.exec(html);
  return match ? stripTags(match[2]) : null;
}

// ---------------------------------------------------------------------------
// neosfunds.com — ETF lineup (`#explore-etfs`)
// ---------------------------------------------------------------------------

export type LineupFund = {
  ticker: string;
  name: string;
  category: string;
  categoryClass: string;
  frequency: string;
  distributionRate: number | null;
  distributionRateText: string;
  secYield: number | null;
  secYieldText: string;
  managementFee: number | null;
  managementFeeText: string;
  netAssets: number | null;
  netAssetsText: string;
  inceptionDate: string;
  fundPage: string;
};

/**
 * The five NEOS asset-class groups, in the order the website prints them. The
 * tab labels come straight from the provider, so they are listed verbatim.
 */
export const NEOS_CATEGORIES = [
  'Equity High Income',
  'Boosted High Income',
  'High Income Alternatives',
  'Hedged Equity Income',
  'Enhanced Fixed Income',
] as const;

/** Ticker CSS class on the lineup table -> the asset-class heading NEOS prints above the cards. */
const CATEGORY_CLASS_LABELS: Record<string, string> = {
  'ticker-equity-high-income': 'Equity High Income',
  'ticker-enhanced-fixed-income': 'Boosted High Income',
  'ticker-high-income-alternatives': 'High Income Alternatives',
  'ticker-hedged-equity-income': 'Hedged Equity Income',
  'ticker-enhanced-income-treasuries': 'Enhanced Fixed Income',
};

/**
 * Read the server-rendered "Explore Our ETFs" table. Column order is
 * `Ticker | Fund Name | Distribution Frequency | Distribution Rate |
 * 30-Day SEC Yield | Management Fee | Net Assets | Inception Date`, but the rows
 * of the funds whose ticker carries an explicit class are missing their `</td>`
 * separators, which is why `splitRowCells` cuts on opening tags.
 */
export function parseNeosLineup(html: string): LineupFund[] {
  const funds: LineupFund[] = [];
  for (const rowHtml of tableRowsByIdRaw(html, 'etf-table')) {
    if (/<th\b/i.test(rowHtml)) continue; // header row (there are two #etf-table tables)
    const cells = splitRowCells(rowHtml);
    if (cells.length < 8) continue;
    const classMatch = /class=["']ticker\s+([a-z0-9-]+)["']/i.exec(rowHtml);
    const ticker = sanitizeTicker(cells[0]);
    if (!/^[A-Z]{2,6}$/.test(ticker)) continue;
    const inceptionRaw = cells[7] || '';
    // A handful of cells carry a footnote marker (`0.68%*`) whose note is not
    // part of the figure, so the published text is stripped before it is kept.
    const withoutFootnote = (value: string): string => cleanText(value).replace(/\s*[*\u2020\u2021]+$/, '');
    funds.push({
      ticker,
      name: cleanText(cells[1]),
      category: CATEGORY_CLASS_LABELS[classMatch ? classMatch[1] : ''] || '',
      categoryClass: classMatch ? classMatch[1] : '',
      frequency: cleanText(cells[2]),
      distributionRate: numberOrNull(cells[3]),
      distributionRateText: withoutFootnote(cells[3]),
      secYield: numberOrNull(cells[4]),
      secYieldText: withoutFootnote(cells[4]),
      managementFee: numberOrNull(cells[5]),
      managementFeeText: withoutFootnote(cells[5]),
      netAssets: moneyOrNull(cells[6]),
      netAssetsText: withoutFootnote(cells[6]),
      inceptionDate: toIsoDate(inceptionRaw),
      fundPage: neosFundPageUrl(ticker),
    });
  }
  return funds;
}

/**
 * Ticker -> asset-class heading, harvested from the "Explore Our ETFs" cards.
 * The lineup table's own CSS class is a styling hook (XSPI's Boosted fund wears
 * `ticker-enhanced-fixed-income`), so the printed heading is the authority.
 */
export function parseNeosCategoryCards(html: string): Map<string, string> {
  const mapping = new Map<string, string>();
  const anchor = html.indexOf('Explore Our ETFs');
  const section = anchor >= 0 ? html.slice(anchor, anchor + 40000) : html;
  for (const label of NEOS_CATEGORIES) {
    const heading = new RegExp(`<h[34]\\b[^>]*>\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</h[34]>`, 'i');
    const match = heading.exec(section);
    if (!match) continue;
    const rest = section.slice(match.index + match[0].length);
    // Stop at the next category heading so a fund is never claimed twice.
    const nextHeading = rest.search(/<h[34]\b[^>]*>\s*(Equity High Income|Boosted High Income|High Income Alternatives|Hedged Equity Income|Enhanced Fixed Income)\s*</i);
    const block = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
    for (const link of block.matchAll(/href=["']https:\/\/neosfunds\.com\/([a-z0-9]+)\/["']/gi)) {
      const ticker = sanitizeTicker(link[1]);
      if (ticker) mapping.set(ticker, label);
    }
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// neosfunds.com — per-fund page
// ---------------------------------------------------------------------------

export type NeosFundDetails = {
  inceptionDate: string;
  ticker: string;
  cusip: string | null;
  isin: string | null;
  managementFeeText: string | null;
  totalOperatingExpensesText: string | null;
  netAssets: number | null;
  netAssetsText: string | null;
  sharesOutstanding: number | null;
  sharesOutstandingText: string | null;
  primaryExchange: string | null;
  underlyingExposure: string | null;
  distributionFrequency: string | null;
  netAssetValue: number | null;
  netAssetValueText: string | null;
  navDailyChangeValue: number | null;
  navDailyChangePercent: number | null;
  marketPrice: number | null;
  marketPriceText: string | null;
  marketPriceDailyChangeValue: number | null;
  marketPriceDailyChangePercent: number | null;
  /** The fund page's own `Premium Discount (%)` row (published, not derived). */
  premiumDiscount: number | null;
  premiumDiscountText: string | null;
  /** `30-Day Median Bid-Ask Spread (%)`, published by the quote tables. */
  bidAskSpread: number | null;
  bidAskSpreadText: string | null;
  /** `Acquired Fund Fees & Expenses` when the panel itemizes it. */
  acquiredFundFeesText: string | null;
  asOfDate: string;
};

/** `$12,151,808,030` -> 12151808030; `1,234` -> 1234. */
function moneyOrNull(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = cleanText(raw).replace(/[$,]/g, '');
  if (!text || isMissingCell(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The labels the `Fund Details` panel uses. Only these can start a label/value
 * pair, which keeps the reader aligned even when the provider drops a `<tr>`.
 */
const FUND_DETAIL_LABELS = new Set([
  'fund inception',
  'fund ticker',
  'cusip',
  'isin',
  'management fee',
  'acquired fund fees & expenses',
  'total annual fund operating expenses',
  'net assets',
  'shares outstanding',
  'primary exchange',
  'underlying exposure',
  'distribution frequency',
  'net asset value',
  'market price',
  'premium discount (%)',
  'premium / discount',
  '30-day median bid-ask spread (%)',
  'daily change ($)',
  'daily change (%)',
]);

/** The `Fund Details` panel: CUSIP, ISIN, NAV, market price, exchange, share count. */
export function parseNeosFundDetails(html: string): NeosFundDetails {
  const index = html.search(/Fund Details/i);
  const section = index >= 0 ? html.slice(index, index + 20000) : html;
  const asOfMatch = /As of:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(section);
  // The panel's markup is unreliable: one row per page ships without its
  // opening `<tr>` (the `Primary Exchange` row) and the first row of the panel
  // ships without a `</td>`, so label/value pairs are read from the cell
  // stream itself instead of from `<tr>` blocks.
  const pairs: Array<{ label: string; value: string }> = [];
  const cells = [...section.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)(?=<\/?(?:t[dhr]|tbody|thead|table)\b|$)/gi)];
  for (let at = 0; at < cells.length; at += 1) {
    if (cells[at][1].toLowerCase() === 'th') continue; // header cells are not labels
    const label = cleanText(cells[at][2]).replace(/\s*[*\u2020\u2021]+$/, '');
    if (!FUND_DETAIL_LABELS.has(label.toLowerCase())) continue;
    const next = cells[at + 1];
    if (!next || next[1].toLowerCase() === 'th') continue;
    pairs.push({ label, value: stripTags(next[2]) });
  }
  const valueOf = (label: string): string | null => {
    const pair = pairs.find((candidate) => candidate.label.toLowerCase() === label.toLowerCase());
    return pair ? pair.value : null;
  };

  const nav = pairs.find((pair) => /^net asset value$/i.test(pair.label));
  const market = pairs.find((pair) => /^market price$/i.test(pair.label));
  const changeValues = pairs
    .filter((pair) => /^daily change/i.test(pair.label))
    .map((pair) => pair.value);
  const navChange = changeValues.slice(0, 2);
  const marketChange = changeValues.slice(2, 4);

  return {
    inceptionDate: toIsoDate(valueOf('Fund Inception') || ''),
    ticker: sanitizeTicker(valueOf('Fund Ticker') || ''),
    cusip: valueOf('CUSIP'),
    isin: valueOf('ISIN'),
    managementFeeText: valueOf('Management Fee'),
    totalOperatingExpensesText: valueOf('Total Annual Fund Operating Expenses'),
    netAssets: moneyOrNull(valueOf('Net Assets')),
    netAssetsText: valueOf('Net Assets'),
    sharesOutstanding: moneyOrNull(valueOf('Shares Outstanding')),
    sharesOutstandingText: valueOf('Shares Outstanding'),
    primaryExchange: valueOf('Primary Exchange'),
    underlyingExposure: valueOf('Underlying Exposure'),
    distributionFrequency: valueOf('Distribution Frequency'),
    netAssetValue: nav ? moneyOrNull(nav.value) : null,
    netAssetValueText: nav ? nav.value : null,
    navDailyChangeValue: navChange[0] ? moneyOrNull(navChange[0]) : null,
    navDailyChangePercent: navChange[1] ? numberOrNull(navChange[1]) : null,
    marketPrice: market ? moneyOrNull(market.value) : null,
    marketPriceText: market ? market.value : null,
    marketPriceDailyChangeValue: marketChange[0] ? moneyOrNull(marketChange[0]) : null,
    marketPriceDailyChangePercent: marketChange[1] ? numberOrNull(marketChange[1]) : null,
    premiumDiscount: numberOrNull(valueOf('Premium Discount (%)') || valueOf('Premium / Discount')),
    premiumDiscountText: valueOf('Premium Discount (%)') || valueOf('Premium / Discount'),
    bidAskSpread: numberOrNull(valueOf('30-Day Median Bid-Ask Spread (%)')),
    bidAskSpreadText: valueOf('30-Day Median Bid-Ask Spread (%)'),
    acquiredFundFeesText: valueOf('Acquired Fund Fees & Expenses'),
    asOfDate: asOfMatch ? toIsoDate(asOfMatch[1]) : '',
  };
}

export type NeosDistributionInfo = {
  asOfDate: string;
  frequency: string | null;
  managementFeeText: string | null;
  distributionRate: number | null;
  distributionRateText: string | null;
  trailingRate12M: number | null;
  trailingRate12MText: string | null;
  distributionAmount: number | null;
  distributionAmountText: string | null;
  distributionAmountPercent: number | null;
  distributionAmountPercentText: string | null;
  secYield: number | null;
  secYieldText: string | null;
};

/**
 * The "Distribution Information (as of MM/DD/YYYY)" table under the fund page
 * `Distributions` heading. It is a plain two-column label/value table, so it is
 * located by its own header cell rather than by position.
 */
export function parseNeosDistributionInfo(html: string): NeosDistributionInfo | null {
  const tablePattern = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let picked: string | null = null;
  for (const table of html.matchAll(tablePattern)) {
    if (/Distribution Information/i.test(table[1]) && /Distribution Frequency/i.test(table[1])) {
      picked = table[1];
      break;
    }
  }
  if (!picked) return null;

  const asOfMatch = /as of\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(picked);
  const stats = new Map<string, string>();
  for (const row of picked.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = splitRowCells(row[1]);
    if (cells.length < 2) continue;
    const label = cleanText(cells[0]).replace(/\s*\*+$/, '');
    if (!label || stats.has(label)) continue;
    stats.set(label, cleanText(cells[1]));
  }
  const valueOf = (label: string): string | null => stats.get(label) ?? null;

  return {
    asOfDate: asOfMatch ? toIsoDate(asOfMatch[1]) : '',
    frequency: valueOf('Distribution Frequency'),
    managementFeeText: valueOf('Management Fee')?.replace(/\s*\*+$/, '') ?? null,
    distributionRate: numberOrNull(valueOf('Distribution Rate')),
    distributionRateText: valueOf('Distribution Rate'),
    trailingRate12M: numberOrNull(valueOf('12-Month Trailing Distribution Rate')),
    trailingRate12MText: valueOf('12-Month Trailing Distribution Rate'),
    distributionAmount: moneyOrNull(valueOf('Distribution Amount / Share ($)')),
    distributionAmountText: valueOf('Distribution Amount / Share ($)'),
    distributionAmountPercent: numberOrNull(valueOf('Distribution Amount / Share (%)')),
    distributionAmountPercentText: valueOf('Distribution Amount / Share (%)'),
    secYield: numberOrNull(valueOf('30-Day SEC Yield')),
    secYieldText: valueOf('30-Day SEC Yield'),
  };
}

export type NeosDistributionRow = {
  'Declaration Date': string;
  'Ex-Div Date': string;
  'Record Date': string;
  'Payable Date': string;
  'Amount ($)': string;
};

export const NEOS_DISTRIBUTION_HEADERS = [
  'Declaration Date',
  'Ex-Div Date',
  'Record Date',
  'Payable Date',
  'Amount ($)',
] as const;

/**
 * The official Distribution History calendar. Rows are grouped in per-year
 * `<div id="dc-year-<YYYY>">` blocks, newest first, and a declared-but-unpaid
 * month ships an empty Amount cell — kept verbatim so the table mirrors the page.
 */
export function parseNeosDistributionHistory(html: string): NeosDistributionRow[] {
  const start = html.search(/id=["']tab-distribution-history["']/i);
  const section = start >= 0 ? html.slice(start) : html;
  const rows: NeosDistributionRow[] = [];
  const yearBlocks = [...section.matchAll(/<div\b[^>]*id=["']dc-year-(\d{4})["'][^>]*>([\s\S]*?)<\/table>/gi)];
  for (const block of yearBlocks) {
    for (const row of block[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = splitRowCells(row[1]);
      if (cells.length < 5) continue;
      const declaration = cleanText(cells[0]);
      if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(declaration)) continue;
      rows.push({
        'Declaration Date': declaration,
        'Ex-Div Date': cleanText(cells[1]),
        'Record Date': cleanText(cells[2]),
        'Payable Date': cleanText(cells[3]),
        'Amount ($)': cleanText(cells[4]),
      });
    }
  }
  // The page groups rows by year and lists each year oldest-first; the feed
  // publishes the whole history newest-first so the latest payout is row 1.
  rows.sort((a, b) => {
    const left = toIsoDate(a['Declaration Date']);
    const right = toIsoDate(b['Declaration Date']);
    return left < right ? 1 : left > right ? -1 : 0;
  });
  // The page groups rows by year and lists each year oldest-first; the feed
  // publishes the whole history newest-first so row 1 is the latest payout.
  rows.sort((a, b) => {
    const left = toIsoDate(a['Declaration Date']);
    const right = toIsoDate(b['Declaration Date']);
    return left < right ? 1 : left > right ? -1 : 0;
  });
  return rows;
}

export type NeosPerformance = {
  asOfDate: string;
  nav: Record<string, number | null>;
  market: Record<string, number | null>;
  benchmarkName: string | null;
  benchmark: Record<string, number | null>;
};

/** Column label -> the field the feed stores it as. */
const PERFORMANCE_COLUMNS: Record<string, string> = {
  '1 mo': 'mo1',
  '3 mo': 'mo3',
  '6 mo': 'mo6',
  ytd: 'ytd',
  'inception (cumulative)': 'sinceInceptionCumulative',
  '1 yr': 'yr1',
  '3 yr': 'yr3',
  '5 yr': 'yr5',
  '10 yr': 'yr10',
  'inception (annualized)': 'sinceInception',
  'since inception': 'sinceInceptionCumulative',
};

/**
 * One `#monthly-performance` / `#quarterly-performance` table. Returns the NAV
 * and Market rows plus the first benchmark row the page prints.
 */
export function parseNeosPerformanceSection(html: string, sectionId: string): NeosPerformance | null {
  const start = html.search(new RegExp(`id=["']${sectionId}["']`, 'i'));
  if (start < 0) return null;
  const section = html.slice(start, start + 30000);
  const tableStart = section.search(/<table\b/i);
  if (tableStart < 0) return null;
  const tableEnd = section.indexOf('</table>', tableStart);
  const table = section.slice(tableStart, tableEnd > 0 ? tableEnd : undefined);

  const asOfMatch = /Data as of:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(section);
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => splitRowCells(row[1])).filter((cells) => cells.length);

  // Header rows: the first row carries the tenor labels, a second row carries
  // the Cumulative/Annualized grouping and is skipped.
  const headerIndex = rows.findIndex((cells) => cells.some((cell) => /^ytd$/i.test(cell)));
  const headers = headerIndex >= 0 ? rows[headerIndex] : rows[0] || [];
  const columnFields = headers.map((cell) => PERFORMANCE_COLUMNS[cell.toLowerCase()] || null);

  const readRow = (cells: string[]): Record<string, number | null> => {
    const values: Record<string, number | null> = {};
    for (let index = 1; index < cells.length; index += 1) {
      const field = columnFields[index];
      if (!field) continue;
      values[field] = numberOrNull(cells[index]);
    }
    return values;
  };

  let nav: Record<string, number | null> | null = null;
  let market: Record<string, number | null> | null = null;
  let benchmarkName: string | null = null;
  let benchmark: Record<string, number | null> = {};
  for (let index = (headerIndex >= 0 ? headerIndex : 0) + 1; index < rows.length; index += 1) {
    const label = cleanText(rows[index][0]);
    if (!label) continue;
    if (/^nav performance/i.test(label)) nav = readRow(rows[index]);
    else if (/^market performance/i.test(label)) market = readRow(rows[index]);
    else if (
      !benchmarkName &&
      !/post-tax|pre-liquidation|after-tax|^cumulative$|^annualized$/i.test(label)
    ) {
      const candidate = readRow(rows[index]);
      // The column-grouping row ("Cumulative | Annualized") carries no figures,
      // so only a row with at least three readings can be the benchmark.
      const readings = Object.values(candidate).filter((value) => value !== null).length;
      if (readings >= 3) {
        benchmarkName = label;
        benchmark = candidate;
      }
    }
  }
  if (!nav && !market) return null;
  return {
    asOfDate: asOfMatch ? toIsoDate(asOfMatch[1]) : '',
    nav: nav || {},
    market: market || {},
    benchmarkName,
    benchmark,
  };
}

export type NeosNavIndex = {
  startDate: string;
  endDate: string;
  points: number;
  values: number[];
  benchmarkValues: number[];
};

/** The inline `dates` / `navValues` / `indexValues2` arrays behind the "Growth of $10,000 at NAV Since Inception" chart. */
export function parseNeosNavIndex(html: string): NeosNavIndex | null {
  const dates = /const\s+dates\s*=\s*\[([\s\S]*?)\]/.exec(html);
  const values = /const\s+navValues\s*=\s*\[([\s\S]*?)\]/.exec(html);
  if (!dates || !values) return null;
  const dateList = [...dates[1].matchAll(/"([\d-]{10})"/g)].map((match) => match[1]);
  const valueList = values[1]
    .split(',')
    .map((value) => Number(value.replace(/["\s]/g, '')))
    .filter((value) => Number.isFinite(value));
  const benchmarkMatch = /const\s+indexValues2\s*=\s*\[([\s\S]*?)\]/.exec(html);
  const benchmarkValues = benchmarkMatch
    ? benchmarkMatch[1]
        .split(',')
        .map((value) => Number(value.replace(/["\s]/g, '')))
        .filter((value) => Number.isFinite(value))
    : [];
  const length = Math.min(dateList.length, valueList.length);
  if (!length) return null;
  return {
    startDate: dateList[0],
    endDate: dateList[length - 1],
    points: length,
    values: valueList.slice(0, length),
    benchmarkValues: benchmarkValues.slice(0, length),
  };
}

export type NeosDocuments = {
  prospectus: string | null;
  summaryProspectus: string | null;
  sai: string | null;
  annualReport: string | null;
  semiAnnualReport: string | null;
  fiscalQ1Holdings: string | null;
  fiscalQ3Holdings: string | null;
  taxInfo: string | null;
  form8937: string | null;
};

/** The `Documents` table: every row's label matched to its first PDF link. */
export function parseNeosDocuments(html: string): NeosDocuments {
  const documents: NeosDocuments = {
    prospectus: null,
    summaryProspectus: null,
    sai: null,
    annualReport: null,
    semiAnnualReport: null,
    fiscalQ1Holdings: null,
    fiscalQ3Holdings: null,
    taxInfo: null,
    form8937: null,
  };
  const start = html.search(/id=["']fund_documents["']/i);
  const section = start >= 0 ? html.slice(start, start + 20000) : html;
  for (const row of section.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cell = row[1];
    const label = stripTags(cell);
    const href = /href=["'](https?:\/\/[^"']+\.pdf)["']/i.exec(cell);
    if (!href) continue;
    const url = href[1];
    const set = (key: keyof NeosDocuments) => {
      if (!documents[key]) documents[key] = url;
    };
    if (/^summary prospectus/i.test(label)) set('summaryProspectus');
    else if (/^prospectus/i.test(label)) set('prospectus');
    else if (/statement of additional information/i.test(label)) set('sai');
    else if (/^semi-annual report/i.test(label)) set('semiAnnualReport');
    else if (/^annual report/i.test(label)) set('annualReport');
    else if (/portfolio holdings/i.test(label)) {
      if (/q1/i.test(label)) set('fiscalQ1Holdings');
      else if (/q3/i.test(label)) set('fiscalQ3Holdings');
    } else if (/supplemental tax information/i.test(label)) set('taxInfo');
  }
  // Form 8937 filings live in their own tab as a list of period-labelled links.
  // The filing is matched on its own filename, so a fund whose 8937 tab is
  // empty never picks up the first PDF of the tab that follows it.
  const formStart = html.search(/id=["']tab-form-8937["']/i);
  if (formStart >= 0) {
    const formSection = html.slice(formStart, formStart + 12000);
    const pdf = /href=["'](https?:\/\/[^"']*8937[^"']*\.pdf)["']/i.exec(formSection);
    if (pdf) documents.form8937 = pdf[1];
  }
  return documents;
}

// ---------------------------------------------------------------------------
// Official daily holdings CSV
// ---------------------------------------------------------------------------

export const NEOS_HOLDINGS_CSV_HEADERS = [
  'Date',
  'Account',
  'StockTicker',
  'Cusip',
  'SecurityName',
  'Shares',
  'Price',
  'MarketValue',
  'Weightings',
  'NetAssets',
  'SharesOutstanding',
  'CreationUnits',
  'MoneyMarketFlag',
] as const;

export const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'] as const;
/** Funds whose holdings legitimately fail a holdingsGuard check (geared, futures, look-through, top-N lists): ticker, or '*' for every fund -> relaxed checks. */
export const HOLDINGS_GUARD_RELAX: Record<string, string[]> = {};
/** Funds the issuer closed, each confirmed from an SEC filing or the issuer notice (`source`): never fetched or guarded, last published data kept, index row marked closed. */
export const CLOSED_FUNDS: ClosedFund[] = [];
export const HISTORY_HEADERS = ['Date', 'Close', 'Adj Close', 'Volume'] as const;

/** RFC-4180-ish reader that tolerates a UTF-8 BOM, CRLF and quoted fields with commas. */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** `"SPXW  261001P07075000"` — an OCC option symbol (root, padded date, C/P, strike). */
const OCC_OPTION = /^[A-Z0-9]{1,6}\s+\d{6}[CP]\d{8}$/;

/**
 * A factual position type for the Watchlist. NEOS publishes no asset-class
 * column, so this is derived from the row's own identifying fields and is
 * documented as derived in the README; the raw row is otherwise untouched.
 */
export function neosAssetCategory(stockTicker: string, securityName: string, moneyMarketFlag: string): string {
  const ticker = cleanText(stockTicker);
  const name = cleanText(securityName);
  if (/^y$/i.test(cleanText(moneyMarketFlag)) || /^cash\s*&\s*other$/i.test(ticker)) return 'Cash';
  if (OCC_OPTION.test(ticker)) return 'Option';
  if (/treasury|t-bill|t bill/i.test(name)) return 'Treasury';
  if (/\betf\b|exchange[- ]traded|\bfund\b|\btrust\b/i.test(name)) return 'Fund';
  return 'Equity';
}

export type ParsedHoldings = {
  headers: string[];
  rows: Array<Record<string, string>>;
  asOfDate: string;
  netAssets: number | null;
  sharesOutstanding: number | null;
  creationUnits: number | null;
  totalRows: number;
};

/**
 * Map the official CSV onto the shared holdings contract. The feed keeps the
 * provider's own `Weightings` percentage string, its `MarketValue` and its
 * `Shares` verbatim — including the negative values of written options.
 */
export function parseNeosHoldingsCsv(text: string): ParsedHoldings {
  const table = parseCsv(text);
  if (!table.length) {
    return { headers: [...HOLDINGS_HEADERS], rows: [], asOfDate: '', netAssets: null, sharesOutstanding: null, creationUnits: null, totalRows: 0 };
  }
  const header = table[0].map((cell) => cleanText(cell));
  const indexOf = (name: string): number => header.findIndex((cell) => cell.toLowerCase() === name.toLowerCase());
  const at = {
    date: indexOf('Date'),
    ticker: indexOf('StockTicker'),
    cusip: indexOf('Cusip'),
    name: indexOf('SecurityName'),
    shares: indexOf('Shares'),
    price: indexOf('Price'),
    marketValue: indexOf('MarketValue'),
    weight: indexOf('Weightings'),
    netAssets: indexOf('NetAssets'),
    sharesOutstanding: indexOf('SharesOutstanding'),
    creationUnits: indexOf('CreationUnits'),
    moneyMarket: indexOf('MoneyMarketFlag'),
  };
  if (at.ticker < 0 && at.name < 0) {
    throw new Error('holdings CSV: no StockTicker/SecurityName column (is this the NEOS download?)');
  }

  const rows: Array<Record<string, string>> = [];
  let asOfDate = '';
  let netAssets: number | null = null;
  let sharesOutstanding: number | null = null;
  let creationUnits: number | null = null;
  for (let index = 1; index < table.length; index += 1) {
    const cells = table[index];
    const pick = (at_: number): string => (at_ >= 0 && at_ < cells.length ? cleanText(cells[at_]) : '');
    const ticker = pick(at.ticker);
    const name = pick(at.name);
    if (!ticker && !name) continue;
    if (!asOfDate) asOfDate = toIsoDate(pick(at.date));
    if (netAssets === null) netAssets = moneyOrNull(pick(at.netAssets));
    if (sharesOutstanding === null) sharesOutstanding = moneyOrNull(pick(at.sharesOutstanding));
    if (creationUnits === null) creationUnits = moneyOrNull(pick(at.creationUnits));
    const marketValue = moneyOrNull(pick(at.marketValue));
    const moneyMarket = pick(at.moneyMarket);
    rows.push({
      Name: name,
      Ticker: ticker,
      Identifier: pick(at.cusip) || ticker,
      Weight: pick(at.weight),
      'Market Value': marketValue === null ? '' : formatMoneyText(marketValue),
      'Shares Held': pick(at.shares),
      'Asset Category': neosAssetCategory(ticker, name, moneyMarket),
    });
  }
  return { headers: [...HOLDINGS_HEADERS], rows, asOfDate, netAssets, sharesOutstanding, creationUnits, totalRows: rows.length };
}

// ---------------------------------------------------------------------------
// SEC EDGAR Form N-PORT-P fallback: the shared nport-reader block at the end of this file finds, reads and checks the filing
// ---------------------------------------------------------------------------

export const SEC_FUND_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_mf.json';
export const SEC_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

/** One run's SEC state: the two SEC ticker tables (each loaded once) and the N-PORT reader cache (submissions and documents). */
let secState: { funds: Promise<Map<string, NportSeriesRef>> | null; names: Promise<Map<string, string>> | null; reader: Map<string, unknown> } = { funds: null, names: null, reader: new Map() };

/** A fresh SEC state for a run (main and tests). */
export function resetSecState(): void {
  secState = { funds: null, names: null, reader: new Map() };
}

/** SEC's fund ticker -> registrant CIK + series id table, loaded once per run (a failed load is asked again by the next fund). */
function loadFundTickerTable(config: UpdaterConfig): Promise<Map<string, NportSeriesRef>> {
  if (!secState.funds) {
    const loading = fetchText(SEC_FUND_TICKERS_URL, secHeaders(config), config, 'SEC fund ticker table').then((text) => parseSecFundTickers(JSON.parse(text)));
    secState.funds = loading;
    loading.catch(() => { if (secState.funds === loading) secState.funds = null; });
  }
  return secState.funds;
}

/** SEC's company name -> ticker table for the N-PORT rows, loaded once per run. */
function loadCompanyNames(config: UpdaterConfig): Promise<Map<string, string>> {
  if (!secState.names) {
    const loading = fetchText(SEC_COMPANY_TICKERS_URL, secHeaders(config), config, 'SEC company ticker table').then((text) => parseSecCompanyNames(JSON.parse(text)));
    secState.names = loading;
    loading.catch(() => { if (secState.names === loading) secState.names = null; });
  }
  return secState.names;
}

/** Nasdaq Trader symbol directories for the N-PORT rows (shared nport-reader `readUsListings`), loaded once per run: a row with a
 * foreign ISIN keeps a ticker only for the company's own U.S. listing in U.S. dollars (Linde, NXP, IMAX). null when either failed. */
let usListings: Promise<Map<string, string> | null> | null = null;
function loadUsListings(getText: (url: string, label: string) => Promise<string>): Promise<Map<string, string> | null> {
  if (!usListings) usListings = readUsListings(getText);
  return usListings;
}

/**
 * The NEOS holdings sheet (HOLDINGS_HEADERS) of an N-PORT filing: a missing number stays empty (never 0), the weight carries
 * the CSV sheet's percent sign and the market value its dollar sign, a missing text is '-'. Tickers come from nportTickers
 * (U.S. equities traded in USD only, so a written option keeps no ticker), the Identifier is the position's own CUSIP, ISIN
 * or other code (an option never takes its reference index's or ETF's), the Asset Category the filing's assetCat code.
 */
export function nportHoldingsSheet(filing: NportFiling, tickers: ReadonlyArray<string>): Array<Record<string, string>> {
  return filing.positions.map((position, index) => {
    const weight = nportCell(position.weight);
    return {
      Name: position.name || '-',
      Ticker: tickers[index] || '-',
      Identifier: nportIdentifier(position) || '-',
      Weight: weight ? `${weight}%` : '',
      'Market Value': position.value === null ? '' : formatMoneyText(position.value),
      'Shares Held': nportCell(position.balance),
      'Asset Category': position.assetCat || '-',
    };
  });
}

// ---------------------------------------------------------------------------
// Yahoo Finance chart feed
// ---------------------------------------------------------------------------

export type YahooHistoryRow = { date: string; close: number | null; adjClose: number | null; volume: number | null };
export type YahooDistribution = { date: string; amount: number };

export function parseYahooChart(json: unknown): { history: YahooHistoryRow[]; dividends: YahooDistribution[] } {
  const result = (json as any)?.chart?.result?.[0];
  if (!result) return { history: [], dividends: [] };
  const timestamps: number[] = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adjClose = result.indicators?.adjclose?.[0]?.adjclose || [];
  const history: YahooHistoryRow[] = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const close = numberOrNull(quote.close?.[index]);
    const adjusted = numberOrNull(adjClose[index]);
    if (close === null && adjusted === null) continue;
    const date = new Date(timestamps[index] * 1000).toISOString().slice(0, 10);
    history.push({ date, close, adjClose: adjusted, volume: numberOrNull(quote.volume?.[index]) });
  }
  history.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const dividends: YahooDistribution[] = [];
  const events = result.events?.dividends || {};
  for (const key of Object.keys(events)) {
    const event = events[key];
    const amount = numberOrNull(event?.amount);
    const date = event?.date ? new Date(event.date * 1000).toISOString().slice(0, 10) : '';
    if (date && amount !== null) dividends.push({ date, amount });
  }
  dividends.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { history, dividends };
}

export function parseYahooExchangeName(json: unknown): string | null {
  const meta = (json as any)?.chart?.result?.[0]?.meta;
  const raw = meta?.exchangeName || meta?.fullExchangeName;
  return raw ? cleanText(raw) : null;
}

// ---------------------------------------------------------------------------
// Return math
// ---------------------------------------------------------------------------

/** Cumulative total return from an annualized figure: `(1 + CAGR)^years - 1`. */
export function cumulativeFromAnnualized(annualized: number | null, years: number): number | null {
  if (annualized === null) return null;
  if (years <= 1) return annualized;
  return round(((1 + annualized / 100) ** years - 1) * 100, 2);
}

/** Annualized figure from a cumulative one: `(1 + TR)^(1/years) - 1`. */
export function annualizedFromCumulative(cumulative: number | null, years: number): number | null {
  if (cumulative === null) return null;
  if (years <= 1) return cumulative;
  const base = 1 + cumulative / 100;
  if (base <= 0) return null;
  return round((base ** (1 / years) - 1) * 100, 2);
}

/** Provider label -> payments per year. */
export function paymentsPerYear(frequency: string | null | undefined): number | null {
  const text = cleanText(frequency).toLowerCase().replace(/[‐‑‒–—]/g, '-');
  if (!text) return null;
  if (text === 'monthly') return 12;
  if (text === 'quarterly') return 4;
  if (text === 'semi-annually' || text === 'semiannually' || text === 'semi-annual' || text === 'semiannual') return 6;
  if (text === 'annually' || text === 'annual') return 1;
  if (text === 'weekly') return 52;
  if (text === 'bi-monthly') return 6;
  return null;
}

/** The coded, sortable label the catalog Frequency column shows. */
export function formatDistributionFrequency(value: unknown): string {
  const raw = cleanText(value);
  const normalized = raw.toLowerCase().replace(/[‐‑‒–—]/g, '-');
  if (!normalized || normalized === '-') return '00 - None';
  if (normalized === 'monthly') return '01 - Monthly';
  if (normalized === 'quarterly') return '04 - Quarterly';
  if (normalized === 'semi-annually' || normalized === 'semiannual' || normalized === 'semi-annual') return '06 - Semi-annually';
  if (normalized === 'annually' || normalized === 'annual') return '12 - Annually';
  if (normalized === 'none') return '00 - None';
  if (normalized === 'unknown') return '00 - Unknown';
  if (normalized === 'irregular' || normalized === 'other') return '99 - Irregular';
  return raw;
}

/**
 * Distribution frequency derived from the fund's own ex-dates, used only when
 * NEOS publishes no label (it does for every fund today, so this is a guard).
 */
export function inferDistributionFrequency(exDates: string[], now: Date = new Date()): string {
  const cutoff = new Date(now.getTime() - 400 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const recent = exDates
    .map((value) => toIsoDate(value))
    .filter((value) => value && value >= cutoff)
    .sort();
  if (recent.length < 3) return '00 - Unknown';
  const unique = [...new Set(recent)].slice(-12);
  if (unique.length <= 1) return '00 - Unknown';
  const gaps: number[] = [];
  for (let index = 1; index < unique.length; index += 1) {
    const days = (Date.parse(unique[index]) - Date.parse(unique[index - 1])) / 86_400_000;
    if (days > 0) gaps.push(days);
  }
  if (!gaps.length) return '00 - Unknown';
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  if (mean >= 20 && mean <= 40) return '01 - Monthly';
  if (mean >= 70 && mean <= 110) return '04 - Quarterly';
  if (mean >= 150 && mean <= 215) return '06 - Semi-annually';
  if (mean >= 330 && mean <= 400) return '12 - Annually';
  return '99 - Irregular';
}

// ---------------------------------------------------------------------------
// Deterministic writes
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Write only when the serialized bytes moved, via tmp file + rename so an interrupted run never leaves a truncated JSON. */
export async function writeIfChanged(file: string, content: string): Promise<'written' | 'unchanged'> {
  if (existsSync(file)) {
    const current = await readFile(file, 'utf8');
    if (current === content) return 'unchanged';
  }
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
  return 'written';
}

/** Like writeIfChanged for JSON with run stamps: the stamps move only when the other content moved. */
export async function writeJsonIfContentChanged(file: string, value: Record<string, unknown>, stampKeys: string[], stamp: () => string): Promise<'written' | 'unchanged'> {
  const strip = (item: Record<string, unknown>) => Object.fromEntries(Object.entries(item).filter(([key]) => !stampKeys.includes(key)));
  let previous: Record<string, unknown> | null = null;
  try { previous = JSON.parse(await readFile(file, 'utf8')); } catch { /* first write */ }
  if (previous && JSON.stringify(strip(previous)) === JSON.stringify(strip(value))) return 'unchanged';
  const stamped = { ...value, ...Object.fromEntries(stampKeys.map((key) => [key, stamp()])) };
  return writeIfChanged(file, stableStringify(stamped));
}

export function splitPages<T>(rows: T[], pageSize: number): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < rows.length; index += pageSize) pages.push(rows.slice(index, index + pageSize));
  return pages;
}

export function pageFileName(index: number): string {
  return `${pad3(index)}.json`;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export type CatalogEntry = Record<string, unknown> & { ticker: string; holdings?: number; history?: number };

function matchesRange(value: number | null, range: Range | undefined): boolean {
  if (!range) return true;
  if (value === null) return false;
  return value >= range.min && value <= range.max;
}

/**
 * AND filter. A fund missing a figure under an active (bounded) range is EXCLUDED,
 * the same as AUM and TER.
 */
function passesFilters(fund: LineupFund, config: UpdaterConfig): boolean {
  if (config.tickers.length && !config.tickers.includes(fund.ticker)) return false;
  if (config.category && !fund.category.toLowerCase().includes(config.category.toLowerCase())) return false;
  if (config.aumRange && config.aumRange.source) {
    if (fund.netAssets === null) return false;
    if (!matchesRange(fund.netAssets, config.aumRange)) return false;
  }
  if (config.terRange) {
    if (fund.managementFee === null) return false;
    if (!matchesRange(fund.managementFee, config.terRange)) return false;
  }
  if (config.dividendYieldRange) {
    if (fund.distributionRate === null) return false;
    if (!matchesRange(fund.distributionRate, config.dividendYieldRange)) return false;
  }
  if (config.secYieldRange) {
    if (fund.secYield === null) return false;
    if (!matchesRange(fund.secYield, config.secYieldRange)) return false;
  }
  return true;
}

export function passesReturnFilters(entry: CatalogEntry, config: UpdaterConfig): boolean {
  const monthEnd = ((entry.returns as any)?.monthEnd || {}) as Record<string, number | null>;
  const metrics = (entry.metrics || {}) as Record<string, number | null>;
  const published: Record<ReturnPeriod, number | null> = {
    YTD: monthEnd.ytd ?? null,
    '1Y': metrics.tr1y ?? monthEnd.yr1 ?? null,
    '3Y': metrics.cagr3y ?? monthEnd.yr3 ?? null,
    '5Y': metrics.cagr5y ?? monthEnd.yr5 ?? null,
    '10Y': metrics.cagr10y ?? monthEnd.yr10 ?? null,
  };
  for (const period of RETURN_PERIODS) {
    const range = config.performanceRanges[period];
    if (!range) continue;
    const value = published[period];
    if (value === null || value === undefined) return false; // a bounded range excludes funds without that figure
    if (!matchesRange(value, range)) return false;
  }
  for (const period of RETURN_PERIODS) {
    const range = config.totalReturnRanges[period];
    if (!range) continue;
    const derived: Record<ReturnPeriod, number | null> = {
      YTD: monthEnd.ytd ?? null,
      '1Y': metrics.tr1y ?? null,
      '3Y': metrics.tr3y ?? null,
      '5Y': metrics.tr5y ?? null,
      '10Y': metrics.tr10y ?? null,
    };
    const value = derived[period];
    if (value === null || value === undefined) return false;
    if (!matchesRange(value, range)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-fund update
// ---------------------------------------------------------------------------

export type RunStats = { updated: number; unchanged: number; skipped: number; failed: number };

function readNumber(entry: CatalogEntry, key: string): number | null {
  const value = (entry as any)[key];
  return typeof value === 'number' ? value : null;
}

/** The previously published meta.json of a fund, or null when there is none (or it is unreadable). */
async function readPreviousMeta(fundDir: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await readFile(path.join(fundDir, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Yahoo's adjusted close is float32 and its last digits move with the request's period2, so a value
// sitting on a cent boundary (31.544998 vs 31.545001) flips between runs. Within that noise the
// published cent is kept: a rerun with the same source data changes nothing.
export const ADJ_CLOSE_NOISE = 1e-4;

/** The `Adj Close` cell of a day: the published cent while Yahoo's raw value is within float noise of it. */
export function adjCloseCell(raw: number | null, published: string | undefined): string {
  if (raw === null) return '';
  const fresh = raw.toFixed(2);
  const prior = published === undefined ? null : numberOrNull(published);
  return published !== undefined && prior !== null && fresh !== published && Math.abs(raw - prior) <= 0.005 + ADJ_CLOSE_NOISE ? published : fresh;
}

/** The rows of a fund's published sheet pages (`holdings` or `history`) in page order, [] when it has no readable pages. */
async function readPublishedRows(fundDir: string, sheet: 'holdings' | 'history'): Promise<{ headers: string[]; rows: Array<Record<string, string>> }> {
  const out: { headers: string[]; rows: Array<Record<string, string>> } = { headers: [], rows: [] };
  const dir = path.join(fundDir, sheet);
  if (!existsSync(dir)) return out;
  for (const file of (await readdir(dir)).filter((name) => /^\d{3}\.json$/.test(name)).sort()) {
    try {
      const page = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
      if (!out.headers.length && Array.isArray(page.headers)) out.headers = page.headers.map(String);
      for (const row of page.rows || []) if (row && typeof row === 'object') out.rows.push(row);
    } catch {
      // an unreadable page has nothing to keep
    }
  }
  return out;
}

/** The published holdings sheet of a fund (for the guard's published weight count). */
async function readPublishedHoldings(fundDir: string): Promise<{ headers: string[]; rows: Array<Record<string, string>> }> {
  return readPublishedRows(fundDir, 'holdings');
}

/** The published Yahoo dividend fallback rows (`Ex-Date`, `Dividend`) as [date, amount] for the window merge; [] when NEOS published the distributions. */
function publishedYahooDividends(meta: Record<string, any> | null): unknown[] {
  const distributions = meta?.distributions;
  if (!distributions?.fallback || !Array.isArray(distributions.rows)) return [];
  return distributions.rows.map((row: Record<string, unknown>) => [row['Ex-Date'], row.Dividend]);
}

/**
 * A fresh chart (a HISTORY_RANGE window or a truncated `max` answer) never shrinks the published history: the shared windowed-chart block puts the published days
 * older than the window behind the fresh ones (Adj Close rescaled by the overlapping days) and keeps the older published Yahoo
 * dividends. The older days keep their published row (only a rescaled Adj Close changes). Returns `parsed` unchanged
 * or with nothing published (a full `max` answer starts at inception, so the merge finds nothing older), null when the chart does not join the published history (the caller keeps the published history).
 */
export function windowedYahooChart(parsed: ReturnType<typeof parseYahooChart>, range: string, published: Array<Record<string, string>>, publishedDividends: unknown[] = []): { history: YahooHistoryRow[]; dividends: YahooDistribution[]; older: Array<Record<string, string>> } | null {
  if (!published.length || !parsed.history.length) return { ...parsed, older: [] };
  const epoch = (iso: string): number => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 1000;
  const days: WindowedChartDay[] = [];
  for (let index = parsed.history.length - 1; index >= 0; index -= 1) {
    const row = parsed.history[index];
    if (row.close === null || row.adjClose === null) continue;
    days.push({ date: row.date, close: row.close, adjClose: row.adjClose, volume: row.volume ?? 0 });
  }
  const merged = mergeWindowedChart({ days, dividends: parsed.dividends.map((row) => ({ epoch: epoch(row.date), amount: row.amount })) }, published, publishedDividends);
  if (!merged) return null;
  const oldest = parsed.history[parsed.history.length - 1].date;
  const byDate = new Map<string, Record<string, string>>();
  for (const row of published) {
    const date = calendarIso(row.Date);
    if (date && !byDate.has(date)) byDate.set(date, row);
  }
  const older = merged.days.filter((day) => day.date < oldest).reverse().map((day) => {
    const row = byDate.get(day.date) ?? {};
    return { ...row, 'Adj Close': adjCloseCell(day.adjCloseRaw ?? day.adjClose, row['Adj Close']) };
  });
  const dividends: YahooDistribution[] = merged.dividends.map((row) => ({ date: new Date(row.epoch * 1000).toISOString().slice(0, 10), amount: row.amount }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { history: parsed.history, dividends, older };
}

/** Yahoo daily history rows in the published page shape (newest first), or [] when the source failed or is skipped. */
async function fetchYahooHistory(
  ticker: string,
  config: UpdaterConfig,
): Promise<{ rows: Array<Record<string, string>>; dividends: YahooDistribution[]; exchange: string | null }> {
  if (config.skipYahoo) return { rows: [], dividends: [], exchange: null };
  try {
    const json = JSON.parse(await fetchText(yahooChartUrl(ticker, config.historyRange), yahooHeaders(), config, `${ticker} Yahoo chart`));
    const fundDir = path.join(API_ROOT, 'funds', ticker);
    const publishedRows = (await readPublishedRows(fundDir, 'history')).rows;
    // A fresh chart never shrinks the published history, for a HISTORY_RANGE window and for a truncated `max` answer alike
    // (2026-10-29: Yahoo served 2 bars for some funds); a full `max` answer starts at inception: nothing older, unchanged
    const fetched = parseYahooChart(json);
    const parsed = windowedYahooChart(fetched, config.historyRange, publishedRows, publishedYahooDividends(await readPreviousMeta(fundDir)));
    if (!parsed) throw new Error(`chart does not join the published history (${config.historyRange}, ${fetched.history.length} days)`);
    const published = new Map<string, string>();
    for (const row of publishedRows) if (typeof row?.Date === 'string' && typeof row['Adj Close'] === 'string') published.set(row.Date, row['Adj Close']);
    return {
      rows: parsed.history.map((row): Record<string, string> => ({
        Date: row.date,
        Close: row.close === null ? '' : row.close.toFixed(2),
        'Adj Close': adjCloseCell(row.adjClose, published.get(row.date)),
        Volume: row.volume === null ? '' : String(row.volume),
      })).concat(parsed.older),
      dividends: parsed.dividends,
      exchange: parseYahooExchangeName(json),
    };
  } catch (error) {
    outputNote(`[ ${'chart'.padEnd(8)} ] ${ticker}: Yahoo chart unavailable (${errorMessage(error)}), keeping previous history`);
    return { rows: [], dividends: [], exchange: null };
  }
}

/**
 * SKIP_NEOS: neosfunds.com is not read at all. The previously published fund page data
 * (returns, holdings, yields) stays exactly as it is; only the daily history and the
 * history manifest are refreshed from Yahoo. With nothing fresh the previous row is kept.
 */
export async function refreshHistoryOnly(
  fund: LineupFund,
  previousEntry: CatalogEntry | undefined,
  config: UpdaterConfig,
  stats: RunStats,
): Promise<CatalogEntry> {
  const ticker = fund.ticker;
  const fundDir = path.join(API_ROOT, 'funds', ticker);
  const meta = await readPreviousMeta(fundDir);
  if (!meta || !previousEntry) throw new Error(`${ticker}: no published data to keep (SKIP_NEOS)`);
  const fetched = await fetchYahooHistory(ticker, config);
  if (!fetched.rows.length) {
    stats.unchanged += 1;
    return previousEntry;
  }
  const pages = splitPages(fetched.rows, config.historyPageSize);
  const names: string[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    const envelope = { ticker, page: index + 1, pageSize: config.historyPageSize, totalRows: fetched.rows.length, headers: [...HISTORY_HEADERS], rows: pages[index] };
    await writeIfChanged(path.join(fundDir, 'history', pageFileName(index + 1)), stableStringify(envelope));
    names.push(`./history/${pageFileName(index + 1)}`);
  }
  const history = {
    ...(meta.history ?? {}),
    pages: names,
    pageSize: config.historyPageSize,
    totalRows: fetched.rows.length,
    asOfDate: formatNeosDate(fetched.rows[0].Date),
    asOf: fetched.rows[0].Date,
    source: yahooChartProvenanceUrl(ticker),
  };
  const written = await writeIfChanged(path.join(fundDir, 'meta.json'), stableStringify({ ...meta, history }));
  await prunePages(path.join(fundDir, 'history'), pages.length);
  if (written === 'written') stats.updated += 1; else stats.unchanged += 1;
  return { ...previousEntry, history: fetched.rows.length };
}

/**
 * Why a fetched fund page must not refresh a fund that is already published, or null when it may. A 200 page whose
 * Fund Details panel or monthly performance table is missing (a partial page, a markup change) would otherwise publish
 * null CUSIP, NAV, TER and returns next to fresh holdings. A fund that never had those values keeps its honest nulls.
 */
export function fundPageProblem(details: NeosFundDetails, monthly: NeosPerformance | null, previous: Record<string, any> | null): string | null {
  if (!previous) return null;
  const detailsFound = Boolean(details.ticker || details.cusip || details.isin || details.netAssetValue !== null || details.netAssets !== null || details.sharesOutstanding !== null);
  // CUSIP and ISIN come only from the Fund Details panel (NAV can also be derived from the holdings CSV)
  const hadDetails = Boolean(previous.cusip || previous.isin);
  if (!detailsFound && hadDetails) return 'fund page has no Fund Details panel';
  if (!monthly && previous.returns?.monthEnd?.raw) return 'fund page has no monthly performance table';
  return null;
}

export async function updateFund(
  fund: LineupFund,
  config: UpdaterConfig,
  stats: RunStats,
  accept?: (entry: CatalogEntry) => boolean,
): Promise<CatalogEntry | null> {
  const ticker = fund.ticker;
  const fundDir = path.join(API_ROOT, 'funds', ticker);
  let changed = false;

  let pageHtml = '';
  if (!config.skipNeos) {
    pageHtml = await fetchText(neosFundPageUrl(ticker), browserHeaders(), config, `${ticker} fund page`);
    if (config.storeRawDownloads) {
      await writeIfChanged(path.join(API_ROOT, 'raw', `${ticker}-fund-page.html`), pageHtml);
    }
  }

  const details = parseNeosFundDetails(pageHtml);
  const distributionInfo = parseNeosDistributionInfo(pageHtml);
  const distributionRows = parseNeosDistributionHistory(pageHtml);
  const monthly = parseNeosPerformanceSection(pageHtml, 'monthly-performance');
  const quarterly = parseNeosPerformanceSection(pageHtml, 'quarterly-performance');
  const navIndex = parseNeosNavIndex(pageHtml);
  const documents = parseNeosDocuments(pageHtml);
  if (!config.skipNeos) {
    const pageProblem = fundPageProblem(details, monthly, await readPreviousMeta(fundDir));
    if (pageProblem) throw new Error(`${ticker}: ${pageProblem}; kept the previous complete data`);
  }

  // --- holdings (official daily CSV) -------------------------------------
  let holdings = {
    headers: [...HOLDINGS_HEADERS] as string[],
    rows: [] as Array<Record<string, string>>,
    asOfDate: '',
    netAssets: null as number | null,
    sharesOutstanding: null as number | null,
    creationUnits: null as number | null,
    totalRows: 0,
    source: neosProvenanceHoldingsUrl(ticker),
    sourceKind: 'official NEOS daily holdings CSV (download_holdings_csv)',
  };
  let nportDocument: string | null = null; // the N-PORT primary_doc.xml the sheet was read from, null for the issuer CSV
  if (!config.skipNeos) {
    try {
      const csv = await fetchText(neosHoldingsCsvUrl(ticker), browserHeaders(), config, `${ticker} holdings CSV`);
      if (/^\s*</.test(csv)) throw new Error(`${ticker} holdings CSV: received HTML instead of CSV`);
      const parsed = parseNeosHoldingsCsv(csv);
      if (!parsed.rows.length) throw new Error(`${ticker} holdings CSV: no positions`);
      holdings = { ...holdings, ...parsed, headers: parsed.headers, source: neosProvenanceHoldingsUrl(ticker) };
      if (config.storeRawDownloads) {
        await writeIfChanged(path.join(API_ROOT, 'raw', `${ticker}-holdings.csv`), csv);
      }
    } catch (error) {
      if (!config.edgarFallback) throw error;
      outputNote(`[ ${'holdings'.padEnd(8)} ] ${ticker}: holdings CSV unavailable (${errorMessage(error)}), trying EDGAR`);
      // The fund's own newest N-PORT-P filing (shared nport-reader block): identity by the series id of SEC's fund ticker table
      // (the fund name only when SEC lists no series for the ticker), read only when its report period is strictly newer than
      // the published holdings date (the issuer CSV's as-of day, or an earlier report period).
      const publishedMeta = await readPreviousMeta(fundDir);
      const ref = (await loadFundTickerTable(config)).get(ticker);
      const read = await readNportHoldings(
        ref ? { ticker, cik: ref.cik, seriesId: ref.seriesId } : { ticker, cik: NEOS_ETF_TRUST_CIK, seriesId: null, name: /^neos\b/i.test(fund.name) ? fund.name : `NEOS ${fund.name}` },
        { asOf: calendarIso(publishedMeta?.holdings?.asOf) ?? calendarIso(publishedMeta?.holdings?.asOfDate), rows: numberOrNull(publishedMeta?.holdings?.totalRows) ?? 0 },
        (url, label) => fetchText(url, secHeaders(config), config, label),
        { cache: secState.reader },
      );
      if ('problem' in read) throw new Error(`${read.problem}; ${publishedMeta ? 'kept the previous complete data' : 'no data published for this fund yet'}`);
      const rows = nportHoldingsSheet(read.filing, nportTickers(read.filing.positions, await loadCompanyNames(config).catch(() => null), await loadUsListings((url, label) => fetchText(url, secHeaders(config), config, label))));
      outputNote(`[ ${'nport'.padEnd(8)} ] ${ticker}: N-PORT ${read.candidate.accession}, report period ${read.filing.repPdDate || 'n/a'}, ${rows.length} positions${read.loose ? ' (series name matched loosely)' : ''}`);
      holdings = {
        ...holdings,
        headers: [...HOLDINGS_HEADERS],
        rows,
        asOfDate: read.filing.repPdDate,
        totalRows: rows.length,
        source: read.url,
        sourceKind: `SEC EDGAR Form N-PORT-P (fallback; accession ${read.candidate.accession}, report period ${read.filing.repPdDate || 'n/a'})`,
      };
      nportDocument = read.url;
    }
    // Fresh holdings that look broken (no weight column, non-numeric weights, a bad weight sum, half the rows gone)
    // never replace the published ones: the fund fails like a failed required source and keeps its previous state.
    // No relax lets a sheet without a single numeric weight replace a published sheet that had numeric weights (Q24).
    const previousHoldingsMeta = await readPreviousMeta(fundDir);
    const publishedHoldings = previousHoldingsMeta ? await readPublishedHoldings(fundDir) : null;
    const publishedWeights = publishedHoldings ? holdingsWeightCount(publishedHoldings.headers.length ? publishedHoldings.headers : [...HOLDINGS_HEADERS], publishedHoldings.rows) : null;
    const holdingsProblem = holdingsGuard(holdings.headers, holdings.rows, numberOrNull(previousHoldingsMeta?.holdings?.totalRows), HOLDINGS_GUARD_RELAX[ticker] ?? HOLDINGS_GUARD_RELAX['*'] ?? [], publishedWeights);
    if (holdingsProblem) throw new Error(`holdings guard: ${holdingsProblem}; ${previousHoldingsMeta ? 'kept the previous complete data' : 'no data published for this fund yet'}`);
  }

  // --- daily history + dividend fallback (Yahoo) -------------------------
  // A skipped or failed Yahoo request keeps the previously published history untouched.
  const fetchedHistory = await fetchYahooHistory(ticker, config);
  const historyRows = fetchedHistory.rows;
  const yahooDividends = fetchedHistory.dividends;
  const yahooExchange = fetchedHistory.exchange;
  const previousMeta = historyRows.length ? null : await readPreviousMeta(fundDir);
  const keptHistory = previousMeta?.history && Number(previousMeta.history.totalRows) > 0 ? previousMeta.history : null;
  const keptHistoryFirstClose = keptHistory
    ? await readFile(path.join(fundDir, 'history', '001.json'), 'utf8').then((text) => numberOrNull(JSON.parse(text).rows?.[0]?.Close), () => null)
    : null;
  const historyCount = keptHistory ? Number(keptHistory.totalRows) : historyRows.length;

  // --- assemble metrics --------------------------------------------------
  const netAssets = holdings.netAssets ?? details.netAssets ?? fund.netAssets ?? null;
  const sharesOutstanding = holdings.sharesOutstanding ?? details.sharesOutstanding ?? null;
  // NEOS prints NAV and Market Price directly; the derived quotient is only a
  // guard for the day a fund page omits the panel.
  const derivedNav = netAssets !== null && sharesOutstanding ? round(netAssets / sharesOutstanding, 2) : null;
  const navValue = details.netAssetValue ?? derivedNav;
  const navKind = details.netAssetValue !== null ? 'official (fund page Fund Details)' : 'derived (Net Assets / Shares Outstanding)';
  const marketPriceValue = details.marketPrice
    ?? (historyRows.length ? numberOrNull(historyRows[0].Close) : keptHistoryFirstClose);
  const derivedPremiumDiscount = navValue && marketPriceValue !== null ? round(((marketPriceValue - navValue) / navValue) * 100, 2) : null;
  // NEOS prints its own `Premium Discount (%)`; the quotient is only the guard
  // for the day a panel omits the row.
  const premiumDiscount = details.premiumDiscount ?? derivedPremiumDiscount;
  const premiumDiscountKind = details.premiumDiscount !== null
    ? 'official (fund page Fund Details "Premium Discount (%)")'
    : 'derived (Market Price - NAV) / NAV';

  const monthEndValues = monthly?.nav || {};
  const quarterEndValues = quarterly?.nav || {};
  const monthEndDate = monthly?.asOfDate || '';
  const quarterEndDate = quarterly?.asOfDate || '';

  // The shared "younger than its horizon" rule (calendar anniversary of the inception, inclusive, at the performance date): no
  // 1-year or since-inception return before the first anniversary, no 3, 5 or 10-year return before those; an unknown date
  // keeps the value. The inception is the catalog's (the lineup date, the basis of the published returns; see inceptionNote).
  const returns = withoutYoungReturns({
    tr1y: monthEndValues.yr1 ?? null,
    tr3y: cumulativeFromAnnualized(monthEndValues.yr3 ?? null, 3),
    tr5y: cumulativeFromAnnualized(monthEndValues.yr5 ?? null, 5),
    tr10y: cumulativeFromAnnualized(monthEndValues.yr10 ?? null, 10),
    cagr3y: monthEndValues.yr3 ?? null,
    cagr5y: monthEndValues.yr5 ?? null,
    cagr10y: monthEndValues.yr10 ?? null,
    siAnn: monthEndValues.sinceInception ?? null,
  }, fund.inceptionDate || details.inceptionDate, performanceAsOf(monthEndDate), { tr1y: 1, tr3y: 3, tr5y: 5, tr10y: 10, cagr3y: 3, cagr5y: 5, cagr10y: 10, siAnn: 1 });
  const metrics = {
    ytd: monthEndValues.ytd ?? null,
    ...returns,
    dividendYield: distributionInfo?.distributionRate ?? fund.distributionRate ?? null,
    dividendYieldText: formatPercentText(distributionInfo?.distributionRate ?? fund.distributionRate ?? null),
    dividendYieldBasis: yieldBasisFor(distributionInfo?.distributionRate ?? fund.distributionRate ?? null),
    distributionYield: distributionInfo?.distributionRate ?? fund.distributionRate ?? null,
    distributionYieldText: formatPercentText(distributionInfo?.distributionRate ?? fund.distributionRate ?? null),
    yield12M: distributionInfo?.trailingRate12M ?? null,
    yield12MText: formatPercentText(distributionInfo?.trailingRate12M ?? null),
    secYield: distributionInfo?.secYield ?? fund.secYield ?? null,
    secYieldText: formatPercentText(distributionInfo?.secYield ?? fund.secYield ?? null),
    returnsBasis: RETURNS_BASIS,
    performanceAsOf: performanceAsOf(monthEndDate),
  };

  const latestDistribution = distributionRows.find((row) => row['Amount ($)'] && !isMissingCell(row['Amount ($)']));
  const exDates = distributionRows.map((row) => row['Ex-Div Date']);
  const frequencyLabel = distributionInfo?.frequency || details.distributionFrequency || fund.frequency || '—';
  const frequencyCode = formatDistributionFrequency(frequencyLabel);
  const paymentCount = paymentsPerYear(frequencyLabel);

  let holdingsMeta = {
    pages: [] as string[],
    pageSize: config.holdingsPageSize,
    totalRows: holdings.totalRows,
    asOfDate: holdings.asOfDate ? formatNeosDate(holdings.asOfDate) : '',
    asOf: holdings.asOfDate,
    source: holdings.source,
    sourceKind: holdings.sourceKind,
  };
  let historyMeta = keptHistory
    ? { ...keptHistory }
    : {
        pages: [] as string[],
        pageSize: config.historyPageSize,
        totalRows: historyRows.length,
        asOfDate: historyRows.length ? formatNeosDate(historyRows[0].Date) : '',
        asOf: historyRows.length ? historyRows[0].Date : '',
        source: config.skipYahoo ? '' : yahooChartProvenanceUrl(ticker),
        sourceKind: 'Yahoo Finance public chart API (daily Close / Adj Close / Volume)',
      };

  const meta: Record<string, unknown> = {
    ticker,
    name: fund.name,
    category: fund.category,
    categoryClass: fund.categoryClass || null,
    dataFile: `./funds/${ticker}/meta.json`,
    fundPage: neosFundPageUrl(ticker),
    source: {
      provider: 'NEOS Investment Management LLC (NEOS ETFs)',
      site: NEOS_SITE,
      lineup: NEOS_LINEUP_URL,
      fundPage: neosFundPageUrl(ticker),
      holdingsDownload: holdings.source,
      holdingsSource: holdings.sourceKind,
      historySource: historyMeta.sourceKind,
      historyUrl: historyMeta.source,
      returnsSource: 'NEOS fund page performance tables (NAV Performance)',
      distributionsSource: 'NEOS fund page Distribution History table',
      distributionInfoSource: 'NEOS fund page Distribution Information block',
      documentsSource: 'NEOS fund page Documents table',
      registrant: `NEOS ETF Trust (Investment Company Act file ${NEOS_ETF_TRUST_FILE_NUMBER})`,
      // the N-PORT primary_doc.xml the holdings were read from; no key when they came from the issuer CSV
      ...(nportDocument ? { nportDoc: nportDocument } : {}),
      exchangeSource: 'NEOS fund page Fund Details "Primary Exchange"',
      navSource: `NEOS fund page Fund Details "Net Asset Value" (${navKind})`,
      premiumDiscountSource: premiumDiscountKind,
      bidAskSpreadSource: 'NEOS fund page Fund Details "30-Day Median Bid-Ask Spread (%)"',
    },
    identifiers: {
      cusip: details.cusip || null,
      isin: details.isin || null,
      underlyingExposure: details.underlyingExposure || null,
      indexName: details.underlyingExposure || null,
      benchmarkIndexName: monthly?.benchmarkName || null,
    },
    expenseRatio: {
      display: details.totalOperatingExpensesText || null,
      value: numberOrNull(details.totalOperatingExpensesText),
      net: numberOrNull(details.totalOperatingExpensesText),
      gross: numberOrNull(details.totalOperatingExpensesText),
      managementFeeDisplay: details.managementFeeText || fund.managementFeeText || null,
      managementFeeValue: numberOrNull(details.managementFeeText) ?? fund.managementFee ?? null,
    },
    nav: {
      display: formatMoneyText(navValue),
      value: navValue,
      asOfDate: details.asOfDate ? formatNeosDate(details.asOfDate) : holdingsMeta.asOfDate,
      dailyChangeText: details.navDailyChangeValue === null
        ? null
        : `${formatMoneyText(details.navDailyChangeValue)} (${formatPercentText(details.navDailyChangePercent)})`,
      kind: navKind,
    },
    marketPrice: {
      display: formatMoneyText(marketPriceValue),
      value: marketPriceValue,
      asOfDate: details.asOfDate ? formatNeosDate(details.asOfDate) : '',
      dailyChangeText: details.marketPriceDailyChangeValue === null
        ? null
        : `${formatMoneyText(details.marketPriceDailyChangeValue)} (${formatPercentText(details.marketPriceDailyChangePercent)})`,
      source: details.marketPrice !== null ? 'NEOS fund page Fund Details "Market Price"' : 'Yahoo Finance daily close',
    },
    premiumDiscount: {
      display: formatPercentText(premiumDiscount),
      value: premiumDiscount,
      derivedValue: derivedPremiumDiscount,
      kind: premiumDiscountKind,
    },
    bidAskSpread: {
      display: details.bidAskSpreadText || null,
      value: details.bidAskSpread,
      asOfDate: details.asOfDate ? formatNeosDate(details.asOfDate) : null,
      kind: 'official (fund page Fund Details "30-Day Median Bid-Ask Spread (%)")',
    },
    aum: {
      display: netAssets === null ? null : formatAumDisplay(netAssets),
      value: netAssets,
      asOfDate: details.asOfDate ? formatNeosDate(details.asOfDate) : holdingsMeta.asOfDate,
      source: holdings.netAssets !== null ? holdings.sourceKind : 'NEOS fund page Fund Details "Net Assets"',
    },
    sharesOutstanding: {
      display: sharesOutstanding === null ? null : sharesOutstanding.toLocaleString('en-US'),
      value: sharesOutstanding,
      asOfDate: holdingsMeta.asOfDate,
    },
    yields: {
      dividendYield: metrics.dividendYield,
      dividendYieldText: metrics.dividendYieldText,
      dividendYieldBasis: metrics.dividendYieldBasis,
      dividendYieldKind: YIELD_KIND_BY_BASIS[DIVIDEND_YIELD_BASIS],
      distributionRate: metrics.distributionYield,
      distributionRateText: metrics.distributionYieldText,
      yield12M: metrics.yield12M,
      yield12MText: metrics.yield12MText,
      secYield: metrics.secYield,
      secYieldText: metrics.secYieldText,
      secYieldKind: 'official NEOS 30-Day SEC Yield',
      distributionAmountText: distributionInfo?.distributionAmountText || null,
      distributionAmountPercentText: distributionInfo?.distributionAmountPercentText || null,
      distributionInfoAsOfDate: distributionInfo?.asOfDate ? formatNeosDate(distributionInfo.asOfDate) : null,
    },
    returns: {
      derivedFrom: 'official NEOS fund page performance tables (NAV Performance series)',
      monthEnd: {
        asOfDate: formatNeosDate(monthEndDate),
        raw: monthEndDate,
        mo1: monthEndValues.mo1 ?? null,
        mo3: monthEndValues.mo3 ?? null,
        mo6: monthEndValues.mo6 ?? null,
        ytd: monthEndValues.ytd ?? null,
        yr1: monthEndValues.yr1 ?? null,
        yr3: monthEndValues.yr3 ?? null,
        yr5: monthEndValues.yr5 ?? null,
        yr10: monthEndValues.yr10 ?? null,
        sinceInception: monthEndValues.sinceInception ?? null,
        sinceInceptionCumulative: monthEndValues.sinceInceptionCumulative ?? null,
        market: monthly?.market || {},
        benchmarkName: monthly?.benchmarkName || null,
        benchmark: monthly?.benchmark || {},
      },
      quarterEnd: {
        asOfDate: formatNeosDate(quarterEndDate),
        raw: quarterEndDate,
        mo1: quarterEndValues.mo1 ?? null,
        mo3: quarterEndValues.mo3 ?? null,
        mo6: quarterEndValues.mo6 ?? null,
        ytd: quarterEndValues.ytd ?? null,
        yr1: quarterEndValues.yr1 ?? null,
        yr3: quarterEndValues.yr3 ?? null,
        yr5: quarterEndValues.yr5 ?? null,
        yr10: quarterEndValues.yr10 ?? null,
        sinceInception: quarterEndValues.sinceInception ?? null,
        sinceInceptionCumulative: quarterEndValues.sinceInceptionCumulative ?? null,
        market: quarterly?.market || {},
      },
    },
    navIndex: navIndex
      ? {
          startDate: navIndex.startDate,
          endDate: navIndex.endDate,
          points: navIndex.points,
          benchmarkName: monthly?.benchmarkName || null,
          source: 'NEOS fund page "Growth of $10,000 at NAV Since Inception" chart series',
        }
      : null,
    distributions: {
      frequency: frequencyLabel,
      paymentsPerYear: paymentCount ?? inferPaymentsFromRows(exDates),
      headers: [...NEOS_DISTRIBUTION_HEADERS],
      rows: distributionRows,
      fallback: false,
      source: 'NEOS fund page Distribution History table',
    },
    documents: { ...documents },
    holdings: holdingsMeta,
    history: historyMeta,
  };

  // Yahoo dividend history is the fallback only when NEOS published no rows.
  if (!distributionRows.length && yahooDividends.length) {
    (meta.distributions as Record<string, unknown>).headers = ['Ex-Date', 'Dividend'];
    (meta.distributions as Record<string, unknown>).rows = yahooDividends.map((row) => ({
      'Ex-Date': formatNeosDate(row.date),
      Dividend: `$${row.amount.toFixed(4)}`,
    }));
    (meta.distributions as Record<string, unknown>).frequency = formatDistributionFrequency(
      inferDistributionFrequency(yahooDividends.map((row) => row.date)),
    );
    (meta.distributions as Record<string, unknown>).fallback = true;
    (meta.distributions as Record<string, unknown>).source = 'Yahoo Finance dividend history (NEOS published no distribution rows)';
  }

  // --- page layout (nothing is written until the whole fund is computed) ----
  const holdingsPages = splitPages(holdings.rows, config.holdingsPageSize);
  for (let index = 0; index < holdingsPages.length; index += 1) holdingsMeta.pages.push(`./holdings/${pageFileName(index + 1)}`);
  const historyPages = keptHistory ? [] : splitPages(historyRows, config.historyPageSize);
  if (!keptHistory) for (let index = 0; index < historyPages.length; index += 1) historyMeta.pages.push(`./history/${pageFileName(index + 1)}`);

  // --- catalog entry -----------------------------------------------------
  // The catalog row is built first: `meta.json` mirrors it (the sibling feeds
  // publish the same fields in both files) and `index.json` collects it.
  const inferredExchange = details.primaryExchange || yahooExchange || null;
  // neosfunds.com prints two inception dates for a fund whose ETF share class
  // was converted from a predecessor fund (HYBI: the lineup table keeps the
  // predecessor's 2014 date its performance history is based on, while the fund
  // page panel shows the 2024 conversion). The catalog shows the lineup figure
  // and meta.json keeps both.
  const lineupInception = fund.inceptionDate || '';
  const fundPageInception = details.inceptionDate || '';
  const entry: CatalogEntry = {
    ticker,
    name: fund.name,
    category: fund.category,
    fundPage: neosFundPageUrl(ticker),
    dataFile: `./funds/${ticker}/meta.json`,
    cusip: details.cusip || null,
    isin: details.isin || null,
    ter: details.totalOperatingExpensesText || '—',
    terValue: numberOrNull(details.totalOperatingExpensesText),
    // NEOS publishes one all-in figure (Total Annual Fund Operating Expenses, no waiver): net == gross.
    terGross: details.totalOperatingExpensesText || null,
    terGrossValue: numberOrNull(details.totalOperatingExpensesText),
    managementFee: details.managementFeeText || fund.managementFeeText || null,
    managementFeeValue: numberOrNull(details.managementFeeText) ?? fund.managementFee ?? null,
    nav: formatMoneyText(navValue),
    navValue,
    aum: netAssets === null ? '—' : formatAumDisplay(netAssets),
    aumValue: netAssets,
    asOfDate: details.asOfDate ? formatNeosDate(details.asOfDate) : (holdings.asOfDate ? formatNeosDate(holdings.asOfDate) : ''),
    inceptionDate: formatNeosDate(lineupInception || fundPageInception),
    inceptionDateFundPage: fundPageInception ? formatNeosDate(fundPageInception) : null,
    exchange: inferredExchange,
    closePrice: formatMoneyText(marketPriceValue),
    closePriceValue: marketPriceValue,
    premiumDiscount: formatPercentText(premiumDiscount),
    premiumDiscountValue: premiumDiscount,
    premiumDiscountDerivedValue: derivedPremiumDiscount,
    premiumDiscountKind,
    bidAskSpread: details.bidAskSpreadText || null,
    bidAskSpreadValue: details.bidAskSpread,
    acquiredFundFeesText: details.acquiredFundFeesText,
    totalNetAssets: netAssets,
    sharesOutstanding,
    netAssetsAsOf: details.asOfDate ? formatNeosDate(details.asOfDate) : (holdings.asOfDate ? formatNeosDate(holdings.asOfDate) : ''),
    secYieldAsOf: distributionInfo?.asOfDate ? formatNeosDate(distributionInfo.asOfDate) : null,
    distributions: {
      frequency: frequencyLabel,
      paymentsPerYear: paymentCount ?? null,
      exDate: latestDistribution ? latestDistribution['Ex-Div Date'] : null,
      dividend: latestDistribution ? latestDistribution['Amount ($)'] : null,
    },
    returns: {
      monthEnd: {
        asOfDate: formatNeosDate(monthEndDate),
        ytd: monthEndValues.ytd ?? null,
        ytdText: formatPercentText(monthEndValues.ytd ?? null),
        yr1: monthEndValues.yr1 ?? null,
        yr3: monthEndValues.yr3 ?? null,
        yr5: monthEndValues.yr5 ?? null,
        yr10: monthEndValues.yr10 ?? null,
        sinceInception: monthEndValues.sinceInception ?? null,
        // The page's own "Inception (Cumulative)" cell, which the app's
        // Overview tab renders beside the annualized figure.
        sinceInceptionCumulative: monthEndValues.sinceInceptionCumulative ?? null,
        sinceInceptionCumulativeText: formatPercentText(monthEndValues.sinceInceptionCumulative ?? null),
      },
      quarterEnd: {
        asOfDate: formatNeosDate(quarterEndDate),
        ytd: quarterEndValues.ytd ?? null,
        yr1: quarterEndValues.yr1 ?? null,
        yr3: quarterEndValues.yr3 ?? null,
        yr5: quarterEndValues.yr5 ?? null,
        yr10: quarterEndValues.yr10 ?? null,
        sinceInception: quarterEndValues.sinceInception ?? null,
        sinceInceptionCumulative: quarterEndValues.sinceInceptionCumulative ?? null,
        sinceInceptionCumulativeText: formatPercentText(quarterEndValues.sinceInceptionCumulative ?? null),
      },
    },
    metrics,
    distributionFrequency: frequencyCode,
    providerCategory: fund.category,
    holdings: holdings.totalRows,
    history: historyCount,
    navKind,
  };

  // `meta.json` carries the catalog row plus the sheet manifests, the
  // provenance block and the richer per-field objects (the sibling feeds have
  // exactly this shape, so a consumer can read either file for the headline
  // figures).
  const metaWithCatalog: Record<string, unknown> = {
    ...entry,
    source: meta.source,
    identifiers: meta.identifiers,
    expenseRatio: meta.expenseRatio,
    nav: meta.nav,
    marketPrice: meta.marketPrice,
    premiumDiscount: meta.premiumDiscount,
    bidAskSpread: meta.bidAskSpread,
    aum: meta.aum,
    sharesOutstanding: meta.sharesOutstanding,
    yields: meta.yields,
    returns: meta.returns,
    navIndex: meta.navIndex,
    distributions: meta.distributions,
    documents: meta.documents,
    inceptionNote: lineupInception && fundPageInception && lineupInception !== fundPageInception
      ? `neosfunds.com publishes ${formatNeosDate(lineupInception)} in the ETF lineup table and ${formatNeosDate(fundPageInception)} in the Fund Details panel (the date the fund's predecessor converted into the ETF); the catalog shows the lineup figure, which is the basis of the published 5Y and 10Y returns.`
      : null,
    holdings: holdingsMeta,
    history: historyMeta,
  };
  // Return filters (PERFORMANCE_*/TOTAL_RETURN_*) decide before anything is written: an excluded
  // fund keeps its previous complete state (files and index row).
  if (accept && !accept(entry)) return null;

  // Order: pages first, then meta.json (the manifest), then stale pages; the index row follows in main().
  for (let index = 0; index < holdingsPages.length; index += 1) {
    const envelope = { ticker, page: index + 1, pageSize: config.holdingsPageSize, totalRows: holdings.rows.length, headers: holdings.headers, rows: holdingsPages[index] };
    if (await writeIfChanged(path.join(fundDir, 'holdings', pageFileName(index + 1)), stableStringify(envelope)) === 'written') changed = true;
  }
  for (let index = 0; index < historyPages.length; index += 1) {
    const envelope = { ticker, page: index + 1, pageSize: config.historyPageSize, totalRows: historyRows.length, headers: [...HISTORY_HEADERS], rows: historyPages[index] };
    if (await writeIfChanged(path.join(fundDir, 'history', pageFileName(index + 1)), stableStringify(envelope)) === 'written') changed = true;
  }
  if (await writeIfChanged(path.join(fundDir, 'meta.json'), stableStringify(metaWithCatalog)) === 'written') changed = true;
  await prunePages(path.join(fundDir, 'holdings'), holdingsPages.length);
  if (!keptHistory) await prunePages(path.join(fundDir, 'history'), historyPages.length);

  if (changed) stats.updated += 1; else stats.unchanged += 1;

  return entry;
}


function inferPaymentsFromRows(exDates: string[]): number | null {
  const code = inferDistributionFrequency(exDates);
  if (code === '01 - Monthly') return 12;
  if (code === '04 - Quarterly') return 4;
  if (code === '06 - Semi-annually') return 6;
  if (code === '12 - Annually') return 1;
  return null;
}

/** Remove page files beyond `count` so a shrinking fund leaves no orphan pages. */
async function prunePages(dir: string, count: number): Promise<void> {
  if (!existsSync(dir)) return;
  const files = (await readdir(dir)).filter((name) => /^\d{3}\.json$/.test(name));
  for (const file of files) {
    const index = Number(file.slice(0, 3));
    if (index > count) await rm(path.join(dir, file));
  }
}

/** The cursor is only valid for the filter set it was saved under. */
export function filterScope(config: UpdaterConfig): string {
  return JSON.stringify({
    tickers: config.tickers, category: config.category, aum: config.aumRange ?? null, ter: config.terRange ?? null,
    dividendYield: config.dividendYieldRange ?? null, secYield: config.secYieldRange ?? null,
    performance: config.performanceRanges, totalReturn: config.totalReturnRanges,
  });
}

async function readCursor(scope: string): Promise<string | null> {
  const file = path.join(API_ROOT, 'update-state.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed.scope !== undefined && parsed.scope !== scope) return null;
    return parsed.cursor ? String(parsed.cursor) : null;
  } catch {
    return null;
  }
}

/** A bounded batch: the funds after the cursor, wrapping around the end of the list, at most `max`. */
export function selectBatch<T extends { ticker: string }>(funds: T[], cursor: string | null, max: number): T[] {
  if (max <= 0 || !funds.length) return funds.slice();
  const at = cursor ? funds.findIndex((fund) => fund.ticker === cursor) : -1;
  const start = at >= 0 ? (at + 1) % funds.length : 0;
  return Array.from({ length: Math.min(max, funds.length) }, (_, offset) => funds[(start + offset) % funds.length]);
}

const NULL_METRICS = {
  ytd: null, tr1y: null, tr3y: null, tr5y: null, tr10y: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null,
  dividendYield: null, dividendYieldText: '—', dividendYieldBasis: null, distributionYield: null, distributionYieldText: '—', yield12M: null, yield12MText: '—',
  secYield: null, secYieldText: '—',
  returnsBasis: 'not available yet: this fund has not been read from its NEOS fund page',
  performanceAsOf: null,
};

/** Index row for a lineup fund that has no meta.json yet: full metrics shape, nothing invented, dataFile null. */
export function placeholderEntry(fund: LineupFund): CatalogEntry {
  const empty = { asOfDate: '', ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null, sinceInceptionCumulative: null };
  return {
    ticker: fund.ticker,
    name: fund.name,
    category: fund.category,
    fundPage: fund.fundPage || neosFundPageUrl(fund.ticker),
    dataFile: null,
    cusip: null, isin: null,
    ter: '—', terValue: null, terGross: null, terGrossValue: null,
    managementFee: fund.managementFeeText || null, managementFeeValue: fund.managementFee,
    nav: '—', navValue: null,
    aum: fund.netAssets === null ? '—' : formatAumDisplay(fund.netAssets), aumValue: fund.netAssets,
    asOfDate: '', inceptionDate: formatNeosDate(fund.inceptionDate), exchange: null,
    closePrice: '—', closePriceValue: null, premiumDiscount: '—', premiumDiscountValue: null,
    distributions: { frequency: fund.frequency || null, paymentsPerYear: null, exDate: null, dividend: null },
    returns: { monthEnd: { ...empty }, quarterEnd: { ...empty } },
    metrics: { ...NULL_METRICS },
    distributionFrequency: fund.frequency ? formatDistributionFrequency(fund.frequency) : null,
    providerCategory: fund.category,
    holdings: 0,
    history: 0,
  };
}

/** Soft deadline: stop taking new funds after this long so the index is still written inside the 30 minute job limit. */
export const SOFT_DEADLINE_MS = 25 * 60 * 1000;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// File defaults and explicit overrides, one mechanism for the CLI and the
// workflow: allowlisted scalar controls only, so GitHub Actions can resolve them
// without interpolating user input into bash. Precedence: config file <
// advanced JSON < nonblank inputs < environment (explicit env wins, blank
// included; HISTORICAL_PAGE_SIZE stays an alias of HISTORY_PAGE_SIZE).
export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'MAX_RETRIES', 'TICKERS', 'CATEGORY',
  'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD',
  ...['PERFORMANCE', 'TOTAL_RETURN'].flatMap((prefix) => ['YTD', '1Y', '3Y', '5Y', '10Y'].map((period) => `${prefix}_${period}`)),
  'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'HISTORY_RANGE', 'STORE_RAW_DOWNLOADS',
  'SEC_UA', 'EDGAR_FALLBACK', 'SKIP_YAHOO', 'SKIP_NEOS', 'VERBOSE', 'USE_SYSTEM_CA',
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
export const CONFIG_FILE_URL = new URL('./update-data.config.json', import.meta.url);
const CONTROL_ALIASES: Partial<Record<ControlName, string>> = { HISTORY_PAGE_SIZE: 'HISTORICAL_PAGE_SIZE' };

export function resolveControls(
  file: unknown = {},
  advanced: unknown = {},
  inputs: unknown = {},
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const known = new Set<string>(CONTROL_NAMES);
  const apply = (value: unknown, skipEmpty = false): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object');
    for (const [key, raw] of Object.entries(value)) {
      if (!known.has(key)) throw new Error(`Unknown updater control: ${key}`);
      if (skipEmpty && (raw === '' || raw === undefined || raw === null)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${key}: expected string, number or boolean`);
      const text = String(raw);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key}: multiline/control characters are not allowed`);
      result[key] = text;
    }
  };
  apply(file);
  apply(advanced);
  apply(inputs, true);
  for (const key of CONTROL_NAMES) {
    const alias = CONTROL_ALIASES[key];
    const value = env[key] ?? (alias ? env[alias] : undefined);
    if (value !== undefined) apply({ [key]: value });
  }
  for (const key of ['MAX_FETCHES', 'CONCURRENCY', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'MAX_RETRIES']) {
    const v = result[key];
    if (v === undefined || v.trim() === '') continue;
    const min = key === 'MAX_FETCHES' ? 0 : 1;
    if (!/^\d+$/.test(v.trim()) || !Number.isSafeInteger(Number(v)) || Number(v) < min) throw new Error(`${key}: expected integer >= ${min}`);
  }
  if (result.REQUEST_SLEEP?.trim() && (!Number.isFinite(Number(result.REQUEST_SLEEP)) || Number(result.REQUEST_SLEEP) < 0)) throw new Error('REQUEST_SLEEP: expected nonnegative seconds');
  for (const key of ['STORE_RAW_DOWNLOADS', 'EDGAR_FALLBACK', 'SKIP_YAHOO', 'SKIP_NEOS', 'VERBOSE']) {
    if (result[key]?.trim() && !/^(0|1|true|false|yes|no|y|n|on|off)$/i.test(result[key].trim())) throw new Error(`${key}: expected boolean`);
  }
  if (result.HISTORY_RANGE?.trim() && !/^(max|\d+y)$/i.test(result.HISTORY_RANGE.trim())) throw new Error('HISTORY_RANGE: expected max or Ny (for example 5y, 10y)');
  if (result.USE_SYSTEM_CA?.trim() && !/^(auto|true|false)$/i.test(result.USE_SYSTEM_CA.trim())) throw new Error('USE_SYSTEM_CA: expected auto, true or false');
  readConfig(result); // validate every min:max filter before any request or write
  return result;
}

export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  let file: unknown = {};
  try { file = JSON.parse(await readFile(CONFIG_FILE_URL, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return resolveControls(file, {}, {}, env);
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  if (process.argv.slice(2).some((arg) => arg === '-h' || arg === '--help')) {
    console.log(USAGE);
    return;
  }
  const controls = await runtimeControls(env);
  if (controls.VERBOSE !== undefined && env === process.env) process.env.VERBOSE = controls.VERBOSE;
  installSystemCa((controls.USE_SYSTEM_CA?.trim() || 'auto').toLowerCase());
  const runStartedAt = Date.now();
  const config = readConfig(controls);
  outputPrintConfig('Neos', config);
  resetSecState();
  const stats: RunStats = { updated: 0, unchanged: 0, skipped: 0, failed: 0 };

  // The lineup table is the catalog: it lists every fund, its asset class, the
  // declared distribution frequency and the headline figures.
  let lineup: LineupFund[] = [];
  const indexFile = path.join(API_ROOT, 'index.json');
  let previous: Record<string, CatalogEntry> = {};
  let previousGeneratedAt = '';
  if (existsSync(indexFile)) {
    try {
      const parsed = JSON.parse(await readFile(indexFile, 'utf8'));
      previousGeneratedAt = String(parsed.generatedAt || '');
      for (const fund of parsed.funds || []) previous[fund.ticker] = fund;
    } catch {
      previous = {};
    }
  }

  if (!config.skipNeos) {
    const home = await fetchText(`${NEOS_SITE}/`, browserHeaders(), config, 'NEOS home page');
    if (config.storeRawDownloads) await writeIfChanged(path.join(API_ROOT, 'raw', 'lineup.html'), home);
    const categories = parseNeosCategoryCards(home);
    lineup = parseNeosLineup(home).map((fund) => ({
      ...fund,
      category: categories.get(fund.ticker) || fund.category || 'Other',
    }));
    if (!lineup.length) throw new Error('lineup: the #explore-etfs #etf-table was not found on neosfunds.com');
  } else {
    // SKIP_NEOS: the published funds are the catalog (a catalog-only row has nothing to refresh)
    lineup = Object.values(previous).filter((entry) => entry.dataFile).map((entry) => ({
      ticker: String(entry.ticker),
      name: String(entry.name || ''),
      category: String(entry.category || ''),
      categoryClass: '',
      frequency: String((entry as any).distributions?.frequency || ''),
      distributionRate: readNumber(entry, 'dividendYield'),
      distributionRateText: '',
      secYield: null,
      secYieldText: '',
      managementFee: readNumber(entry, 'terValue'),
      managementFeeText: String(entry.ter || ''),
      netAssets: readNumber(entry, 'aumValue'),
      netAssetsText: String(entry.aum || ''),
      inceptionDate: String(entry.inceptionDate || ''),
      fundPage: String(entry.fundPage || ''),
    }));
  }

  console.log(`[ catalog  ] ${lineup.length} Neos ETFs (${config.skipNeos ? 'published index' : 'neosfunds.com lineup'})`);

  // The live catalog (null when only the published feed is known, SKIP_NEOS): a catalog-only row it no longer lists is dropped.
  const live = config.skipNeos ? null : lineup.map((fund) => fund.ticker);
  // Q27: a TICKERS entry outside the live lineup and the published funds (a closed fund keeps its data) stops the run before any fund request
  if (config.tickers.length) assertKnownTickers(config.tickers, knownTickers(live, Object.values(previous)), 'the NEOS lineup or published feed');

  const scope = filterScope(config);
  // Closed funds leave the run before any request and before the MAX_FETCHES budget: never fetched, guarded or reported.
  const filtered = withoutClosedFunds(lineup.filter((fund) => passesFilters(fund, config)), (fund) => fund.ticker, CLOSED_FUNDS);
  const cursor = config.maxFetches > 0 ? await readCursor(scope) : null;
  const candidates = selectBatch(filtered, cursor, config.maxFetches);

  outputPrintFilter(candidates.length, lineup.length, outputHasOutputFilters({ ...config, tickers: [] }));
  const output = outputCreateReporter(API_ROOT, candidates.length);
  if (cursor) console.log(`[ cursor   ] resuming after ${cursor}`);

  const byTicker = new Map<string, CatalogEntry>();
  const queue = candidates.slice();
  let taken = 0;
  let deadlineHit = false;
  const startedAt = Date.now();
  const laneCount = Math.max(1, config.concurrency);
  lastRequestAtLanes = new Array(laneCount).fill(0);
  const workers = Array.from({ length: laneCount }, async () => {
    for (;;) {
      if (Date.now() - startedAt > (config.deadlineMs ?? SOFT_DEADLINE_MS)) {
        if (queue.length) deadlineHit = true;
        return;
      }
      const fund = queue.shift();
      if (!fund) return;
      taken += 1;
      const before = await output.before(fund.ticker);
      try {
        const entry = config.skipNeos
          ? await refreshHistoryOnly(fund, previous[fund.ticker], config, stats)
          : await updateFund(fund, config, stats, (candidate) => passesReturnFilters(candidate, config));
        if (!entry) {
          stats.skipped += 1;
          await output.result(fund.ticker, before, 'skipped', 'return filter');
          continue;
        }
        byTicker.set(fund.ticker, entry);
        await output.result(fund.ticker, before);
      } catch (error) {
        stats.failed += 1;
        await output.result(fund.ticker, before, 'failed', errorMessage(error));
      }
    }
  });
  await Promise.all(workers);
  if (deadlineHit) console.log(`[ deadline ] soft deadline reached: ${queue.length} fund(s) not taken, their previous data is kept`);

  // Previously published entries are preserved so a bounded or failed run can
  // never empty the site; lineup funds without data get a placeholder row (dataFile null).
  const rows: Record<string, CatalogEntry> = {};
  for (const row of withoutStalePlaceholders(Object.values(previous), live)) rows[row.ticker] = row;
  for (const fund of lineup) {
    if (!rows[fund.ticker]) {
      rows[fund.ticker] = placeholderEntry(fund);
    }
  }
  for (const [ticker, entry] of byTicker) rows[ticker] = entry;
  for (const ticker of Object.keys(rows)) rows[ticker] = withYieldBasis(rows[ticker]);

  // the 52-week range of every row from its published history pages (shared range-52w block)
  const funds = await withRange52w(API_ROOT, markClosedFunds(Object.values(rows).sort((a, b) => String(a.ticker).localeCompare(String(b.ticker))), CLOSED_FUNDS));
  const counts = {
    funds: funds.length,
    holdings: funds.reduce((sum, fund) => sum + Number(fund.holdings || 0), 0),
    history: funds.reduce((sum, fund) => sum + Number(fund.history || 0), 0),
  };
  const index = {
    // Kept from the previous file so an unchanged rerun produces an empty diff;
    // advanced below only when the serialized bytes actually moved.
    generatedAt: previousGeneratedAt,
    source: {
      provider: 'NEOS Investment Management LLC (NEOS ETFs)',
      market: 'us',
      site: NEOS_SITE,
      catalog: NEOS_LINEUP_URL,
      catalogNote: 'Server-rendered "Explore Our ETFs" table (#explore-etfs → #etf-table); five asset-class groups.',
      fundPages: `${NEOS_SITE}/<ticker>/`,
      holdings: `${NEOS_ADMIN_AJAX_URL}?action=download_holdings_csv&ticker=<TICKER>`,
      holdingsNote: 'Official daily full-holdings CSV behind the fund page "Download Full Holdings" button.',
      history: 'Yahoo Finance public chart API (daily Close / Adj Close / Volume)',
      distributions: 'NEOS fund page Distribution History calendar',
      nportRegistrant: `SEC EDGAR Form N-PORT-P, NEOS ETF Trust CIK ${NEOS_ETF_TRUST_CIK} (holdings fallback only)`,
      registrant: `NEOS ETF Trust (Investment Company Act file ${NEOS_ETF_TRUST_FILE_NUMBER})`,
      exchange: 'NEOS fund page Fund Details "Primary Exchange", Yahoo Finance chart meta as fallback',
    },
    counts,
    funds,
  };
  const nowStamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  // generatedAt moves only when some content moved; an identical rerun writes nothing.
  await writeJsonIfContentChanged(indexFile, index, ['generatedAt'], nowStamp);
  // Q28: a fund is announced on its first successful publish (a catalog-only row is not published), new catalog-only rows as pending
  const newFunds = newFundsLines(newFundsReport(Object.values(previous), funds));
  for (const line of newFunds) console.log(line);
  if (newFunds.length && process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### NEW FUNDS\n\n${newFunds.join('\n')}\n`, 'utf8');

  if (config.maxFetches > 0 && taken > 0) {
    await writeJsonIfContentChanged(
      path.join(API_ROOT, 'update-state.json'),
      { cursor: candidates[taken - 1].ticker, scope },
      ['savedAt'],
      nowStamp,
    );
  } else if (config.maxFetches === 0 && scope === filterScope(readConfig({})) && existsSync(path.join(API_ROOT, 'update-state.json'))) {
    // Only a full unfiltered pass resets the cursor; a TICKERS or filtered run leaves it alone.
    await rm(path.join(API_ROOT, 'update-state.json'));
  }

  console.log(output.summary(runStartedAt));
  console.log(outputCounts(counts.funds, counts.holdings, counts.history));
  if (taken > 0 && stats.failed === taken) throw new Error(`every fund failed (${stats.failed} of ${taken})`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exit(1);
  });
}

// <holdings-guard> shared block of .claude/tools/etfs/etf-std/holdings-guard.block.ts, applied by apply-holdings-guard.ts: never edit it in one repo
/**
 * Sanity check of a fund's new holdings before they replace the published ones. Returns why they must be rejected
 * (the caller then keeps the fund's previous state and reports it as failed), or null when they may be written.
 * An empty sheet passes only when nothing was published before. Otherwise a Name and a weight column (Weight,
 * Weight (%) or Market Weight) are required, >= 80% of the rows carry a numeric weight, the weights add up to
 * 50..150 and the sheet keeps >= 50% of the previously published rows. `relax` switches off the checks a fund
 * legitimately fails: 'numeric' and 'sum' (geared, inverse, futures, look-through, top-N lists) and 'count'. No relax lets
 * a sheet without a single numeric weight replace a published sheet that had numeric weights (`previousWeights`: how many
 * rows of the published sheet carry a numeric weight, see holdingsWeightCount; open-items etfs Q24).
 * Rows are arrays in header order or objects keyed by the header text. A fund in the brand's CLOSED_FUNDS never reaches the guard.
 */
export function holdingsGuard(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, previousRows: number | null | undefined, relax: ReadonlyArray<string> = [], previousWeights: number | null = null): string | null {
  const previous = Number(previousRows) > 0 ? Number(previousRows) : 0;
  if (!rows.length) return previous ? `no holdings rows (${previous} published)` : null;
  const names = headers.map((header) => String(header).trim().toLowerCase());
  const nameAt = names.indexOf('name');
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  if (nameAt < 0 || weightAt < 0) return `no ${nameAt < 0 ? 'Name' : 'weight'} column (headers: ${headers.join(', ') || 'none'})`;
  const weights = holdingsGuardWeights(headers, rows, weightAt);
  const numeric = weights.count;
  const sum = weights.sum;
  if (numeric === 0 && Number(previousWeights) > 0) return `no row has a numeric weight, the published sheet had ${Number(previousWeights)}`;
  if (relax.indexOf('numeric') < 0 && numeric < rows.length * 0.8) return `only ${numeric} of ${rows.length} rows have a numeric weight`;
  if (relax.indexOf('sum') < 0 && (sum < 50 || sum > 150)) return `weights add up to ${sum.toFixed(2)}, outside 50..150`;
  if (relax.indexOf('count') < 0 && previous && rows.length < previous * 0.5) return `${rows.length} rows, less than half of the ${previous} published`;
  return null;
}

/** How many rows carry a numeric weight (Weight, Weight (%) or Market Weight column), 0 without such a column: pass it for the published sheet as holdingsGuard's previousWeights. */
export function holdingsWeightCount(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>): number {
  const names = headers.map((header) => String(header).trim().toLowerCase());
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  return weightAt < 0 ? 0 : holdingsGuardWeights(headers, rows, weightAt).count;
}

/** Count and sum of the numeric weights in column weightAt; rows are arrays in header order or objects keyed by the header text. */
function holdingsGuardWeights(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, weightAt: number): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const row: any = rows[i];
    const weight = holdingsGuardNumber(Array.isArray(row) ? row[weightAt] : row && typeof row === 'object' ? row[headers[weightAt]] : undefined);
    if (weight !== null) {
      count++;
      sum += weight;
    }
  }
  return { count, sum };
}

/** A weight cell as a number: %, $, commas and spaces are ignored, (x) is negative; null when it is no plain number (a zero-width character inside counts as broken). */
function holdingsGuardNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value === null || value === undefined ? '' : value).replace(/[ \t ,%$]/g, '').replace(/−/g, '-');
  const negative = /^\(.*\)$/.test(text);
  if (negative) text = text.slice(1, -1);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  return negative ? -Number(text) : Number(text);
}

/** A fund its issuer closed (liquidated, delisted or merged away), confirmed from an official source: an SEC filing or the issuer's notice. */
export type ClosedFund = { ticker: string; closed: string; source: string };

/**
 * The brand's CLOSED_FUNDS entry for a ticker, or null. A closed fund is never fetched, never guarded and never reported failed: it keeps
 * its last published data and its index row carries `status: 'closed'`, `closedDate` and `closedSource`. A malformed entry throws, so a
 * typo (no ISO date, no https source) never ships.
 */
export function closedFund(list: ReadonlyArray<ClosedFund>, ticker: unknown): ClosedFund | null {
  const wanted = String(ticker === null || ticker === undefined ? '' : ticker).trim().toUpperCase();
  let found: ClosedFund | null = null;
  for (let i = 0; i < list.length; i++) {
    const fund = list[i];
    if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(fund.ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(fund.closed) || !/^https:\/\/\S+$/.test(fund.source)) throw new Error(`CLOSED_FUNDS: ${fund.ticker} needs an upper-case ticker, an ISO closing date and an https source`);
    if (fund.ticker === wanted) found = fund;
  }
  return found;
}

/** The index rows with every closed fund marked (`status: 'closed'`, `closedDate`, `closedSource`); other rows are returned as they are. */
export function markClosedFunds<T extends object>(rows: ReadonlyArray<T>, list: ReadonlyArray<ClosedFund>): T[] {
  return rows.map((row) => {
    const fund = closedFund(list, (row as { ticker?: unknown }).ticker);
    return fund ? ({ ...row, status: 'closed', closedDate: fund.closed, closedSource: fund.source } as T) : row;
  });
}

/** A run's queue without the closed funds, which are named once in the log: they are neither fetched nor counted as failed. */
export function withoutClosedFunds<T>(queue: ReadonlyArray<T>, tickerOf: (item: T) => string, list: ReadonlyArray<ClosedFund>): T[] {
  const closed: string[] = [];
  const open: T[] = [];
  for (let i = 0; i < queue.length; i++) {
    if (closedFund(list, tickerOf(queue[i]))) closed.push(tickerOf(queue[i]));
    else open.push(queue[i]);
  }
  if (closed.length) console.log(`[ closed   ] ${closed.join(', ')}: closed by the issuer, published data kept`);
  return open;
}
// </holdings-guard>

// <nport-reader> shared block of .claude/tools/etfs/etf-std/nport-reader.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * SEC EDGAR Form N-PORT-P holdings reader (open-items etfs ETF-H2), one copy for every brand. Pure functions plus one reader
 * that takes the brand's own `getText(url, label)` (its SEC User-Agent, timeout, retries and pacing). Rules it enforces:
 * - identifiers come from the position itself: `<cusip>` text (or a `value` attribute), `<isin value>`, `<ticker value>`,
 *   `<other value>`; a derivative's reference instrument (inside `<derivativeInfo>`) never lends its identifiers to the position
 * - CUSIP `000000000` and `N/A` are missing; a missing weight or value is null (an empty cell), never 0
 * - a ticker only for a common-stock row (assetCat EC, not a CVR, right, warrant or escrow line) traded in USD with a U.S.
 *   ISIN or none, or with a foreign ISIN when the Nasdaq Trader directories list that ticker for the same company (a U.S.
 *   listing such as Linde, NXP, IMAX); renamed issuers through `nportRenamedIssuers`; an abbreviated or reordered name the
 *   exact key misses through a looser key that must name one company (`nportLooseKey`, Q35: `Lowe's Cos` = `LOWES COMPANIES`,
 *   `SCHWAB CHARLES CORP`); never one ticker on two different securities (`nportTickers`)
 * - identity: the filing must name the fund's own series id, or, with no series id known, the fund's name (`nportIdentity`)
 * - freshness: the report period must be strictly newer than the published holdings (`nportIsFresh`)
 * - filings come newest report period first from the registrant's own archive folder, never from the filer agent's CIK
 *   (the accession number prefix)
 */
export type NportPosition = {
  name: string;
  title: string;
  lei: string;
  cusip: string;
  isin: string;
  ticker: string;
  other: string;
  otherDesc: string;
  balance: number | null;
  units: string;
  currency: string;
  /** valUSD, null when the filing has none */
  value: number | null;
  /** pctVal: percent of net assets (0.5 = 0.5%), null when the filing has none */
  weight: number | null;
  payoff: string;
  assetCat: string;
  issuerCat: string;
  country: string;
  /** derivCat of the position's derivativeInfo (FUT, FWD, SWP, OPT, ...), empty for a security */
  derivative: string;
  /** debtSec annualizedRt and maturityDt (ISO), null and '' for a non-debt row */
  coupon: number | null;
  maturity: string;
};

export type NportFiling = {
  seriesId: string;
  seriesName: string;
  regName: string;
  regCik: string;
  /** report period end (genInfo repPdDate) as ISO, '' when missing */
  repPdDate: string;
  netAssets: number | null;
  totalAssets: number | null;
  positions: NportPosition[];
};

export type NportCandidate = { accession: string; filed: string; period: string; cik: string };
export type NportSeriesRef = { cik: string; seriesId: string; classId: string };

/** XML text: entities decoded, tags dropped, whitespace collapsed. */
function nportText(raw: string): string {
  return String(raw)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m: string, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Text of the first `<tag>` (any namespace prefix) in `xml`, '' when absent. */
function nportTag(xml: string, tag: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** The `attribute` of the first `<tag ...>` (any namespace prefix) in `xml`, '' when absent. */
function nportAttr(xml: string, tag: string, attribute: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}\\s[^>]*?\\b${attribute}\\s*=\\s*"([^"]*)"`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** A plain decimal or exponent number, null for an empty, N/A or broken cell. */
function nportNumber(raw: string): number | null {
  const text = String(raw).replace(/[\s,]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** An identifier code, '' for N/A, NONE and all zeros (CUSIP 000000000 means "no CUSIP"). */
function nportCode(raw: string): string {
  const text = String(raw).trim().toUpperCase();
  return !text || /^(N\/?A|NONE|-+|0+)$/.test(text) ? '' : text;
}

/** ISO date of an N-PORT date (YYYY-MM-DD, possibly with a time), '' otherwise. */
function nportIso(raw: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw === null || raw === undefined ? '' : raw).trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

/** One N-PORT-P primary_doc.xml (or the full submission .txt that embeds it) as series facts and positions. */
export function parseNportFiling(xml: string): NportFiling {
  const text = String(xml === null || xml === undefined ? '' : xml);
  const genInfo = /<(?:[A-Za-z0-9_.-]+:)?genInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?genInfo>/i.exec(text);
  const fundInfo = /<(?:[A-Za-z0-9_.-]+:)?fundInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?fundInfo>/i.exec(text);
  const gen = genInfo ? genInfo[1] : '';
  const fund = fundInfo ? fundInfo[1].replace(/<(?:[A-Za-z0-9_.-]+:)?returnInfo\b[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?returnInfo>/gi, ' ') : '';
  const positions: NportPosition[] = [];
  const blocks = /<(?:[A-Za-z0-9_.-]+:)?invstOrSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?invstOrSec>/gi;
  let block: RegExpExecArray | null;
  while ((block = blocks.exec(text)) !== null) {
    const raw = block[1];
    const derivativeInfo = /<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/i.exec(raw);
    // The reference instrument of a derivative (SPY for a SPY option, a bond for a CDS) is another security: drop it first.
    const own = raw.replace(/<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/gi, ' ');
    const identifiers = /<(?:[A-Za-z0-9_.-]+:)?identifiers\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?identifiers>/i.exec(own);
    const ids = identifiers ? identifiers[1] : '';
    const debt = /<(?:[A-Za-z0-9_.-]+:)?debtSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?debtSec>/i.exec(own);
    const name = nportTag(own, 'name');
    positions.push({
      name: name && !/^N\/?A$/i.test(name) ? name : nportTag(own, 'title'),
      title: nportTag(own, 'title'),
      lei: nportCode(nportTag(own, 'lei')),
      cusip: nportCode(nportTag(own, 'cusip') || nportAttr(ids, 'cusip', 'value')),
      isin: nportCode(nportAttr(ids, 'isin', 'value')),
      ticker: nportCode(nportAttr(ids, 'ticker', 'value')),
      other: nportCode(nportAttr(ids, 'other', 'value')),
      otherDesc: nportAttr(ids, 'other', 'otherDesc'),
      balance: nportNumber(nportTag(own, 'balance')),
      units: nportTag(own, 'units'),
      currency: (nportTag(own, 'curCd') || nportAttr(own, 'currencyConditional', 'curCd')).toUpperCase(),
      value: nportNumber(nportTag(own, 'valUSD')),
      weight: nportNumber(nportTag(own, 'pctVal')),
      payoff: nportTag(own, 'payoffProfile'),
      assetCat: (nportTag(own, 'assetCat') || nportAttr(own, 'assetConditional', 'assetCat')).toUpperCase(),
      issuerCat: (nportTag(own, 'issuerCat') || nportAttr(own, 'issuerConditional', 'issuerCat')).toUpperCase(),
      country: nportTag(own, 'invCountry').toUpperCase(),
      derivative: derivativeInfo ? (/\bderivCat\s*=\s*"([^"]*)"/i.exec(derivativeInfo[1]) || ['', 'OTHER'])[1].toUpperCase() : '',
      coupon: debt ? nportNumber(nportTag(debt[1], 'annualizedRt')) : null,
      maturity: debt ? nportIso(nportTag(debt[1], 'maturityDt')) : '',
    });
  }
  return {
    seriesId: nportTag(gen, 'seriesId').toUpperCase(),
    seriesName: nportTag(gen, 'seriesName'),
    regName: nportTag(gen, 'regName'),
    regCik: nportTag(gen, 'regCik').replace(/\D/g, ''),
    repPdDate: nportIso(nportTag(gen, 'repPdDate')),
    netAssets: nportNumber(nportTag(fund, 'netAssets')),
    totalAssets: nportNumber(nportTag(fund, 'totAssets')),
    positions,
  };
}

/**
 * A number as sheet text: '' for null, no exponent, at most `digits` decimals (trailing zeros dropped), and no binary float
 * artifact: `115797518.01` stays `115797518.01`, not the `115797518.01000001` of `toFixed(8)`.
 */
export function nportCell(value: number | null, digits = 8): string {
  if (value === null || !Number.isFinite(value)) return '';
  const fixed = value.toFixed(digits);
  // the shortest text of the rounded number; toFixed only where that text would be an exponent (very small or large numbers)
  const shortest = String(Number(fixed));
  if (!/e/i.test(shortest)) return shortest;
  return fixed.indexOf('.') < 0 ? fixed : fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/** The position's own identifier for a sheet: CUSIP, else ISIN, else the "other" code (a Bloomberg or internal id), else ''. */
export function nportIdentifier(position: NportPosition): string {
  return position.cusip || position.isin || position.other;
}

/**
 * A company name as a lookup key: upper case, punctuation and legal suffixes dropped, `CLASS A` -> `CL A`. Initials are one
 * word whether written with dots, spaces or a slash (`N.V.` = `N V` = `NV`, `C.H. ROBINSON` = `C H ROBINSON`, `A/S` = `A S`,
 * `S.A.B. de C.V.` = `SAB DE CV`), `PUBLIC LIMITED COMPANY` is `plc`, and a leading `US` stays (`U.S. BANCORP` is not
 * `BANCORP, INC.`), so both spellings of one issuer give one key.
 */
export function nportNameKey(value: unknown): string {
  // EDGAR adds a state or qualifier suffix to company titles ("COSTCO WHOLESALE CORP /NEW", "BANK OF AMERICA CORP /DE/",
  // "US BANCORP \DE\", "ACUITY INC. (DE)"): drop a trailing one
  const raw = String(value === null || value === undefined ? '' : value).replace(/(?:\s*(?:[\/\\]\s*[A-Za-z]{2,3}\s*[\/\\]?|\(\s*[A-Za-z]{2,3}\s*\)))+\s*$/, '');
  let text = nportText(raw).toUpperCase().replace(/['’]/g, '').replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim();
  text = text.replace(/\bCLASS\s+([A-Z])\b/g, 'CL $1').replace(/\bCL\s+([A-Z])\b/g, 'CL $1');
  // a run of single letters is one word, never the class letter after CL
  const words: string[] = [];
  let joining = false;
  text.split(' ').forEach((word) => {
    const letter = /^[A-Z]$/.test(word);
    if (letter && joining) words[words.length - 1] += word;
    else words.push(word);
    joining = letter && (joining || words[words.length - 2] !== 'CL');
  });
  text = words.join(' ').replace(/\bPUBLIC (?:(?:LIMITED|LTD)(?: (?:COMP[A-Z]*|CO))?|(?:COMPANY|CO) (?:LIMITED|LTD))\b/g, 'PLC').replace(/\b(?:S DE RL )?DE CV\b/g, ' ');
  const share = /\bCL [A-Z]\b/.exec(text);
  text = text.replace(/\b(THE|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|SA|SAB|NV|AG|SE|SPA|AS|ASA|ORDINARY|COMMON|STOCK|SHS|SHARES|ADR|DEPOSITARY|RECEIPT|USD|US|REG|REGISTERED)\b/g, (word: string, _name: string, at: number) => (word === 'US' && at === 0 ? word : ' ')).replace(/\s+/g, ' ').trim();
  if (share && !/\bCL [A-Z]\b/.test(text)) text = `${text} ${share[0]}`;
  return text;
}

/**
 * Abbreviated words of issuer names (open-items etfs Q35) -> one spelling, each seen in N-PORT-P filings of the brands against
 * the SEC company_tickers.json title of the same CUSIP issuer (2026-10-26): `LOWES COS` / `LOWES COMPANIES`, `AMERIPRISE FINL`,
 * `VICI PPTYS`, `TAIWAN SEMICONDUCTOR MFG`, `ZIONS BANCORP NA` / `ZIONS BANCORPORATION NATIONAL ASSOCIATION`. '' drops the word.
 */
function nportLooseWords(): Record<string, string> {
  return {
    COS: '', COMPANIES: '', AND: '', OF: '', NA: '', NATIONAL_ASSOCIATION: '', INCORPORATION: '', REIT: '',
    BANCORPORATION: 'BANCORP', FINL: 'FINANCIAL', PPTYS: 'PROPERTIES', PPTY: 'PROPERTY', MFG: 'MANUFACTURING', GRP: 'GROUP',
    HLDGS: 'HOLDINGS', HLDG: 'HOLDING', INTL: 'INTERNATIONAL', SVCS: 'SERVICES', TECH: 'TECHNOLOGIES', TECHNOLOGY: 'TECHNOLOGIES',
    SYS: 'SYSTEMS', NATL: 'NATIONAL', RES: 'RESOURCES', RLTY: 'REALTY', INDS: 'INDUSTRIES', INS: 'INSURANCE', BROS: 'BROTHERS', SVGS: 'SAVINGS',
  };
}

/**
 * The second, looser company key (open-items etfs Q35), used only for a row the exact key (`nportNameKey`) left without a
 * ticker: a Bloomberg location or article after a slash dropped (`Charles Schwab Corp/The`, `Energy Fuels Inc/canada`; never a
 * one-word start like `RE/MAX`), abbreviations read as one word (`nportLooseWords`), the share class dropped (the caller picks
 * the class) and the words sorted, so EDGAR's reordered titles meet the usual order: `SCHWAB CHARLES CORP` = `Charles Schwab
 * Corp`, `HORTON D R INC` = `DR Horton Inc`, `PRICE T ROWE GROUP INC` = `T Rowe Price Group Inc`. Several companies can share a
 * loose key: `parseSecCompanyNames` and `parseUsListings` keep such a key empty, so it never gives a ticker.
 */
export function nportLooseKey(value: unknown): string {
  let raw = String(value === null || value === undefined ? '' : value).trim();
  const slash = /^(.*\s\S*[A-Za-z]{2}[.,]?)\s*\/\s*([A-Za-z][A-Za-z .,']*)$/.exec(raw);
  if (slash) raw = slash[1];
  // a trailing EDGAR or Bloomberg qualifier after the legal form: `CHEVRON CORP NEW`, `US BANCORP DEL`, `PROGRESSIVE CORP OHIO`
  raw = raw.replace(/\b(CORP(?:ORATION)?|INC(?:ORPORATED)?|CO(?:MPANY)?|LTD|BANCORP|GROUP|GRP|TRUST|HOLDINGS?)\.?,?\s+(?:NEW|DEL|REINCORPORATION|OHIO|AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\.?$/i, '$1');
  const words = nportLooseWords();
  const key = nportNameKey(raw).replace(/ CL [A-Z]$/, '').replace(/\bNATIONAL ASSOCIATION\b/g, 'NATIONAL_ASSOCIATION');
  return key.split(' ').map((word) => (Object.prototype.hasOwnProperty.call(words, word) ? words[word] : word)).filter(Boolean).sort().join(' ');
}

/**
 * SEC company_tickers.json -> name key -> ticker (the first, largest company wins a shared key; the class-less key is added too).
 * Each loose key (`nportLooseKey`) is added as `\u0001<loose key>` -> the company's tickers, space-separated in the table's
 * order, or '' when two companies (CIKs) share it; `nportTickers` reads them for rows the exact key misses.
 */
export function parseSecCompanyNames(payload: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const loose = new Map<string, { cik: string; tickers: string[] } | null>();
  const rows = payload && typeof payload === 'object' ? Object.keys(payload as object).map((key) => (payload as Record<string, unknown>)[key]) : [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { ticker?: unknown; title?: unknown; cik_str?: unknown } | null;
    if (!row || typeof row !== 'object') continue;
    const ticker = String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
    const key = nportNameKey(row.title);
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || !key) continue;
    if (!names.has(key)) names.set(key, ticker);
    const core = key.replace(/ CL [A-Z]$/, '');
    if (core && !names.has(core)) names.set(core, ticker);
    const looseKey = nportLooseKey(row.title);
    const cik = String(row.cik_str === null || row.cik_str === undefined ? '' : row.cik_str).replace(/\D/g, '');
    if (!looseKey || !Number(cik)) continue;
    const seen = loose.get(looseKey);
    if (seen === undefined) loose.set(looseKey, { cik: String(Number(cik)), tickers: [ticker] });
    else if (seen && seen.cik === String(Number(cik))) { if (seen.tickers.indexOf(ticker) < 0) seen.tickers.push(ticker); }
    else loose.set(looseKey, null);
  }
  loose.forEach((seen, looseKey) => names.set(`\u0001${looseKey}`, seen ? seen.tickers.join(' ') : ''));
  return names;
}

/** SEC company_tickers_mf.json -> fund ticker -> registrant CIK (10 digits), series id, class id. */
export function parseSecFundTickers(payload: unknown): Map<string, NportSeriesRef> {
  const map = new Map<string, NportSeriesRef>();
  const record = (payload && typeof payload === 'object' ? payload : {}) as { fields?: unknown; data?: unknown };
  const fields = Array.isArray(record.fields) ? record.fields.map(String) : [];
  const rows = Array.isArray(record.data) ? record.data : [];
  const at = (row: unknown[], field: string): string => (fields.indexOf(field) < 0 ? '' : String(row[fields.indexOf(field)] === null || row[fields.indexOf(field)] === undefined ? '' : row[fields.indexOf(field)]).trim());
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const ticker = at(row, 'symbol').toUpperCase();
    const cik = at(row, 'cik').replace(/\D/g, '');
    const seriesId = at(row, 'seriesId').toUpperCase();
    if (!ticker || !Number(cik) || !/^S\d{9}$/.test(seriesId) || map.has(ticker)) continue;
    map.set(ticker, { cik: `0000000000${Number(cik)}`.slice(-10), seriesId, classId: at(row, 'classId').toUpperCase() });
  }
  return map;
}

/**
 * Is the row a contingent value right, a right, a warrant or an escrow line filed as equity? A placeholder CUSIP or ISIN
 * (`436CVR021`, `US009CVR0445`, `549ESC028`, `866CNT017`) says so; so does the name or title (`NOVO NORDISK A/S - CVR`,
 * `XYZ INC RIGHTS`, `... WARRANT FEB 2026`, `Luby's Inc Escrow`), except on a CUSIP with the common-stock issue number 10
 * (Schwab titles Enovix common stock 293594107 "Enovix Corp Warrants"). `CVR` as the first word is a company (CVR Energy).
 */
function nportIsRight(position: NportPosition): boolean {
  if (/^[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.cusip) || /^US[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.isin)) return true;
  if (/^[0-9A-Z]{6}10[0-9]$/.test(position.cusip)) return false;
  return [position.name, position.title].some((text) => /\S\s*\bCVRS?\b|\bCONTINGENT\b|\bRIGHTS?\b|\bRTS\b|\bWARRANTS?\b|\bWTS\b|\bESCROW\b/i.test(text));
}

/**
 * Renamed issuers (open-items etfs Q33): N-PORT filers keep an issuer's old name for months while SEC's company_tickers.json
 * titles only the new one, so the name match misses (JPMorgan JEPI's Exxon). Old name key (`nportNameKey`) -> [ticker, CUSIP
 * issuer number (the first six characters)]. Used only when the SEC table has no such key, the row's CUSIP (or U.S. ISIN) has
 * that issuer number and the SEC table still lists the ticker. Each entry was confirmed on 2026-10-26: an EC row without a
 * ticker in the N-PORT-P filings of large U.S. equity funds (VTI, SCHB, ITOT, JEPI, IWB, VB, SCHA, FNDX, FNDA, ...) whose name
 * is a former EDGAR name of the CIK that has the ticker today (data.sec.gov submissions `formerNames`, the date the old name
 * ended), the ticker the CIK's only common stock in the Nasdaq Trader directories. Add an entry only with the same evidence.
 * A function, not a const: blocks sit at the end of update-data.ts, below the top-level run, so only declarations are hoisted.
 */
export function nportRenamedIssuers(): Array<[string, string, string]> {
  return [
    ['AADI BIOSCIENCE', 'WHWK', '00032Q'], // CIK 1422142 Whitehawk Therapeutics, Inc., former EDGAR name until 2025-03-18
    ['ABACUS LIFE', 'ABX', '00258Y'], // CIK 1814287 Abacus Global Management, Inc., former EDGAR name until 2025-02-04
    ['ACUITY BRANDS', 'AYI', '00508Y'], // CIK 1144215 ACUITY INC. (DE), former EDGAR name until 2025-04-17
    ['AEROVATE THERAPEUTICS', 'JBIO', '008064'], // CIK 1798749 Jade Biosciences, Inc., former EDGAR name until 2025-04-30
    ['AILERON THERAPEUTICS', 'RNTX', '00887A'], // CIK 1420565 Rein Therapeutics, Inc., former EDGAR name until 2024-12-09
    ['ALLOVIR', 'KLRS', '482929'], // CIK 1754068 Kalaris Therapeutics, Inc., former EDGAR name until 2025-03-12
    ['AMC NETWORKS', 'AMCX', '00164V'], // CIK 1514991 AMC Global Media Inc., former EDGAR name until 2026-04-03
    ['AMMO', 'POWW', '00175J'], // CIK 1015383 Outdoor Holding Co, former EDGAR name until 2025-04-24
    ['ARDENT HEALTH PARTNERS', 'ARDT', '03980N'], // CIK 1756655 Ardent Health, Inc., former EDGAR name until 2025-05-23
    ['ARENA GROUP HOLDINGS', 'PAAI', '040044'], // CIK 894871 Paradium.AI, Inc., former EDGAR name until 2026-08-13
    ['ATEGRITY SPECIALTY HOLDINGS LLC', 'ASIC', '04681Y'], // CIK 2040491 Ategrity Specialty Insurance Co Holdings, former EDGAR name until 2025-06-11
    ['BAKKT HOLDINGS', 'BKKT', '05759B'], // CIK 1820302 Bakkt, Inc., former EDGAR name until 2026-01-20
    ['BED BATH AND BEYOND', 'NXH', '690370'], // CIK 1130713 NEIGHBORHOOD INTELLIGENCE, INC., former EDGAR name until 2026-08-14
    ['BLACKROCK FUNDING', 'BLK', '09290D'], // CIK 2012383 BlackRock, Inc., former EDGAR name until 2024-10-01
    ['BRIGHTSPHERE INVESTMENT GROUP', 'AAMI', '10948W'], // CIK 1748824 Acadian Asset Management Inc., former EDGAR name until 2024-11-14
    ['CARA THERAPEUTICS', 'TVRD', '140755'], // CIK 1346830 Tvardi Therapeutics, Inc., former EDGAR name until 2025-04-11
    ['CEA INDUSTRIES', 'BNC', '86887P'], // CIK 1482541 BNB Standard Corp, former EDGAR name until 2026-09-21
    ['CHROMADEX', 'NAGE', '171077'], // CIK 1386570 Niagen Bioscience, Inc., former EDGAR name until 2025-03-10
    ['CLEANCORE SOLUTIONS', 'ZONE', '184492'], // CIK 1956741 Zone Frontier Inc., former EDGAR name until 2026-08-20
    ['CORPORATE OFFICE PROPERTIES TRUST', 'CDP', '22002T'], // CIK 860546 COPT DEFENSE PROPERTIES, former EDGAR name until 2023-09-14
    ['CULLINAN ONCOLOGY', 'CGEM', '230031'], // CIK 1789972 Cullinan Therapeutics, Inc., former EDGAR name until 2024-04-02
    ['DIME COMMUNITY BANCSHARES', 'DCOM', '25432X'], // CIK 846617 Dime Commercial Bancshares, Inc. /NY/, former EDGAR name until 2026-05-27
    ['DOMO', 'HUCK', '257554'], // CIK 1505952 Huckleberry.ai, Inc., former EDGAR name until 2026-09-03
    ['EASTSIDE DISTILLING', 'BLNE', '277802'], // CIK 1534708 Beeline Holdings, Inc., former EDGAR name until 2025-03-11
    ['EQUITY RESIDENTIAL', 'VMRK', '29476L'], // CIK 906107 VIVMARK RESIDENTIAL, former EDGAR name until 2026-08-12
    ['EXP WORLD HOLDINGS', 'AGNT', '30212W'], // CIK 1495932 AGNT, Inc., former EDGAR name until 2026-06-01
    ['EXXON MOBIL', 'XOM', '30231G'], // holding company reorganization: XOM is CIK 2115436 ExxonMobil Holdings Corp since 2026, the old Exxon Mobil Corp is CIK 34088
    ['EYEPOINT PHARMACEUTICALS', 'EYPT', '30233G'], // CIK 1314102 EyePoint, Inc., former EDGAR name until 2025-12-08
    ['EZFILL HOLDINGS', 'NXXT', '652941'], // CIK 1817004 NEXTNRG, INC., former EDGAR name until 2025-02-14
    ['FORTUNE BRANDS HOME AND SECURITY', 'FBIN', '34964C'], // CIK 1519751 Fortune Brands Innovations, Inc., former EDGAR name until 2022-12-14
    ['FRANKLIN RESOURCES', 'BEN', '354613'], // CIK 38777 FRANKLIN TEMPLETON INC, former EDGAR name until 2026-08-14
    ['FREYR BATTERY', 'TE', '35834F'], // CIK 1992243 T1 Energy Inc., former EDGAR name until 2025-02-14
    ['GALLAGHER ARTHUR J AND', 'AJG', '363576'], // CIK 354190 Arthur J. Gallagher & Co., former EDGAR name until 2019-08-14
    ['GRAINGER WW', 'GWW', '384802'], // CIK 277135 W.W. GRAINGER, INC., former EDGAR name until 2019-10-15
    ['GRAY TELEVISION', 'GTN', '389375'], // CIK 43196 GRAY MEDIA, INC, former EDGAR name until 2025-02-24
    ['GREAT AJAX', 'RPT', '38983D'], // CIK 1614806 Rithm Property Trust Inc., former EDGAR name until 2024-11-13
    ['GREENIDGE GENERATION HOLDINGS', 'VIP', '39531G'], // CIK 1844971 Vulcan Infrastructure & Power Inc., former EDGAR name until 2026-07-09
    ['HANNON ARMSTRONG SUSTAINABLE INFRASTRUCTURE CAPITAL', 'HASI', '41068X'], // CIK 1561894 HA Sustainable Infrastructure Capital, Inc., former EDGAR name until 2024-07-02
    ['HARTFORD FINANCIAL SERVICES GROUP', 'HIG', '416515'], // CIK 874766 HARTFORD INSURANCE GROUP, INC., former EDGAR name until 2025-01-30
    ['HELIX ENERGY SOLUTIONS GROUP', 'HOS', '42330P'], // CIK 866829 HORNBECK OFFSHORE SERVICES, INC., former EDGAR name until 2026-08-31
    ['HYSTER YALE MATERIALS HANDLING', 'HY', '449172'], // CIK 1173514 HYSTER-YALE, INC., former EDGAR name until 2024-05-30
    ['IAC', 'PPLI', '44891N'], // CIK 1800227 People Inc, former EDGAR name until 2026-06-02
    ['IDENTIV', 'INVE', '45170X'], // CIK 1036044 INVE Technologies, Inc., former EDGAR name until 2026-08-25
    ['IRHYTHM TECHNOLOGIES', 'IRTC', '450056'], // CIK 1388658 iRhythm Holdings, Inc., former EDGAR name until 2026-01-12
    ['ISSUER DIRECT', 'ACCS', '46520M'], // CIK 843006 ACCESS Newswire Inc., former EDGAR name until 2025-01-16
    ['JANOVER', 'DFDV', '47100L'], // CIK 1805526 DeFi Development Corp., former EDGAR name until 2025-04-15
    ['JOHN BEAN TECHNOLOGIES', 'JBTM', '477839'], // CIK 1433660 JBT MAREL Corp, former EDGAR name until 2024-12-20
    ['LENDINGCLUB', 'HAPN', '52603A'], // CIK 1409970 Happen, Inc., former EDGAR name until 2026-06-18
    ['LIXTE BIOTECHNOLOGY HOLDINGS', 'NMAD', '539319'], // CIK 1335105 NOMAD POWER SOLUTIONS, INC., former EDGAR name until 2026-07-02
    ['MKS INSTRUMENTS', 'MKSI', '55306N'], // CIK 1049502 MKS INC, former EDGAR name until 2025-05-15
    ['MONTANA TECHNOLOGIES', 'AIRJ', '612160'], // CIK 1855474 AirJoule Technologies Corp., former EDGAR name until 2024-10-21
    ['MULTIPLAN', 'CTEV', '62548M'], // CIK 1793229 Claritev Corp, former EDGAR name until 2025-02-07
    ['NEWPARK RESOURCES', 'NPKI', '651718'], // CIK 71829 NPK International Inc., former EDGAR name until 2024-12-03
    ['ONCOLOGY INSTITUTE', 'STLN', '68236X'], // CIK 1799191 Starling Oncology, Inc., former EDGAR name until 2026-08-03
    ['OREILLY AUTOMOTIVE', 'ORLY', '67103H'], // CIK 898173 O REILLY AUTOMOTIVE INC, former EDGAR name until 1998-04-10
    ['ORION OFFICE REIT', 'ONL', '68629Y'], // CIK 1873923 Orion Properties Inc., former EDGAR name until 2025-03-07
    ['PALTALK', 'IPM', '69764K'], // CIK 1355839 INTELLIGENT PROTECTION MANAGEMENT CORP., former EDGAR name until 2025-01-02
    ['PARAMOUNT SKYDANCE', 'SKYD', '69932A'], // CIK 2041610 Skydance Corp, former EDGAR name until 2026-10-06
    ['PIEDMONT OFFICE REALTY TRUST', 'PDM', '720190'], // CIK 1042776 Piedmont Realty Trust, Inc., former EDGAR name until 2025-06-02
    ['PIERIS PHARMACEUTICALS', 'PVLA', '697947'], // CIK 1583648 PALVELLA THERAPEUTICS, INC., former EDGAR name until 2024-12-12
    ['PLUS THERAPEUTICS', 'CNSY', '72941H'], // CIK 1095981 CERENOME, INC., former EDGAR name until 2026-07-01
    ['RUMBLE', 'RUM', '78137L'], // CIK 1830081 RUM Group Inc., former EDGAR name until 2026-06-17
    ['SCHWEITZER MAUDUIT INTERNATIONAL', 'MATV', '808541'], // CIK 1000623 Mativ Holdings, Inc., former EDGAR name until 2022-07-01
    ['SEQLL', 'CIRC', '048592'], // CIK 1605888 CIRCLE8 GROUP INC, former EDGAR name until 2024-06-06
    ['SHOE CARNIVAL', 'SHOE', '824889'], // CIK 895447 SHOE STATION GROUP INC, former EDGAR name until 2026-06-11
    ['TANGER FACTORY OUTLET CENTERS', 'SKT', '875465'], // CIK 899715 TANGER INC., former EDGAR name until 2023-11-15
    ['TECNOGLASS', 'TGLS', '87877F'], // CIK 1534675 Tecnoglass Holdings Inc., former EDGAR name until 2026-07-07
    ['TEMPUR SEALY INTERNATIONAL', 'SGI', '88023U'], // CIK 1206264 SOMNIGROUP INTERNATIONAL INC., former EDGAR name until 2025-02-14
    ['TEVOGEN BIO HOLDINGS', 'TVGN', '88165K'], // CIK 1860871 Tevogen Inc., former EDGAR name until 2026-07-30
    ['TORO COMBINECO', 'TTGT', '87874R'], // CIK 2018064 TechTarget, Inc., former EDGAR name until 2024-11-20
    ['VIAD', 'PRSU', '92552R'], // CIK 884219 Pursuit Attractions & Hospitality, Inc., former EDGAR name until 2024-12-31
    ['WELLGISTICS HEALTH', 'MEDS', '949503'], // CIK 2030763 DataMeds AI, Inc., former EDGAR name until 2026-07-21
    ['ZOOM VIDEO COMMUNICATIONS', 'ZM', '98980L'], // CIK 1585521 Zoom Communications, Inc., former EDGAR name until 2024-11-12
    ['ZYMEWORKS DELAWARE', 'ZYME', '98985Y'], // CIK 1937653 Zymeworks Inc., former EDGAR name until 2022-10-13
  ];
}

/** Nasdaq Trader symbol directories: Nasdaq listings, and NYSE, NYSE American, NYSE Arca, Cboe and IEX listings. */
export function nportUsListingsUrls(): string[] {
  return ['https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt', 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt'];
}

/**
 * The Nasdaq Trader symbol directories (the texts of `nportUsListingsUrls()`, in any order) as U.S.-listed symbol -> security
 * name; test issues and ETFs left out, CQS class dots as SEC dashes (`BRK.B` -> `BRK-B`). An issuer listed under several
 * symbols (Liberty Global LBTYA, LBTYB, LBTYK) also gets the entry `\u0000<name key>` -> its symbols, which `nportUsListed` reads
 * to require the share class. null unless every text is a whole directory (a header with Security Name and the File Creation
 * Time footer), so a failed or cut download changes nothing.
 */
export function parseUsListings(texts: ReadonlyArray<string>): Map<string, string> | null {
  const listings = new Map<string, string>();
  if (!texts.length) return null;
  for (let t = 0; t < texts.length; t++) {
    const lines = String(texts[t] === null || texts[t] === undefined ? '' : texts[t]).split(/\r?\n/).filter((line) => line.trim());
    const header = (lines[0] || '').split('|').map((cell) => cell.trim().toUpperCase());
    const nameAt = header.indexOf('SECURITY NAME'), testAt = header.indexOf('TEST ISSUE'), etfAt = header.indexOf('ETF');
    if (nameAt < 0 || !/^FILE CREATION TIME/i.test(lines[lines.length - 1] || '')) return null;
    for (let i = 1; i < lines.length - 1; i++) {
      const cells = lines[i].split('|');
      const symbol = String(cells[0] || '').trim().toUpperCase().replace(/[./ ]/g, '-');
      if (!symbol || String(cells[testAt] || '').trim() === 'Y' || String(cells[etfAt] || '').trim() === 'Y' || listings.has(symbol)) continue;
      listings.set(symbol, String(cells[nameAt] || '').trim());
    }
  }
  const issuers = new Map<string, string[]>();
  const loose = new Map<string, string[]>();
  listings.forEach((name, symbol) => {
    const key = nportNameKey(nportIssuerName(name));
    if (key) issuers.set(key, (issuers.get(key) || []).concat(symbol));
    const looseKey = nportLooseKey(nportIssuerName(name));
    if (looseKey && nportListedCommon(name)) loose.set(looseKey, (loose.get(looseKey) || []).concat(symbol));
  });
  issuers.forEach((symbols, key) => { if (symbols.length > 1) listings.set(`\u0000${key}`, symbols.join(' ')); });
  loose.forEach((symbols, looseKey) => listings.set(`\u0001${looseKey}`, symbols.join(' ')));
  return listings;
}

/** Is a symbol directory security name a company's own common or ordinary shares (not preferred, depositary, notes, warrants, units, rights)? */
function nportListedCommon(name: string): boolean {
  return !/\bDEPOSITARY\b|\bADSS?\b|\bADRS?\b|\bREGISTRY\b|\bPREFERRED\b|\bPREF\b|\bPFD\b|\bNOTES?\b|\bDEBENTURES?\b|\bWARRANTS?\b|\bUNITS?\b|\bRIGHTS?\b|%|\bDUE\s+\d{4}\b|\bPERPETUAL\b|\bCUMULATIVE\b|\bSUBORDINATED\b|\bTRUST\s+(?:SECURITIES|CERTIFICATES)\b|\bETNS?\b|\bEXCHANGE[- ]TRADED\b/i.test(name);
}

/** The share class a name or title states (`Class C`, `CL C`, `Series A`, `LIBERTY GLOBAL-C`), '' for none. */
function nportShareClass(...texts: unknown[]): string {
  for (let i = 0; i < texts.length; i++) {
    const text = String(texts[i] === null || texts[i] === undefined ? '' : texts[i]);
    const match = /\b(?:CLASS|CL|SERIES|SER)\.?\s+([A-Z])\b/i.exec(text) || /[A-Z]-\s?([A-Z])(?:\s|$)/i.exec(text);
    if (match) return match[1].toUpperCase();
  }
  return '';
}

/** Both symbol directories through the brand's `getText`, null when one fails (`parseUsListings`); load once per run. */
export async function readUsListings(getText: (url: string, label: string) => Promise<string>): Promise<Map<string, string> | null> {
  try {
    return parseUsListings(await Promise.all(nportUsListingsUrls().map((url) => getText(url, `Nasdaq Trader ${url.replace(/^.*\//, '')}`))));
  } catch {
    return null;
  }
}

/** A security or sheet name without its share description: `Accenture plc Class A Ordinary Shares (Ireland)` -> `Accenture plc`. */
function nportIssuerName(value: unknown): string {
  return String(value === null || value === undefined ? '' : value).split(' - ')[0]
    .replace(/\s+(?:\(|(?:CLASS|SERIES)\s+[A-Z]\b|COMMON\b|ORDINARY\b|SUBORDINATE\b|SUB\.?\s+VOT|(?:LIMITED|RESTRICTED)\s+VOTING\b|VOTING\b|SHARES?\b|STOCK\b|AMERICAN\s+DEPOSITARY\b|TRADING\s+UNDER\b)[\s\S]*$/i, '');
}

/**
 * Is `ticker` the company's own U.S. listing? The Nasdaq Trader directories (`parseUsListings`) list it under the same company
 * (same name key, or one key the start of the other: `BUNGE GLOBAL` and the directory's `BUNGE`, a name cut short after two words
 * or more: `CHECK POINT SOFTWARE TECH`), and not as depositary or New York registry shares, which are another security than
 * the foreign line (Shell's SHEL ADR, ASML's New York shares). When the issuer has several listed classes, the name or title
 * must state the listed class (Liberty Latin America Class C is LILAK, not LILA). False without listings. Callers check that
 * the line trades in U.S. dollars: a Toronto or London line of the same company in its own currency never gets the U.S. ticker.
 */
export function nportUsListed(listings: Map<string, string> | null, ticker: string, name: unknown, title: unknown = ''): boolean {
  if (!listings) return false;
  const listed = listings.get(String(ticker).trim().toUpperCase().replace(/[./ ]/g, '-'));
  if (listed === undefined || /\bDEPOSITARY\b|\bADSS?\b|\bADRS?\b|\bREGISTRY\b/i.test(listed)) return false;
  const a = nportNameKey(nportIssuerName(listed)), b = nportNameKey(nportIssuerName(name));
  if (!a || !b) return false;
  const short = a.length < b.length ? a : b, long = a.length < b.length ? b : a;
  if (a !== b && !(short.length >= 4 && long.indexOf(`${short} `) === 0) && !(short.split(' ').length >= 2 && long.indexOf(short) === 0)) return false;
  const listedClass = nportShareClass(listed);
  return !listedClass || !listings.has(`\u0000${a}`) || nportShareClass(name, title) === listedClass;
}

/**
 * Exchange tickers for the positions, in their order ('' for none). A ticker is given only to a common-stock row (assetCat
 * EC; a preferred EP, a CVR, right, warrant or escrow line gets none, a name match would give it the issuer's common ticker):
 * - U.S. ISIN or none, traded in USD (or with no currency): the filer's own `<ticker value>`, else the SEC issuer-name table
 *   (`names`) when the row has a CUSIP or a U.S. ISIN, else a renamed issuer (`nportRenamedIssuers`)
 * - foreign ISIN (Linde IE, NXP NL, IMAX CA): only traded in USD and only when the symbol directories (`listings`,
 *   `parseUsListings`) confirm the filer's or the name-matched ticker for the same company (`nportUsListed`); a local line in
 *   another currency, and every foreign row without listings, gets none
 * A ticker that lands on two different securities (Alphabet A and C, an ordinary share and its ADR) is dropped from the
 * name-matched rows; when the filer itself gave it to two securities it is dropped from all of them. Rows still without a
 * ticker get the second, looser name match (`nportLooseTickers`), which never changes a ticker given here. Bonds, cash, funds
 * and derivatives stay identifier-keyed.
 */
export function nportTickers(positions: ReadonlyArray<NportPosition>, names: Map<string, string> | null = null, listings: Map<string, string> | null = null): string[] {
  const fromFiler: boolean[] = [];
  const secTickers = new Set<string>();
  if (names) names.forEach((ticker, key) => { if (key.charAt(0) !== '\u0001') secTickers.add(ticker); });
  const renames = nportRenamedIssuers();
  const renamed = (position: NportPosition, key: string): string => {
    const issuer = (position.cusip || (/^US[0-9A-Z]{10}$/.test(position.isin) ? position.isin.slice(2, 11) : '')).slice(0, 6);
    const hit = renames.filter((entry) => entry[0] === key && entry[2] === issuer && secTickers.has(entry[1]))[0];
    return hit ? hit[1] : '';
  };
  const tickers = positions.map((position, index) => {
    fromFiler[index] = false;
    const equity = position.assetCat === 'EC' && !position.derivative && !nportIsRight(position);
    const foreign = Boolean(position.isin) && position.isin.slice(0, 2) !== 'US';
    const usd = foreign ? position.currency === 'USD' && Boolean(listings) : !position.currency || position.currency === 'USD';
    if (!equity || !usd) return '';
    const filer = /^[A-Z][A-Z0-9.-]{0,9}$/.test(position.ticker) ? position.ticker : '';
    const key = nportNameKey(position.name);
    const named = names && (/^[0-9A-Z]{9}$/.test(position.cusip) || /^[A-Z]{2}[0-9A-Z]{10}$/.test(position.isin)) ? names.get(key) || names.get(key.replace(/ CL [A-Z]$/, '')) || '' : '';
    if (!foreign) {
      fromFiler[index] = Boolean(filer);
      return filer || named || (names ? renamed(position, key) : '');
    }
    if (filer && nportUsListed(listings, filer, position.name, position.title)) {
      fromFiler[index] = true;
      return filer;
    }
    return named && nportUsListed(listings, named, position.name, position.title) ? named : '';
  });
  const securities = new Map<string, { keys: string[]; filer: string[] }>();
  tickers.forEach((ticker, index) => {
    if (!ticker) return;
    const position = positions[index];
    const key = position.cusip || position.isin || position.other || nportNameKey(position.name);
    const seen = securities.get(ticker) || { keys: [], filer: [] };
    if (seen.keys.indexOf(key) < 0) seen.keys.push(key);
    if (fromFiler[index] && seen.filer.indexOf(key) < 0) seen.filer.push(key);
    securities.set(ticker, seen);
  });
  const exact = tickers.map((ticker, index) => {
    const seen = ticker ? securities.get(ticker) : undefined;
    if (!seen || seen.keys.length < 2) return ticker;
    return seen.filer.length === 1 && fromFiler[index] ? ticker : '';
  });
  return nportLooseTickers(positions, exact, names, listings);
}

/**
 * The second name match (open-items etfs Q35) for the common-stock rows `nportTickers` left without a ticker; the tickers it
 * already gave never change. The row's loose key (`nportLooseKey`) must name one company: in the SEC table (`\u0001` entries of
 * `parseSecCompanyNames`, one CIK) and/or in the symbol directories (`\u0001` entries of `parseUsListings`, common shares only),
 * and when both know the key they must agree on the company. Of that company's tickers only its listed common shares count
 * (with one SEC ticker and no listing, that ticker); several of them (Fox, Lennar, Zillow) need the class the row states in its
 * name or title, matched to the listed security name, else no ticker. A foreign ISIN needs the directory listing of the same
 * key (its own U.S. shares, never depositary ones). A ticker that a row of `exact` holds for another security, or that this pass
 * finds for two securities, is dropped.
 */
function nportLooseTickers(positions: ReadonlyArray<NportPosition>, exact: string[], names: Map<string, string> | null, listings: Map<string, string> | null): string[] {
  if (!names) return exact;
  const companyOf = new Map<string, string>();
  names.forEach((tickers, key) => { if (key.charAt(0) === '\u0001' && tickers) tickers.split(' ').forEach((ticker) => companyOf.set(ticker, key)); });
  const securityOf = (position: NportPosition): string => position.cusip || position.isin || position.other || nportNameKey(position.name);
  const listedClass = (symbol: string): string => nportShareClass(listings ? listings.get(symbol) : '');
  const found = positions.map((position, index) => {
    if (exact[index] || position.assetCat !== 'EC' || position.derivative || nportIsRight(position)) return '';
    const foreign = Boolean(position.isin) && position.isin.slice(0, 2) !== 'US';
    if (foreign ? position.currency !== 'USD' || !listings : position.currency && position.currency !== 'USD') return '';
    if (!/^[0-9A-Z]{9}$/.test(position.cusip) && !/^[A-Z]{2}[0-9A-Z]{10}$/.test(position.isin)) return '';
    const key = nportLooseKey(position.name);
    if (!key) return '';
    const sec = names.get(`\u0001${key}`);
    const listed = listings ? listings.get(`\u0001${key}`) : undefined;
    if (sec === '' || (sec === undefined && listed === undefined) || (foreign && !listed)) return '';
    const listedSymbols = listed ? listed.split(' ') : [];
    // the company: the SEC entry of the key, else the one SEC entry every listed symbol of the key belongs to
    const company = sec !== undefined ? `\u0001${key}` : companyOf.get(listedSymbols[0]) || '';
    if (!company || listedSymbols.some((symbol) => companyOf.get(symbol) !== company)) return '';
    const tickers = String(names.get(company) || '').split(' ').filter(Boolean);
    const common = tickers.filter((ticker) => listings && listings.has(ticker) && nportListedCommon(String(listings.get(ticker))));
    const candidates = common.length ? common : tickers.length === 1 && !foreign ? tickers : [];
    if (foreign && candidates.some((ticker) => listedSymbols.indexOf(ticker) < 0)) return '';
    const wanted = nportShareClass(position.name, position.title);
    if (candidates.length === 1) return !wanted || !listings || !listings.has(candidates[0]) || !listedClass(candidates[0]) || listedClass(candidates[0]) === wanted ? candidates[0] : '';
    const classed = wanted ? candidates.filter((ticker) => listedClass(ticker) === wanted) : [];
    return classed.length === 1 ? classed[0] : '';
  });
  const taken = new Map<string, string[]>();
  exact.forEach((ticker, index) => { if (ticker) taken.set(ticker, (taken.get(ticker) || []).concat(securityOf(positions[index]))); });
  found.forEach((ticker, index) => {
    if (!ticker) return;
    const seen = taken.get(ticker) || [];
    if (seen.indexOf(securityOf(positions[index])) < 0) taken.set(ticker, seen.concat(securityOf(positions[index])));
  });
  return exact.map((ticker, index) => ticker || (found[index] && (taken.get(found[index]) || []).length === 1 ? found[index] : ''));
}

/** The browse-edgar Atom feed of one series' NPORT-P filings. */
export function nportSeriesFeedUrl(seriesId: string, count = 10): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(String(seriesId).toUpperCase())}&type=NPORT-P&dateb=&owner=include&count=${count}&output=atom`;
}

/** The registrant's submissions JSON (report periods of its recent filings). */
export function nportSubmissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${`0000000000${Number(String(cik).replace(/\D/g, '')) || 0}`.slice(-10)}.json`;
}

/** primary_doc.xml of a filing in the registrant's own folder. Throws without a registrant CIK: the accession prefix is the filer agent. */
export function nportDocumentUrl(registrantCik: string, accession: string): string {
  const cik = Number(String(registrantCik).replace(/\D/g, ''));
  if (!cik) throw new Error(`N-PORT ${accession}: no registrant CIK (the accession prefix is the filer agent, never used as the folder)`);
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${String(accession).replace(/-/g, '')}/primary_doc.xml`;
}

/** NPORT-P entries of a browse-edgar Atom feed (amendments and other forms skipped), with the registrant CIK of the filing link. */
export function parseNportFeed(atom: string): NportCandidate[] {
  const out: NportCandidate[] = [];
  const entries = /<entry>([\s\S]*?)<\/entry>/gi;
  let entry: RegExpExecArray | null;
  while ((entry = entries.exec(String(atom === null || atom === undefined ? '' : atom))) !== null) {
    const body = entry[1];
    const form = (nportTag(body, 'filing-type') || nportAttr(body, 'category', 'term')).toUpperCase();
    const accession = nportTag(body, 'accession-number');
    if (form !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const folder = /\/Archives\/edgar\/data\/(\d+)\//i.exec(nportTag(body, 'filing-href'));
    out.push({ accession, filed: nportIso(nportTag(body, 'filing-date')), period: nportIso(nportTag(body, 'period')), cik: folder ? folder[1] : '' });
  }
  return out;
}

/** NPORT-P filings of a registrant's submissions JSON (`filings.recent`), with report periods; the registrant is the JSON's own CIK. */
export function parseNportSubmissions(payload: unknown): NportCandidate[] {
  const record = (payload && typeof payload === 'object' ? payload : {}) as { cik?: unknown; filings?: { recent?: Record<string, unknown> } };
  const recent = record.filings && record.filings.recent ? record.filings.recent : {};
  const column = (name: string): unknown[] => (Array.isArray(recent[name]) ? (recent[name] as unknown[]) : []);
  const forms = column('form'), accessions = column('accessionNumber'), filed = column('filingDate'), periods = column('reportDate');
  const cik = String(record.cik === null || record.cik === undefined ? '' : record.cik).replace(/\D/g, '');
  const out: NportCandidate[] = [];
  for (let i = 0; i < forms.length; i++) {
    const accession = String(accessions[i] === null || accessions[i] === undefined ? '' : accessions[i]);
    if (String(forms[i]).toUpperCase() !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    out.push({ accession, filed: nportIso(filed[i]), period: nportIso(periods[i]), cik });
  }
  return out;
}

/**
 * Candidates newest report period first, then newest filing: a late filing for an older period never wins. A missing
 * period is taken from `known` (the registrant's submissions) by accession; candidates still without one go last.
 */
export function nportNewestFirst(candidates: ReadonlyArray<NportCandidate>, known: ReadonlyArray<NportCandidate> = []): NportCandidate[] {
  const periods = new Map<string, string>();
  for (let i = 0; i < known.length; i++) if (known[i].period) periods.set(known[i].accession, known[i].period);
  return candidates
    .map((candidate) => (candidate.period ? candidate : { ...candidate, period: periods.get(candidate.accession) || '' }))
    .sort((a, b) => (a.period && b.period ? b.period.localeCompare(a.period) : a.period ? -1 : b.period ? 1 : 0) || b.filed.localeCompare(a.filed));
}

/**
 * Does the filing belong to the fund? With a series id: only the same series id. Without one: the normalized series name
 * equals the fund name, or (`loose`, reported to the caller) one contains the other. Returns the problem, or null.
 */
export function nportIdentity(filing: Pick<NportFiling, 'seriesId' | 'seriesName'>, fund: { seriesId?: string | null; name?: string | null }): { problem: string | null; loose: boolean } {
  const wantedSeries = String(fund.seriesId || '').trim().toUpperCase();
  if (wantedSeries) return { problem: filing.seriesId === wantedSeries ? null : `names series ${filing.seriesId || 'none'}, not ${wantedSeries}`, loose: false };
  const filed = nportNameKey(filing.seriesName), wanted = nportNameKey(fund.name);
  if (!filed || !wanted) return { problem: 'no series id and no fund name to match', loose: false };
  if (filed === wanted) return { problem: null, loose: false };
  if (filed.indexOf(wanted) >= 0 || wanted.indexOf(filed) >= 0) return { problem: null, loose: true };
  return { problem: `names series "${filing.seriesName}", not "${String(fund.name)}"`, loose: false };
}

/**
 * May a filing replace the published holdings? Nothing published (no rows): any dated or undated report. Otherwise only a
 * report period strictly newer than the published holdings date; both must be ISO dates (convert the brand's display
 * date first), an unknown date on either side keeps the published sheet.
 */
export function nportIsFresh(repPdDate: unknown, publishedAsOf: unknown, publishedRows: unknown): boolean {
  if (!(Number(publishedRows) > 0)) return true;
  const report = nportIso(repPdDate), published = nportIso(publishedAsOf);
  return Boolean(report && published && String(publishedAsOf).trim().length === 10 && report > published);
}

export type NportRead = { filing: NportFiling; candidate: NportCandidate; url: string; loose: boolean } | { problem: string };

/**
 * The newest N-PORT-P filing of one fund, or why there is none. Candidates: the series' Atom feed (when a series id is known;
 * an empty feed means no filing yet) with periods from the registrant's submissions, else (no series id, or the feed failed)
 * the registrant's NPORT-P filings themselves; newest period first.
 * Documents are read until one passes the identity check (at most `maxDocuments`); that newest own filing is returned only
 * when it is fresh against the published holdings (`published.asOf` ISO, `published.rows`). Errors of the optional
 * submissions request are tolerated; others come back as `problem`. `cache` (one Map per run) keeps the submissions and
 * the parsed documents, so funds of one registrant share requests.
 */
export async function readNportHoldings(
  fund: { ticker: string; cik: string; seriesId?: string | null; name?: string | null },
  published: { asOf?: unknown; rows?: unknown },
  getText: (url: string, label: string) => Promise<string>,
  options: { maxDocuments?: number; cache?: Map<string, unknown> } = {},
): Promise<NportRead> {
  const cache = options.cache || new Map<string, unknown>();
  const once = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load().catch((error: unknown) => { cache.delete(key); throw error; }));
    return (await cache.get(key)) as T;
  };
  const cik = String(fund.cik || '').replace(/\D/g, '');
  if (!Number(cik)) return { problem: `${fund.ticker}: no registrant CIK` };
  let known: NportCandidate[] = [];
  try {
    known = await once(`submissions:${Number(cik)}`, async () => parseNportSubmissions(JSON.parse(await getText(nportSubmissionsUrl(cik), `${fund.ticker} N-PORT periods`))));
  } catch {
    known = [];
  }
  // null: no series feed (no series id, or the feed failed), so the registrant's own NPORT-P filings are scanned instead
  let candidates: NportCandidate[] | null = null;
  try {
    if (fund.seriesId) candidates = parseNportFeed(await getText(nportSeriesFeedUrl(fund.seriesId), `${fund.ticker} N-PORT filings`));
  } catch (error) {
    if (!known.length) return { problem: `${fund.ticker}: N-PORT filings unavailable (${error instanceof Error ? error.message : String(error)})` };
  }
  const sorted = nportNewestFirst(candidates || known, known);
  if (!sorted.length) return { problem: `${fund.ticker}: no NPORT-P filing yet` };
  const limit = Math.max(1, options.maxDocuments || (candidates ? 3 : 12));
  const misses: string[] = [];
  for (let i = 0; i < sorted.length && i < limit; i++) {
    const candidate = sorted[i];
    const url = nportDocumentUrl(Number(candidate.cik) ? candidate.cik : cik, candidate.accession);
    let filing: NportFiling;
    try {
      filing = await once(`document:${url}`, async () => parseNportFiling(await getText(url, `${fund.ticker} N-PORT ${candidate.accession}`)));
    } catch (error) {
      misses.push(`${candidate.accession} unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const identity = nportIdentity(filing, fund);
    if (identity.problem) {
      misses.push(`${candidate.accession} ${identity.problem}`);
      continue;
    }
    if (!filing.positions.length) return { problem: `${fund.ticker}: ${candidate.accession} has no positions` };
    if (!nportIsFresh(filing.repPdDate, published.asOf, published.rows)) return { problem: `${fund.ticker}: N-PORT ${filing.repPdDate || 'undated'} is not newer than the published holdings (${String(published.asOf || 'undated')})` };
    return { filing, candidate, url, loose: identity.loose };
  }
  return { problem: `${fund.ticker}: no N-PORT-P filing of its own${misses.length ? `: ${misses.join('; ')}` : ''}` };
}
// </nport-reader>

// <calendar-dates> shared block of .claude/tools/etfs/etf-std/calendar-dates.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * A calendar date as ISO `YYYY-MM-DD`, or null. Pure text work, never `Date.parse` or local getters, so a run in Tokyo
 * publishes the same day as CI (open-items etfs ETF-H4). Accepts ISO (`2026-10-24`, with a time the date part is kept as
 * written), `2026/10/24`, U.S. `10/24/2026` and `10-24-26` (two-digit years up to 69 are 20xx), month names in either order
 * (`Oct 24, 2026`, `October 24 2026`, `Sept. 30, 2026`, `24 Oct 2026`, `24-Oct-26`), an optional weekday or `as of` in front.
 * A day that does not exist (`02/30/2026`) is null.
 */
export function calendarIso(value: unknown): string | null {
  const text = String(value === null || value === undefined ? '' : value).replace(/[\s ]+/g, ' ').trim()
    .replace(/^as of:? /i, '').replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,? /i, '');
  const year = (raw: string): number => (raw.length === 2 ? (Number(raw) <= 69 ? 2000 : 1900) + Number(raw) : Number(raw));
  const month = (raw: string): number => {
    const word = raw.toLowerCase();
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    for (let i = 0; i < names.length; i++) if (word.length >= 3 && names[i].indexOf(word) === 0) return i + 1;
    return 0;
  };
  let y = 0, m = 0, d = 0, match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text)) || (match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text))) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  } else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = Number(match[1]); d = Number(match[2]);
  } else if ((match = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text))) {
    y = Number(match[3]); m = month(match[1]); d = Number(match[2]);
  } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})\.?,?[ -](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = month(match[2]); d = Number(match[1]);
  } else {
    return null;
  }
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return null;
  return `${y}-${m < 10 ? '0' : ''}${m}-${d < 10 ? '0' : ''}${d}`;
}

/**
 * Is the fund at least `years` old on `asOf`? Calendar anniversary, inclusive: a fund started 2025-10-24 is one year old on
 * 2026-10-24 (a 29 February start on 1 March). Unknown or unreadable dates answer true, so a value is never dropped for want
 * of a date. The shared "younger than one year" rule: since-inception returns are annualized only from one year on.
 */
export function fundAgeAtLeast(inception: unknown, asOf: unknown, years: number): boolean {
  const start = calendarIso(inception), end = calendarIso(asOf);
  if (!start || !end) return true;
  return end >= `${Number(start.slice(0, 4)) + years}${start.slice(4)}`;
}

/**
 * The returns with every horizon the fund is too young for set to null: `horizons` maps a key of `returns` to the years it
 * needs (`{ yr1: 1, cagr3y: 3, siAnn: 1 }`). Keys that are absent or already null stay as they are; the object is copied.
 */
export function withoutYoungReturns<T extends object>(returns: T, inception: unknown, asOf: unknown, horizons: Record<string, number>): T {
  const out: Record<string, unknown> = { ...(returns as Record<string, unknown>) };
  const keys = Object.keys(horizons);
  for (let i = 0; i < keys.length; i++) {
    if (out[keys[i]] !== undefined && out[keys[i]] !== null && !fundAgeAtLeast(inception, asOf, horizons[keys[i]])) out[keys[i]] = null;
  }
  return out as T;
}
// </calendar-dates>

// <windowed-chart> shared block of .claude/tools/etfs/etf-std/windowed-chart.block.ts, applied by apply-block.ts: never edit it in one repo
export type WindowedChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };
export type WindowedChartDividend = { epoch: number; amount: number };

/**
 * A HISTORY_RANGE window (`period1` N years back) never shrinks the published history, and with it the 3y, 5y, 10y and
 * since-inception returns (open-items etfs Q25; was a byte-identical copy in Fidelity, Invesco and JPMorgan). The published
 * rows older than the first fresh day are put in front of the fresh days; their Adj Close is rescaled by the ratio measured on
 * the overlapping days (Yahoo re-adjusts the whole series after each distribution). Published distributions older than the
 * window are kept as well. Returns the chart unchanged when nothing published is older, and null when the window cannot be
 * joined safely (no overlap, Close changed, inconsistent or implausible ratio): the caller then keeps the fund as published.
 * `published` rows carry `Date` (any calendarIso form), `Close`, `Adj Close`, `Volume`; distribution rows are
 * [date, amount, ...] arrays. The chart's days must be sorted by ISO date.
 */
export function mergeWindowedChart<C extends { days: WindowedChartDay[]; dividends: WindowedChartDividend[] }>(chart: C, published: ReadonlyArray<Record<string, unknown>>, publishedDistributions: ReadonlyArray<unknown> = []): C | null {
  if (!chart.days.length || !published.length) return chart;
  const num = (value: unknown): number | null => {
    const text = String(value === null || value === undefined ? '' : value).replace(/[\s,$]/g, '');
    return text && Number.isFinite(Number(text)) ? Number(text) : null;
  };
  const firstFresh = chart.days[0].date;
  const rows: Array<{ date: string; close: number; adjClose: number; volume: number }> = [];
  for (let i = 0; i < published.length; i++) {
    const date = calendarIso(published[i].Date), close = num(published[i].Close), adjClose = num(published[i]['Adj Close']);
    if (date && close !== null && adjClose !== null && adjClose > 0) rows.push({ date, close, adjClose, volume: num(published[i].Volume) || 0 });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const older = rows.filter((row) => row.date < firstFresh);
  if (!older.length) return chart;
  const byDate = new Map<string, { close: number; adjClose: number }>();
  for (let i = 0; i < rows.length; i++) byDate.set(rows[i].date, rows[i]);
  const adjRatios: number[] = [];
  const closeRatios: number[] = [];
  for (let i = 0; i < chart.days.length; i++) {
    const day = chart.days[i];
    const prior = byDate.get(day.date);
    if (!prior) continue;
    adjRatios.push((day.adjCloseRaw === undefined ? day.adjClose : day.adjCloseRaw) / prior.adjClose);
    if (prior.close > 0) closeRatios.push(day.close / prior.close);
  }
  if (!adjRatios.length) return null;
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  if (closeRatios.length && Math.abs(mean(closeRatios) - 1) > 1e-3) return null;
  if (Math.max.apply(null, adjRatios) / Math.min.apply(null, adjRatios) - 1 > 5e-3) return null;
  const measured = mean(adjRatios);
  if (measured < 0.5 || measured > 1.001) return null;
  const factor = Math.abs(measured - 1) < 1e-4 ? 1 : measured;
  const days: WindowedChartDay[] = older.map((row) => {
    const raw = row.adjClose * factor;
    return { date: row.date, close: row.close, adjClose: factor === 1 ? row.adjClose : Math.round(raw * 100) / 100, volume: row.volume, adjCloseRaw: raw };
  });
  const firstFreshEpoch = Date.UTC(Number(firstFresh.slice(0, 4)), Number(firstFresh.slice(5, 7)) - 1, Number(firstFresh.slice(8, 10))) / 1000;
  const kept: WindowedChartDividend[] = [];
  for (let i = 0; i < publishedDistributions.length; i++) {
    const cells = publishedDistributions[i];
    const date = Array.isArray(cells) ? calendarIso(cells[0]) : null;
    const amount = Array.isArray(cells) ? num(cells[1]) : null;
    if (!date || amount === null || amount <= 0) continue;
    const epoch = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 1000;
    if (epoch < firstFreshEpoch) kept.push({ epoch, amount });
  }
  kept.sort((a, b) => a.epoch - b.epoch);
  return { ...chart, days: days.concat(chart.days), dividends: kept.concat(chart.dividends.filter((dividend) => dividend.epoch >= firstFreshEpoch)) };
}
// </windowed-chart>

// <fund-selection> shared block of .claude/tools/etfs/etf-std/fund-selection.block.ts, applied by apply-block.ts: never edit it in one repo
/** An index row as far as these helpers read it: the ticker and whether it has published data (`dataFile`, null for a catalog-only row). */
export type FundSelectionRow = { ticker?: unknown; dataFile?: unknown };

function fundSelectionTicker(row: FundSelectionRow): string {
  return String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
}

/**
 * The tickers a TICKERS entry may name: the live catalog plus every fund with published data (closed funds included). When
 * the live catalog could not be read (`live` null) every previous index row counts, since nothing tells a real catalog-only
 * row from a stale one. A catalog-only row from an earlier mistyped TICKERS run is therefore not "known" (open-items etfs Q27).
 */
export function knownTickers(live: ReadonlyArray<string> | null, previous: ReadonlyArray<FundSelectionRow>): string[] {
  const out: string[] = [];
  const add = (ticker: string): void => { if (ticker && out.indexOf(ticker) < 0) out.push(ticker); };
  if (live) for (let i = 0; i < live.length; i++) add(String(live[i]).trim().toUpperCase());
  for (let i = 0; i < previous.length; i++) if (!live || previous[i].dataFile) add(fundSelectionTicker(previous[i]));
  return out;
}

/** Throws before any fund request when TICKERS names a fund outside `known` (see knownTickers): a clear error, nothing fetched or written. */
export function assertKnownTickers(selected: ReadonlyArray<string> | null, known: ReadonlyArray<string>, where: string): void {
  const unknown = (selected || []).map((ticker) => String(ticker).trim().toUpperCase()).filter((ticker) => ticker && known.indexOf(ticker) < 0);
  if (unknown.length) throw new Error(`TICKERS: ${unknown.join(', ')} not in ${where}; nothing was fetched or written`);
}

/**
 * The index rows without stale catalog-only rows: a row with no published data whose ticker the live catalog no longer lists
 * (an earlier mistyped TICKERS entry, a fund withdrawn before launch). Rows with data always stay; nothing is dropped when the
 * live catalog could not be read (`live` null).
 */
export function withoutStalePlaceholders<T extends FundSelectionRow>(rows: ReadonlyArray<T>, live: ReadonlyArray<string> | null): T[] {
  if (!live) return rows.slice();
  const listed = live.map((ticker) => String(ticker).trim().toUpperCase());
  return rows.filter((row) => Boolean(row.dataFile) || listed.indexOf(fundSelectionTicker(row)) >= 0);
}

/**
 * New funds of a run (open-items etfs Q28): `published` - first published in this run (the previous index had no row for it,
 * or only a catalog-only one), so a fund whose first read failed is announced when it finally succeeds; `pending` - new in the
 * catalog this run but not published yet. Nothing is reported on a first run (empty previous index).
 */
export function newFundsReport(previous: ReadonlyArray<FundSelectionRow>, next: ReadonlyArray<FundSelectionRow>): { published: string[]; pending: string[] } {
  const report = { published: [] as string[], pending: [] as string[] };
  if (!previous.length) return report;
  const before = new Map<string, boolean>();
  for (let i = 0; i < previous.length; i++) before.set(fundSelectionTicker(previous[i]), Boolean(previous[i].dataFile));
  for (let i = 0; i < next.length; i++) {
    const ticker = fundSelectionTicker(next[i]);
    if (!ticker || before.get(ticker)) continue;
    if (next[i].dataFile) report.published.push(ticker);
    else if (!before.has(ticker)) report.pending.push(ticker);
  }
  report.published.sort();
  report.pending.sort();
  return report;
}

/** The log and step-summary lines of a newFundsReport: `NEW FUNDS: A, B` and `NEW FUNDS (not published yet): C`; none when empty. */
export function newFundsLines(report: { published: ReadonlyArray<string>; pending: ReadonlyArray<string> }): string[] {
  const lines: string[] = [];
  if (report.published.length) lines.push(`NEW FUNDS: ${report.published.join(', ')}`);
  if (report.pending.length) lines.push(`NEW FUNDS (not published yet): ${report.pending.join(', ')}`);
  return lines;
}
// </fund-selection>

// <range-52w> shared block of .claude/tools/etfs/etf-std/range-52w.block.ts, applied by apply-block.ts: never edit it in one repo
export type Range52w = {
  week52Low: number | null; week52High: number | null; range52w: number | null; range52wClose: number | null; range52wAsOf: string | null;
  range52wSince: string | null; range52wBasis: string | null;
};

/**
 * The price columns of a history sheet, tried in this order: the market close first, NAV only when no market price is
 * published. A function, not a const: the block sits at the end of update-data.ts, after the top-level `await main()`.
 */
export function range52wColumns(): string[] {
  return ['Close', 'Market Price', 'NAV', 'NAV per Share'];
}

/** The seven `metrics` keys of the 52-week range, all null: a catalog-only row and a fund without history carry this. */
export function range52wEmpty(): Range52w {
  return { week52Low: null, week52High: null, range52w: null, range52wClose: null, range52wAsOf: null, range52wSince: null, range52wBasis: null };
}

/**
 * The 52-week range from the closes of a fund's published history sheet (owner, 2026-10-29: closes, not intraday highs and
 * lows; no extra requests). `headers` are the sheet headers, `rows` objects keyed by header or arrays in header order.
 * - Price column: the first of range52wColumns() with at least two numeric values (`$1,234.50` reads as 1234.5); the date
 *   column is `Date`, else `As Of`, else the first header. Dates go through calendarIso, so every published format works
 * - Window: the last dated close and every close up to 52 weeks (364 days) before it. `week52Low` and `week52High` are the
 *   lowest and highest close of the window, `range52w` the position of the last close between them in percent
 *   (0 = at the low, 100 = at the high, 2 decimals). The last close is part of the window, so it never falls outside;
 *   `range52wClose` and `range52wAsOf` are that close and its date (it can differ from the row's closePrice source)
 * - A fund with less than 52 weeks of history gets the range since its first published close, and `range52wSince` names
 *   that date (owner: "alternative" - the range since launch with a note); a full window has `range52wSince: null`
 * - `range52wBasis` names the column used. Fewer than two closes give range52wEmpty(); a flat window (high = low) keeps
 *   low and high but `range52w: null`, never a made-up 0 or 50
 */
export function range52wMetrics(headers: string[], rows: unknown[]): Range52w {
  const list = Array.isArray(headers) ? headers.map((h) => String(h)) : [];
  const dateHeader = list.indexOf('Date') >= 0 ? 'Date' : list.indexOf('As Of') >= 0 ? 'As Of' : list[0];
  const cell = (row: unknown, header: string): unknown => {
    if (Array.isArray(row)) return row[list.indexOf(header)];
    return row && typeof row === 'object' ? (row as Record<string, unknown>)[header] : undefined;
  };
  const price = (value: unknown): number | null => {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
    const text = String(value === null || value === undefined ? '' : value).replace(/[$,\s]/g, '');
    if (!/^\d+(\.\d+)?$/.test(text)) return null;
    const number = Number(text);
    return number > 0 ? number : null;
  };
  const all = Array.isArray(rows) ? rows : [], columns = range52wColumns();
  for (let c = 0; c < columns.length; c++) {
    const column = columns[c];
    if (list.indexOf(column) < 0 || !dateHeader) continue;
    const points: Array<{ date: string; close: number }> = [];
    for (let i = 0; i < all.length; i++) {
      const date = calendarIso(cell(all[i], dateHeader)), close = price(cell(all[i], column));
      if (date && close !== null) points.push({ date, close });
    }
    if (points.length < 2) continue;
    points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const last = points[points.length - 1];
    const end = Date.UTC(Number(last.date.slice(0, 4)), Number(last.date.slice(5, 7)) - 1, Number(last.date.slice(8, 10)));
    const start = new Date(end - 364 * 86400000).toISOString().slice(0, 10);
    const window = points.filter((p) => p.date >= start);
    if (window.length < 2) continue;
    let low = window[0].close, high = window[0].close;
    for (let i = 1; i < window.length; i++) { low = Math.min(low, window[i].close); high = Math.max(high, window[i].close); }
    const round = (value: number, digits: number): number => Number(value.toFixed(digits));
    return {
      week52Low: round(low, 4), week52High: round(high, 4),
      range52w: high > low ? round(((last.close - low) / (high - low)) * 100, 2) : null, range52wClose: round(last.close, 4), range52wAsOf: last.date,
      range52wSince: points[0].date > start ? points[0].date : null,
      range52wBasis: column,
    };
  }
  return range52wEmpty();
}
/**
 * The index rows with the five 52-week keys in every `metrics`, computed from each fund's published history pages
 * (`funds/<T>/history/*.json` under `feedRoot`, the folder of index.json). Call it on the final rows right before
 * index.json is written: updated, unchanged and kept funds all get the range of the history they publish, a row without
 * `dataFile` or without history pages gets range52wEmpty(). A row without a `metrics` object is left as it is. The seven
 * keys go in front of `returnsBasis` and `performanceAsOf`, so those two stay the last keys of `metrics`.
 */
export async function withRange52w<T>(feedRoot: URL | string, funds: T[]): Promise<T[]> {
  const fs = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const root = feedRoot instanceof URL ? new URL(feedRoot.href.replace(/\/?$/, '/')) : new URL(pathToFileURL(String(feedRoot).replace(/\/?$/, '/')).href); // global URL, also with older @types/node (Amplify)
  const out: T[] = [];
  for (const fund of Array.isArray(funds) ? funds : []) {
    const row = fund as unknown as Record<string, unknown>;
    if (!row || typeof row !== 'object' || !row.metrics || typeof row.metrics !== 'object') { out.push(fund); continue; }
    let range = range52wEmpty();
    const dataFile = typeof row.dataFile === 'string' ? row.dataFile : '';
    if (dataFile) {
      const dir = new URL(`${dataFile.replace(/^\.\//, '').replace(/[^/]*$/, '')}history/`, root);
      const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((name) => /\.json$/.test(name)).sort();
      let headers: string[] = [];
      const rows: unknown[] = [];
      for (const name of names) {
        const page = await fs.readFile(new URL(name, dir), 'utf8').then((text) => JSON.parse(text)).catch(() => null);
        if (!page || !Array.isArray(page.rows)) continue;
        if (!headers.length && Array.isArray(page.headers)) headers = page.headers;
        for (const item of page.rows) rows.push(item);
      }
      range = range52wMetrics(headers, rows);
    }
    // the range keys go in front of returnsBasis and performanceAsOf, which stay the last two keys (metrics contract)
    const metrics: Record<string, unknown> = {}, old = row.metrics as Record<string, unknown>, tail = ['returnsBasis', 'performanceAsOf'];
    for (const key of Object.keys(old)) if (tail.indexOf(key) < 0 && !(key in range)) metrics[key] = old[key];
    Object.assign(metrics, range);
    for (const key of tail) if (key in old) metrics[key] = old[key];
    out.push({ ...row, metrics } as unknown as T);
  }
  return out;
}
// </range-52w>
