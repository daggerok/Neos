/// <reference types="bun" />
/**
 * NEOS ETF updater tests: five groups (controls, parsing, metrics, pipeline, network).
 * Samples are small transcriptions of what neosfunds.com serves, including its quirks
 * (missing `</td>`, a row without `<tr>`, footnote markers). No network, no fixtures:
 * every file lives in a per-test temp dir removed in `finally`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CONTROL_NAMES,
  FETCH_TIMEOUT_MS,
  HISTORY_HEADERS,
  HOLDINGS_HEADERS,
  NEOS_CATEGORIES,
  NEOS_DISTRIBUTION_HEADERS,
  RETURNS_BASIS,
  annualizedFromCumulative,
  cleanText,
  compareDisplayDates,
  cumulativeFromAnnualized,
  decodeHtmlEntities,
  edgarPrimaryDocLinks,
  elementTextById,
  fallbackIsStale,
  fetchRetried,
  filterScope,
  formatAumDisplay,
  formatDistributionFrequency,
  formatMoneyText,
  formatNeosDate,
  formatPercentText,
  inferDistributionFrequency,
  installSystemCa,
  isCertError,
  isMissingCell,
  main,
  neosAssetCategory,
  neosEdgarFilingsUrl,
  neosFundPageUrl,
  neosHoldingsCsvUrl,
  normalizeNumberText,
  nportToHoldings,
  numberOrNull,
  pageFileName,
  parseAumRange,
  parseCsv,
  parseHtmlTables,
  parseNeosCategoryCards,
  parseNeosDistributionHistory,
  parseNeosDistributionInfo,
  parseNeosDocuments,
  parseNeosFundDetails,
  parseNeosHoldingsCsv,
  parseNeosLineup,
  parseNeosNavIndex,
  parseNeosPerformanceSection,
  parseNportXml,
  parseRange,
  parseYahooChart,
  parseYahooExchangeName,
  passesReturnFilters,
  paymentsPerYear,
  performanceAsOf,
  placeholderEntry,
  readConfig,
  refreshHistoryOnly,
  reserveSlot,
  resolveControls,
  runtimeControls,
  sanitizeTicker,
  selectBatch,
  seriesNameMatches,
  setApiRootForTests,
  splitPages,
  splitRowCells,
  tableById,
  toIsoDate,
  updateFund,
  writeIfChanged,
  writeJsonIfContentChanged,
  yahooChartProvenanceUrl,
  yahooChartUrl,
} from "./update-data";

const REPO_ROOT = path.join(import.meta.dir, "..");
const config = () => JSON.parse(readFileSync(path.join(REPO_ROOT, "scripts", "update-data.config.json"), "utf8"));
const SEC_UA = "daggerok ETF feed daggerok@gmail.com";

// ---------------------------------------------------------------------------
// Isolation: clean env, pinned TZ, restored globals, temp dirs removed in finally
// ---------------------------------------------------------------------------

const ENV_KEYS = [...CONTROL_NAMES, "HISTORICAL_PAGE_SIZE", "NEOS_CONCURRENCY", "GITHUB_STEP_SUMMARY", "TZ"];
const originalEnv: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;
const originalLog = console.log;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.TZ = "UTC";
  console.log = () => {};
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  process.exitCode = undefined;
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

async function inTempRoot<T>(fn: (root: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), "neos-test-"));
  setApiRootForTests(root);
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Every file under `root`, keyed by relative path, walked in sorted order. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}

function mockFetch(routes: (url: string) => Response | null | Promise<Response | null>) {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return (await routes(url)) ?? new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return urls;
}

const quiet = () => ({ ...readConfig({ REQUEST_SLEEP: "0", MAX_RETRIES: "1" }), retryDelayMs: 0 });
const stats = () => ({ updated: 0, unchanged: 0, skipped: 0, failed: 0 });
/** Fails instead of hanging when a promise never settles (a stalled request with no timeout would block the whole run). */
async function settles<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("never settled")), ms); });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}
const readJson = (...parts: string[]) => JSON.parse(readFileSync(path.join(...parts), "utf8"));

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

const tds = (...cells: string[]) => cells.map((cell) => `<td>${cell}</td>`).join("");
const rows = (...cells: string[][]) => cells.map((row) => `<tr>${tds(...row)}</tr>`).join("");

// Lineup: a plain row, XSPI with missing `</td>`, IWMI with a footnote marker on its fee.
const LINEUP_HTML = `<div id="explore-etfs"><table class="table" id="etf-table">
<thead><tr><th>Ticker</th><th>Fund Name</th><th>Distribution Frequency</th><th>Distribution Rate</th><th>30-Day SEC Yield</th><th>Management Fee</th><th>Net Assets</th><th>Inception Date</th></tr></thead>
<tbody>
<tr><td><span class="ticker ticker-equity-high-income">SPYI</span></td><td><a href="https://neosfunds.com/spyi/">S&amp;P 500<sup>&reg;</sup> High Income ETF</a></td><td>Monthly</td><td>12.15% </td><td>0.46% </td><td>0.68%</td><td>$12,151,808,030</td><td>08/29/2022</td></tr>
<tr><td><span class="ticker ticker-enhanced-fixed-income">XSPI</span></td><td><a href="https://neosfunds.com/xspi/">Boosted S&amp;P 500<sup>&reg;</sup> High Income ETF</a></td><td>Monthly</td><td>16.78% <td>0.18% <td>0.98%</td><td>$113,242,709</td><td>02/02/2026</td></tr>
<tr><td><span class="ticker ticker-equity-high-income">IWMI</span></td><td><a href="https://neosfunds.com/iwmi/">Russell 2000<sup>&reg;</sup> High Income ETF</a></td><td>Monthly</td><td>14.51% </td><td>0.52% </td><td>0.68%*</td><td>$1,279,666,480</td><td>06/24/2024</td></tr>
</tbody></table></div>`;

// Fund Details: the first row has no `</td>`; NAV and Market Price repeat the Daily Change labels.
const FUND_DETAILS_HTML = `<h2>Fund Details</h2>
<table class="table fund-details-font"><thead><tr><th>Fund Details</th><th>As of: 09/18/2026</th></tr></thead><tbody>
<tr><td>Fund Inception</td><td style="text-align: right;">8/29/2022
</tr>
${rows(
  ["Fund Ticker", "SPYI"],
  ["CUSIP", "\n 78433H303   "],
  ["ISIN", "US78433H3030"],
  ["Management Fee", "0.68%"],
  ["Total Annual Fund Operating Expenses", "0.68%"],
  ["Net Assets", "$12,151,808,030"],
  ["Shares Outstanding", "228,840,000"],
  ["Primary Exchange", "CBOE"],
  ["Underlying Exposure", "S&amp;P 500 Index"],
  ["Distribution Frequency", "Monthly"],
)}</tbody></table>
<table class="table fund-details-font"><thead><tr><th>Closing NAV Price</th><th></th></tr></thead><tbody>${rows(["Net Asset Value", " $53.640\n"], ["Daily Change ($)", "$0.10"], ["Daily Change (%)", "0.19%"])}</tbody></table>
<table class="table fund-details-font"><thead><tr><th>Closing Market Price</th><th></th></tr></thead><tbody>${rows(["Market Price", "$53.65"], ["Daily Change ($)", "$0.09"], ["Daily Change (%)", "0.17%"])}</tbody></table>`;

// Hedged funds: the Primary Exchange row lost its `<tr>`; the quote table carries the official premium/discount.
const ORPHAN_ROW_HTML = `<h2>Fund Details</h2>
<table class="table fund-details-font"><thead><tr><th>Fund Details</th><th>As of: 09/18/2026</th></tr></thead><tbody>
${rows(["Shares Outstanding", " 6,924,981   "])}
<td>Primary Exchange</td> <td>NASDAQ</td>
${rows(["Distribution Frequency", "Monthly"])}</tbody></table>
<table class="table fund-details-font"><thead><tr><th>Premium / Discount</th><th></th></tr></thead><tbody>${rows(["Premium Discount (%)", "-0.15%"], ["30-Day Median Bid-Ask Spread (%)", "0.29%"])}</tbody></table>`;

const DISTRIBUTION_INFO_HTML = `<table class="table fund-details-font"><thead><tr><th>Distribution Information <br>(as of 08/31/2026)</th><th></th></tr></thead><tbody>${rows(
  ["Distribution Frequency", "Monthly "],
  ["Distribution Rate <img src=\"/i.svg\">", "12.15%"],
  ["12-Month Trailing Distribution Rate <img src=\"/i.svg\">", "11.82%"],
  ["Distribution Amount / Share ($)", "$0.5423"],
  ["Distribution Amount / Share (%)", "1.01%"],
  ["30-Day SEC Yield", "0.46%"],
)}</tbody></table>`;

// Year blocks in ascending order; the last month of 2026 is declared but unpaid.
const yearBlock = (year: number, body: string[][]) =>
  `<div class="dc-year-table" id="dc-year-${year}"><table class="dc-table"><thead><tr><th>Declaration Date</th><th>Ex-Div Date</th><th>Record Date</th><th>Payable Date</th><th>Amount ($)</th></tr></thead><tbody>${rows(...body)}</tbody></table></div>`;
const DISTRIBUTION_HISTORY_HTML =
  yearBlock(2022, [["09/20/2022", "09/21/2022", "09/22/2022", "09/23/2022", "$0.4853"], ["12/22/2022", "12/23/2022", "12/27/2022", "12/28/2022", "$0.4615"]]) +
  yearBlock(2026, [["01/20/2026", "01/21/2026", "01/21/2026", "01/23/2026", "$0.5309"], ["08/18/2026", "08/19/2026", "08/20/2026", "08/25/2026", "$0.5423"], ["12/15/2026", "12/16/2026", "12/16/2026", "12/18/2026", ""]]);

// Performance: a young fund, so the 5 Yr and 10 Yr columns print `--%`.
const th = (...labels: string[]) => `<tr><th></th>${labels.map((label) => `<th>${label}</th>`).join("")}</tr>`;
const cells = (...values: string[]) => values.map((value) => (value === "--" ? `<td><span class="first-two">--</span>%</td>` : `<td>${value}</td>`)).join("");
const MONTHLY_PERFORMANCE_HTML = `<div id="monthly-performance"><p>Data as of: 08/31/2026</p><table>
${th("1 Mo", "3 Mo", "6 Mo", "YTD", "Inception<br>(Cumulative)", "1 Yr", "3 Yr", "5 Yr", "10 Yr", "Inception<br>(Annualized)")}
${th("Cumulative", "Cumulative", "Cumulative", "Cumulative", "Cumulative", "Annualized", "Annualized", "Annualized", "Annualized", "Annualized")}
<tr><td>NAV Performance</td>${cells("2.47%", "2.55%", "9.33%", "10.72%", "75.14%", "17.65%", "16.04%", "--", "--", "15.02%")}</tr>
<tr><td>Market Performance</td>${cells("2.52%", "2.60%", "9.41%", "10.68%", "75.12%", "17.63%", "16.02%", "--", "--", "15.01%")}</tr>
<tr><td>Cboe S&amp;P 500 BuyWrite Monthly Index</td>${cells("1.60%", "4.76%", "7.79%", "10.01%", "57.92%", "19.31%", "13.43%", "--", "--", "12.08%")}</tr>
</table></div>`;

const NAV_INDEX_HTML = `<script>const dates = ["2022-08-29","2022-08-30","2022-09-01"];
const navValues = ["10000","9893","9819"];
const indexValues2 = ["10000","10100","10150"];</script>`;

const a = (file: string) => `<a href="https://neosfunds.com/wp-content/uploads/${file}">PDF</a>`;
const DOCUMENTS_HTML = `<table><thead><tr><th>Documents</th><th></th></tr></thead><tbody>${rows(
  ["Prospectus", a("SPYI-Prospectus.pdf")],
  ["Summary Prospectus", a("SPYI-Summary-Prospectus.pdf")],
  ["Statement of Additional Information", a("neos_sai-042926.pdf")],
  ["Annual Report", a("SPYI-Annual-Report.pdf")],
  ["Semi-Annual Report", a("SPYI-Semi-Annual-1.pdf")],
  ["Fiscal Year Q1 Portfolio Holdings", a("SPYI-Part-F-3.31.26.pdf")],
  ["Fiscal Year Q3 Portfolio Holdings", a("SPYI-Fiscal-Year-Q3-Portfolio-Holdings.pdf")],
  ["2025 Supplemental Tax Information", a("NEOS-Tax-Insert-2025.pdf")],
)}</tbody></table>
<div id="tab-form-8937"><p>Form 8937</p>${a("NEOS-Form-8937-12.31.25.pdf")}</div><div id="tab-19a1-notices">${a("SPYI-Prospectus.pdf")}</div>`;

// Official daily CSV: an equity row, a written SPXW call (OCC symbol as Cusip), the cash line.
const HOLDINGS_CSV = [
  "Date,Account,StockTicker,Cusip,SecurityName,Shares,Price,MarketValue,Weightings,NetAssets,SharesOutstanding,CreationUnits,MoneyMarketFlag",
  '09/21/2026,NEOS,AAPL,037833100,APPLE INC,"1,331,939","255.46","$340,237,157.22","2.79%","$12,192,173,280.00","229,600,000","22,960","N"',
  '09/21/2026,NEOS,"SPXW  261001P07075000",SPXW  261001P07075000,"CBOE S&P 500 INDEX PUT 10/01/2026 70.750","-1,200","2.50","$-3,000.00","-0.00%","$12,192,173,280.00","229,600,000","22,960","N"',
  '09/21/2026,NEOS,Cash&Other,Cash&Other,Cash&Other,"162,387,743","1.00","$162,387,742.50","1.33%","$12,192,173,280.00","229,600,000","22,960","Y"',
].join("\n");

const nport = (series: string, repPdDate: string, positions = `<invstOrSec><name>X CORP</name><cusip>123456789</cusip><balance>10</balance><valUSD>500</valUSD><pctVal>1.5</pctVal><assetCat>EC</assetCat></invstOrSec>`) =>
  `<repPdDate>${repPdDate}</repPdDate><seriesName>${series}</seriesName>${positions}`;
const NPORT_XML = nport(
  "NEOS S&amp;P 500 High Income ETF",
  "2026-06-30",
  `<invstOrSec><name>APPLE INC</name><identifiers><cusip value="037833100"/></identifiers><balance>1331939.00000000</balance><valUSD>340237157.22</valUSD><pctVal>2.79</pctVal><assetCat>EC</assetCat><ticker value="AAPL"/></invstOrSec>` +
    `<invstOrSec><name>SPXW PUT</name><balance>-1200.0</balance><valUSD>-3000.0</valUSD><assetCat>OPT</assetCat></invstOrSec>`,
);

// 2022-08-31 has no close at all (dropped), 2022-09-01 only an adjusted close (kept with Close null).
const YAHOO_JSON = {
  chart: {
    result: [
      {
        meta: { exchangeName: "PCX" },
        timestamp: [1_661_817_600, 1_661_904_000, 1_662_000_000, 1_662_086_400],
        indicators: {
          quote: [{ close: [100, null, null, 103], volume: [10, 20, 30, 40] }],
          adjclose: [{ adjclose: [99.5, null, 101.5, 102.5] }],
        },
        events: { dividends: { "1": { amount: 0.5309, date: 1_661_817_600 }, "2": { amount: 0.5219, date: 1_662_000_000 } } },
      },
    ],
  },
};
const CHART = JSON.stringify({ chart: { result: [{ timestamp: [1_790_000_000, 1_790_086_400], indicators: { quote: [{ close: [54.1, 54.3], volume: [5, 6] }], adjclose: [{ adjclose: [54.1, 54.3] }] }, meta: { exchangeName: "PCX" } }] } });

const FUND = {
  ticker: "SPYI", name: "NEOS S&P 500 High Income ETF", category: "Equity", categoryClass: "", frequency: "Monthly",
  distributionRate: null, distributionRateText: "", secYield: null, secYieldText: "", managementFee: 0.68,
  managementFeeText: "0.68%", netAssets: null, netAssetsText: "", inceptionDate: "", fundPage: "https://neosfunds.com/spyi/",
};

/** neosfunds.com + CSV + Yahoo routes. `pages` maps a ticker to its fund page html. */
const site = (pages: Record<string, string> = {}, yahoo: string | null = CHART) => (url: string): Response | null => {
  if (url === "https://neosfunds.com/") return new Response(LINEUP_HTML);
  const page = /neosfunds\.com\/([a-z]+)\/$/.exec(url);
  if (page) return new Response(pages[page[1].toUpperCase()] ?? "<html></html>");
  if (url.includes("download_holdings_csv")) return new Response(HOLDINGS_CSV);
  if (url.includes("finance.yahoo.com") && yahoo) return new Response(yahoo);
  return null;
};
const RICH_PAGES = { SPYI: FUND_DETAILS_HTML + MONTHLY_PERFORMANCE_HTML };
const RUN_ENV = { REQUEST_SLEEP: "0", MAX_RETRIES: "1", CONCURRENCY: "3", USE_SYSTEM_CA: "false" };

/** A feed the fund already published: 3 history rows, 1 holdings row, holdings as of `holdingsAsOf`. */
function seedFeed(root: string, holdingsAsOf = "Sep 21 2026") {
  const dir = path.join(root, "funds", "SPYI");
  mkdirSync(path.join(dir, "history"), { recursive: true });
  mkdirSync(path.join(dir, "holdings"), { recursive: true });
  const history = [["2026-09-18", "53.10"], ["2026-09-17", "53.00"], ["2026-09-16", "52.90"]].map(([Date, Close]) => ({ Date, Close, "Adj Close": Close, Volume: "1" }));
  writeFileSync(path.join(dir, "history", "001.json"), JSON.stringify({ ticker: "SPYI", page: 1, totalRows: 3, headers: [...HISTORY_HEADERS], rows: history }));
  writeFileSync(path.join(dir, "holdings", "001.json"), JSON.stringify({ ticker: "SPYI", page: 1, rows: [{ Name: "OLD" }] }));
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
    ticker: "SPYI",
    holdings: { pages: ["./holdings/001.json"], totalRows: 1, asOfDate: holdingsAsOf },
    history: { pages: ["./history/001.json"], pageSize: 1000, totalRows: 3, asOf: "2026-09-18", asOfDate: "Sep 18 2026", source: "yahoo" },
  }));
  return dir;
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

describe("controls", () => {
  test("precedence: file < advanced < nonblank input < env < alias; blank input inherits; scheduled run equals defaults", () => {
    const merged = resolveControls({ CONCURRENCY: 2, TICKERS: "SPYI" }, { CONCURRENCY: 3, TICKERS: "QQQI" }, { CONCURRENCY: "4", TICKERS: "" }, { CONCURRENCY: "5" });
    expect(merged.CONCURRENCY).toBe("5");
    expect(merged.TICKERS).toBe("QQQI");
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: "4" }).CONCURRENCY).toBe("4");
    expect(resolveControls({ MAX_RETRIES: 3 }, {}, { MAX_RETRIES: "" }).MAX_RETRIES).toBe("3");
    // An explicitly set env var wins even when empty.
    expect(resolveControls({ TICKERS: "SPYI" }, {}, {}, { TICKERS: "" }).TICKERS).toBe("");
    expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: "false" }).SKIP_YAHOO).toBe("false");
    expect(resolveControls({ HISTORY_PAGE_SIZE: 1000 }, {}, {}, { HISTORICAL_PAGE_SIZE: "500" }).HISTORY_PAGE_SIZE).toBe("500");
    const defaults = config();
    expect(resolveControls(defaults, {}, {}, {})).toEqual(defaults);
    expect(Object.values(defaults).every((value) => typeof value === "string")).toBe(true);
  });

  test("validation is strict: bad values, unknown keys and CR/LF/NUL are errors, never a silent fallback", () => {
    const bad: unknown[] = [
      { UNKNOWN: 1 }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: "-1" },
      { HISTORY_RANGE: "forever" }, { VERBOSE: "maybe" }, { SKIP_NEOS: "perhaps" }, { USE_SYSTEM_CA: "maybe" },
      { AUM: "1:2:3" }, { TER: "5:1" }, { TICKERS: ["SPYI"] }, { TICKERS: null }, { SEC_UA: "x\nEVIL=yes" }, { SEC_UA: "x\rfoo" }, null, [],
    ];
    for (const value of bad) expect(() => resolveControls(value)).toThrow();
    expect(() => resolveControls({}, {}, { TICKERS: "a\nb" })).toThrow();
    expect(() => resolveControls({}, {}, {}, { SEC_UA: "x\0bad" })).toThrow();
    expect(() => resolveControls({}, [])).toThrow();
    expect(() => resolveControls({}, { CONCURRENCY: { a: 1 } })).toThrow();
    expect(() => resolveControls({}, {}, {}, { USE_SYSTEM_CA: "yes" })).toThrow("USE_SYSTEM_CA");
    for (const value of ["auto", "true", "false", "AUTO", "True", "FALSE"]) expect(resolveControls({}, {}, {}, { USE_SYSTEM_CA: value }).USE_SYSTEM_CA).toBe(value);
  });

  test("readConfig: documented defaults, filters, page sizes, TICKERS normalization and the HISTORICAL_PAGE_SIZE alias", () => {
    const defaults = readConfig(resolveControls(config()));
    expect(defaults).toMatchObject({
      maxFetches: 0, requestSleep: 2, concurrency: 2, maxRetries: 3, tickers: [], category: "", holdingsPageSize: 250, historyPageSize: 1000,
      historyRange: "max", storeRawDownloads: false, edgarFallback: true, skipYahoo: false, skipNeos: false, secUa: SEC_UA,
      performanceRanges: {}, totalReturnRanges: {},
    });
    expect(defaults.aumRange).toBeUndefined();
    expect(defaults.terRange).toBeUndefined();
    expect(config().SEC_UA).toBe(SEC_UA);

    const set = readConfig({
      TICKERS: "spyi, qqqi  cshi", AUM: "1B:", TER: ":0.98", DIVIDEND_YIELD: "10:", SEC_YIELD: ":5", PERFORMANCE_3Y: "10:", TOTAL_RETURN_1Y: "0:",
      HISTORICAL_PAGE_SIZE: "500", HOLDINGS_PAGE_SIZE: "100", STORE_RAW_DOWNLOADS: "yes", SKIP_YAHOO: "1", HISTORY_RANGE: "10y", CATEGORY: "Fixed Income",
    });
    expect(set.tickers).toEqual(["SPYI", "QQQI", "CSHI"]);
    expect(set.aumRange).toEqual({ min: 1_000_000_000, max: Infinity, source: "1B:" });
    expect(set.terRange).toEqual({ min: -Infinity, max: 0.98 });
    expect(set.dividendYieldRange).toEqual({ min: 10, max: Infinity });
    expect(set.secYieldRange).toEqual({ min: -Infinity, max: 5 });
    expect(set.performanceRanges["3Y"]).toEqual({ min: 10, max: Infinity });
    expect(set.totalReturnRanges["1Y"]).toEqual({ min: 0, max: Infinity });
    expect(set).toMatchObject({ holdingsPageSize: 100, historyPageSize: 500, storeRawDownloads: true, skipYahoo: true, historyRange: "10y", category: "Fixed Income" });
  });

  test("ranges need the explicit min:max syntax; AUM also takes presets and K/M/B/T amounts", () => {
    expect(parseRange("", "TER")).toBeUndefined();
    expect(parseRange(":", "TER")).toBeUndefined();
    expect(parseRange("0:0.70", "TER")).toEqual({ min: 0, max: 0.7 });
    expect(parseRange("0.98:", "TER")).toEqual({ min: 0.98, max: Number.POSITIVE_INFINITY });
    expect(() => parseRange("1:2:3", "TER")).toThrow(/exactly one colon/);
    expect(() => parseRange("5:1", "TER")).toThrow(/greater than max/);
    expect(parseAumRange("micro")).toEqual({ min: 10_000_000, max: 300_000_000, source: "micro" });
    expect(parseAumRange("large")).toEqual({ min: 10_000_000_000, max: Infinity, source: "large" });
    expect(parseAumRange(":$300M")).toEqual({ min: -Infinity, max: 300_000_000, source: ":$300M" });
    expect(parseAumRange(":")).toBeUndefined();
    expect(() => parseAumRange("nonsense:")).toThrow(/not an amount/);
  });

  test("config keys, CONTROL_NAMES, runtimeControls and --help stay in sync", async () => {
    expect(Object.keys(config()).sort()).toEqual([...CONTROL_NAMES].sort());
    expect(new Set(CONTROL_NAMES).size).toBe(CONTROL_NAMES.length);
    expect(await runtimeControls({})).toEqual(config());
    expect((await runtimeControls({ TICKERS: "SPYI" })).TICKERS).toBe("SPYI");
    const help = Bun.spawnSync([process.execPath, "scripts/update-data.ts", "--help"], { cwd: REPO_ROOT });
    expect(help.exitCode).toBe(0);
    const usage = help.stdout.toString();
    for (const name of CONTROL_NAMES) {
      const tenor = /^(PERFORMANCE|TOTAL_RETURN)_/.exec(name);
      expect(usage).toContain(tenor ? `${tenor[1]}_YTD|1Y|3Y|5Y|10Y` : name);
    }
  });
});

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

describe("parsing", () => {
  test("text and number helpers: missing becomes null, never NaN or 0", () => {
    expect(sanitizeTicker(" spyi ")).toBe("SPYI");
    expect(sanitizeTicker("q-q-q-i")).toBe("QQQI");
    expect(sanitizeTicker(undefined)).toBe("");
    expect(cleanText("S&P 500®  High\nIncome ETF™")).toBe("S&P 500 High Income ETF");
    expect(cleanText(null)).toBe("");
    expect(decodeHtmlEntities("S&amp;P 500")).toBe("S&P 500");
    expect(decodeHtmlEntities("Nasdaq-100&reg;")).toBe("Nasdaq-100");
    const normalized: Array<[string, string]> = [["$12,151,808,030", "12151808030"], ["12.15%", "12.15"], ["0.68%*", "0.68"], ["($0.10)", "-0.10"], ["2.97E8", "297000000"]];
    for (const [raw, expected] of normalized) expect(normalizeNumberText(raw)).toBe(expected);
    for (const raw of ["--", "—", "N/A", ""]) expect(numberOrNull(raw)).toBeNull();
    expect(numberOrNull(Number.NaN)).toBeNull();
    expect(numberOrNull("0")).toBe(0);
    expect(numberOrNull("$53.640")).toBe(53.64);
    expect(numberOrNull("-0.05%")).toBe(-0.05);
    expect([isMissingCell("--"), isMissingCell(""), isMissingCell("0.00%"), isMissingCell(0)]).toEqual([true, true, false, false]);
  });

  test("dates and formatters", () => {
    for (const raw of ["08/29/2022", "8/29/2022", "2022-08-29", "August 29, 2022", "Aug 29 2022"]) expect(toIsoDate(raw)).toBe("2022-08-29");
    expect(toIsoDate("")).toBe("");
    expect(formatNeosDate("08/29/2022")).toBe("Aug 29 2022");
    expect(formatNeosDate("2026-02-02")).toBe("Feb 02 2026");
    expect(compareDisplayDates("Aug 29 2022", "Sep 18 2026")).toBeLessThan(0);
    expect(compareDisplayDates("Sep 18 2026", "Aug 29 2022")).toBeGreaterThan(0);
    expect(compareDisplayDates("Feb 02 2026", "Feb 02 2026")).toBe(0);
    expect(formatAumDisplay(12_151_808_030)).toBe("$12.15B");
    expect(formatAumDisplay(113_242_709)).toBe("$113.24M");
    expect(formatPercentText(-0.05)).toBe("-0.05%");
    expect(formatPercentText(null)).toBe("—");
    expect(formatMoneyText(53.64)).toBe("$53.64");
    expect(formatMoneyText(null)).toBe("—");
  });

  test("source URLs: lowercase fund page, the one admin-ajax holdings action, trust-wide EDGAR, deterministic Yahoo provenance", () => {
    expect(neosFundPageUrl(" SPYI ")).toBe("https://neosfunds.com/spyi/");
    expect(neosHoldingsCsvUrl("SPYI")).toBe("https://neosfunds.com/wp-admin/admin-ajax.php?action=download_holdings_csv&ticker=SPYI");
    expect(neosEdgarFilingsUrl()).toContain("CIK=0001848758");
    expect(neosEdgarFilingsUrl()).toContain("type=NPORT-P");
    expect(yahooChartProvenanceUrl("spyi")).toBe(yahooChartProvenanceUrl("SPYI"));
    expect(yahooChartProvenanceUrl("SPYI")).toContain("period1=0&period2=9999999999");
  });

  test("HTML tables survive the provider's missing closing tags", () => {
    expect(splitRowCells(`<td>16.78%   <td>0.18%   <td>0.98%</td>`)).toEqual(["16.78%", "0.18%", "0.98%"]);
    expect(splitRowCells(`<th>Rate<span><i class="z"></i></span></th><td>12.15%</td>`)).toEqual(["Rate", "12.15%"]);
    const html = `<table id="etf-table"><tr><th>Ticker</th></tr><tr><td>SPYI</td></tr></table><table><tr><td>CUSIP</td><td>78433H303</td></tr></table>`;
    const tables = parseHtmlTables(html);
    expect(tables.length).toBe(2);
    expect(tables[1][0]).toEqual(["CUSIP", "78433H303"]);
    expect(tableById(html, "etf-table")![1]).toEqual(["SPYI"]);
    expect(tableById(html, "no-such-id")).toBeNull();
    expect(elementTextById(`<div id="as-of">As of 09/18/2026</div>`, "as-of")).toBe("As of 09/18/2026");
    expect(elementTextById(html, "as-of")).toBeNull();
  });

  test("lineup: the header is not a fund, missing </td> keeps all columns, footnote markers are not part of the figure", () => {
    const funds = parseNeosLineup(LINEUP_HTML);
    const byTicker = Object.fromEntries(funds.map((fund) => [fund.ticker, fund]));
    expect(funds.map((fund) => fund.ticker)).toEqual(["SPYI", "XSPI", "IWMI"]);
    expect(byTicker.SPYI).toMatchObject({ name: "S&P 500 High Income ETF", category: "Equity High Income", fundPage: "https://neosfunds.com/spyi/", netAssets: 12_151_808_030 });
    expect(byTicker.XSPI).toMatchObject({ categoryClass: "ticker-enhanced-fixed-income", category: "Boosted High Income", distributionRate: 16.78, secYield: 0.18, managementFee: 0.98, netAssets: 113_242_709, inceptionDate: "2026-02-02" });
    expect(byTicker.IWMI).toMatchObject({ managementFee: 0.68, managementFeeText: "0.68%" });
    expect(NEOS_CATEGORIES.length).toBe(5);
    const cards = parseNeosCategoryCards(`<h3>Equity High Income</h3><a href="https://neosfunds.com/spyi/">S&P</a><h3>High Income Alternatives</h3><a href="https://neosfunds.com/btci/">Bitcoin</a>`);
    expect(cards.get("SPYI")).toBe("Equity High Income");
    expect(cards.get("BTCI")).toBe("High Income Alternatives");
  });

  test("fund details: identifiers, assets, the two Daily Change pairs, and a row that lost its <tr>", () => {
    const details = parseNeosFundDetails(FUND_DETAILS_HTML);
    expect(details).toMatchObject({
      ticker: "SPYI", cusip: "78433H303", isin: "US78433H3030", inceptionDate: "2022-08-29", asOfDate: "2026-09-18",
      netAssets: 12_151_808_030, sharesOutstanding: 228_840_000, primaryExchange: "CBOE", underlyingExposure: "S&P 500 Index", distributionFrequency: "Monthly",
      netAssetValue: 53.64, navDailyChangeValue: 0.1, navDailyChangePercent: 0.19, marketPrice: 53.65, marketPriceDailyChangeValue: 0.09, marketPriceDailyChangePercent: 0.17,
      managementFeeText: "0.68%", totalOperatingExpensesText: "0.68%",
    });
    const orphaned = parseNeosFundDetails(ORPHAN_ROW_HTML);
    expect(orphaned).toMatchObject({ primaryExchange: "NASDAQ", sharesOutstanding: 6_924_981, distributionFrequency: "Monthly", premiumDiscount: -0.15, premiumDiscountText: "-0.15%", bidAskSpread: 0.29 });
  });

  test("distributions: info block with rates, history newest first with exact headers, unpaid month keeps an empty amount", () => {
    const info = parseNeosDistributionInfo(DISTRIBUTION_INFO_HTML)!;
    expect(info).toMatchObject({
      asOfDate: "2026-08-31", frequency: "Monthly", distributionRate: 12.15, trailingRate12M: 11.82, secYield: 0.46,
      distributionAmount: 0.5423, distributionAmountText: "$0.5423", distributionAmountPercent: 1.01,
    });
    expect(parseNeosDistributionInfo("<div>nothing here</div>")).toBeNull();
    const history = parseNeosDistributionHistory(DISTRIBUTION_HISTORY_HTML);
    expect(history.map((row) => row["Declaration Date"])).toEqual(["12/15/2026", "08/18/2026", "01/20/2026", "12/22/2022", "09/20/2022"]);
    for (const row of history) expect(Object.keys(row)).toEqual([...NEOS_DISTRIBUTION_HEADERS]);
    expect(history[0]["Amount ($)"]).toBe("");
    expect(history[1]["Amount ($)"]).toBe("$0.5423");
  });

  test("performance table: NAV, market and benchmark apart, `--%` is null, grouping row is no benchmark; growth series; documents", () => {
    const monthly = parseNeosPerformanceSection(MONTHLY_PERFORMANCE_HTML, "monthly-performance")!;
    expect(monthly.asOfDate).toBe("2026-08-31");
    expect(monthly.nav).toMatchObject({ mo1: 2.47, ytd: 10.72, sinceInceptionCumulative: 75.14, yr3: 16.04, sinceInception: 15.02, yr5: null, yr10: null });
    expect(monthly.market.mo1).toBe(2.52);
    expect(monthly.benchmarkName).toBe("Cboe S&P 500 BuyWrite Monthly Index");
    expect(monthly.benchmark.mo1).toBe(1.6);
    expect(parseNeosPerformanceSection(MONTHLY_PERFORMANCE_HTML, "quarterly-performance")).toBeNull();

    const series = parseNeosNavIndex(NAV_INDEX_HTML)!;
    expect(series).toMatchObject({ startDate: "2022-08-29", endDate: "2022-09-01", points: 3, values: [10000, 9893, 9819], benchmarkValues: [10000, 10100, 10150] });
    expect(parseNeosNavIndex("<html></html>")).toBeNull();

    const documents = parseNeosDocuments(DOCUMENTS_HTML);
    expect(documents.prospectus).toEndWith("/SPYI-Prospectus.pdf");
    expect(documents.sai).toEndWith("/neos_sai-042926.pdf");
    expect(documents.fiscalQ1Holdings).toContain("Part-F");
    expect(documents.fiscalQ3Holdings).toContain("Fiscal-Year-Q3");
    expect(documents.taxInfo).toContain("Tax-Insert-2025");
    expect(documents.form8937).toContain("Form-8937");
    // An empty 8937 tab must not borrow the next tab's PDF.
    expect(parseNeosDocuments(`<div id="tab-form-8937"></div><div id="tab-19a1">${a("XSPI-Prospectus.pdf")}</div>`).form8937).toBeNull();
    expect(Object.values(parseNeosDocuments("<div>nothing</div>")).every((value) => value === null)).toBe(true);
  });

  test("holdings CSV: BOM/CRLF/quotes, the shared column set, verbatim values, categories, a non-holdings file is rejected", () => {
    expect(parseCsv('﻿a,b\n"1,5",2\r\n3,4\n')).toEqual([["a", "b"], ["1,5", "2"], ["3", "4"]]);
    expect(parseCsv('"a""b",c\n\n')).toEqual([['a"b', "c"]]);
    const parsed = parseNeosHoldingsCsv(HOLDINGS_CSV);
    expect(parsed.headers).toEqual([...HOLDINGS_HEADERS]);
    for (const row of parsed.rows) expect(Object.keys(row)).toEqual([...HOLDINGS_HEADERS]);
    expect(parsed).toMatchObject({ asOfDate: "2026-09-21", netAssets: 12_192_173_280, sharesOutstanding: 229_600_000, creationUnits: 22_960, totalRows: 3 });
    const option = parsed.rows[1];
    expect(option).toMatchObject({ Ticker: "SPXW 261001P07075000", "Market Value": "$-3000.00", "Shares Held": "-1,200", "Asset Category": "Option" });
    expect(parsed.rows[2]).toMatchObject({ Name: "Cash&Other", "Asset Category": "Cash" });
    expect(() => parseNeosHoldingsCsv("Date,Other\n09/21/2026,x")).toThrow(/no StockTicker/);
    const categories: Array<[string, string, string, string]> = [
      ["SPXW  261001P07075000", "CBOE S&P 500 INDEX PUT", "N", "Option"], ["Cash&Other", "Cash&Other", "Y", "Cash"],
      ["912797SA6", "United States Treasury Bill 10/01/2026", "N", "Treasury"], ["AGG", "iShares Core U.S. Aggregate Bond ETF", "N", "Fund"], ["AAPL", "APPLE INC", "N", "Equity"],
    ];
    for (const [ticker, name, flag, expected] of categories) expect(neosAssetCategory(ticker, name, flag)).toBe(expected);
  });

  test("N-PORT fallback: filing header and positions fold onto the holdings contract; series identity and freshness guards", () => {
    const report = parseNportXml(NPORT_XML);
    expect(report).toMatchObject({ repPdDate: "2026-06-30", seriesName: "NEOS S&P 500 High Income ETF" });
    expect(report.positions[0]).toMatchObject({ name: "APPLE INC", ticker: "AAPL", cusip: "037833100", valueUsd: 340_237_157.22, percent: 2.79 });
    expect(report.positions[1].balance).toBe(-1200);
    const holdings = nportToHoldings(report.positions, 12_192_173_280);
    expect(Object.keys(holdings[0])).toEqual([...HOLDINGS_HEADERS]);
    expect(holdings[0]).toMatchObject({ Weight: "2.79%", "Market Value": "$340237157.22", "Shares Held": "1331939", "Asset Category": "EC" });
    // A published percent is kept as-is; only a missing one is derived.
    expect(nportToHoldings([{ ...report.positions[1], percent: null }], 12_192_173_280)[0].Weight).toBe("0.00%");

    const name = "NEOS S&P 500 High Income ETF";
    expect(seriesNameMatches("NEOS S&P 500 High Income ETF", name)).toBe(true);
    expect(seriesNameMatches("NEOS Nasdaq-100 High Income ETF", name)).toBe(false);
    expect(seriesNameMatches(null, name)).toBe(false);
    expect(edgarPrimaryDocLinks(`<a href="/Archives/a/primary_doc.xml"><a href='/Archives/b/primary_doc.xml'><a href="/Archives/a/primary_doc.xml">`)).toEqual(["/Archives/a/primary_doc.xml", "/Archives/b/primary_doc.xml"]);
    expect(fallbackIsStale("2026-08-31", "Sep 21 2026")).toBe(true);
    expect(fallbackIsStale("2026-09-30", "Sep 21 2026")).toBe(false);
    expect(fallbackIsStale("2026-08-31", undefined)).toBe(false);
  });

  test("Yahoo chart: newest first, a day without any close is dropped, an adjusted-only day keeps Close null, errors give empty series", () => {
    const parsed = parseYahooChart(YAHOO_JSON);
    expect(parsed.history.map((row) => row.date)).toEqual(["2022-09-02", "2022-09-01", "2022-08-30"]);
    expect(parsed.history[1]).toMatchObject({ close: null, adjClose: 101.5 });
    expect(parsed.history[2]).toMatchObject({ close: 100, adjClose: 99.5, volume: 10 });
    expect(parsed.dividends.length).toBe(2);
    expect(parsed.dividends[0].amount).toBe(0.5219);
    expect(parseYahooExchangeName(YAHOO_JSON)).toBe("PCX");
    expect(parseYahooChart({ chart: { error: { code: "Not Found" } } })).toEqual({ history: [], dividends: [] });
  });

  test("return math, distribution frequency codes and page files", () => {
    expect(cumulativeFromAnnualized(25, 2)).toBe(56.25);
    expect(cumulativeFromAnnualized(null, 3)).toBeNull();
    expect(annualizedFromCumulative(56.25, 2)).toBe(25);
    expect(annualizedFromCumulative(null, 3)).toBeNull();
    expect(annualizedFromCumulative(-150, 3)).toBeNull();
    expect(annualizedFromCumulative(cumulativeFromAnnualized(16.04, 3), 3)).toBe(16.04);
    const payments: Array<[string | null, number | null]> = [["Monthly", 12], ["Quarterly", 4], ["Semi-Annually", 6], ["Annually", 1], ["Weekly", 52], ["Irregular", null], [null, null]];
    for (const [label, expected] of payments) expect(paymentsPerYear(label)).toBe(expected);
    const codes: Array<[string, string]> = [["Monthly", "01 - Monthly"], ["Quarterly", "04 - Quarterly"], ["Semi-Annually", "06 - Semi-annually"], ["Annually", "12 - Annually"], ["None", "00 - None"], ["Irregular", "99 - Irregular"], ["", "00 - None"]];
    for (const [label, expected] of codes) expect(formatDistributionFrequency(label)).toBe(expected);
    const now = new Date("2026-09-21T00:00:00Z");
    expect(inferDistributionFrequency(["2026-01-20", "2026-02-17", "2026-03-17", "2026-04-21", "2026-05-19", "2026-06-15"], now)).toBe("01 - Monthly");
    expect(inferDistributionFrequency(["2025-12-19", "2026-03-20", "2026-06-19"], now)).toBe("04 - Quarterly");
    expect(inferDistributionFrequency([], now)).toBe("00 - Unknown");
    expect(splitPages([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(splitPages([], 250)).toEqual([]);
    expect([pageFileName(1), pageFileName(12), pageFileName(1000)]).toEqual(["001.json", "012.json", "1000.json"]);
  });
});

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

describe("metrics", () => {
  test("a young fund: horizons it is too young for are null, never 0; the others are derived from the annualized figures", async () => {
    await inTempRoot(async () => {
      mockFetch(site(RICH_PAGES));
      const { metrics } = (await updateFund(FUND, quiet(), stats()))! as { metrics: Record<string, unknown> };
      expect(metrics).toMatchObject({ ytd: 10.72, tr1y: 17.65, cagr3y: 16.04, siAnn: 15.02, tr5y: null, tr10y: null, cagr5y: null, cagr10y: null });
      expect(metrics.tr3y).toBe(cumulativeFromAnnualized(16.04, 3));
      expect(Object.values(metrics).includes(0)).toBe(false);
    });
  });

  test("every row has the same metrics keys; returnsBasis and performanceAsOf travel together", async () => {
    await inTempRoot(async () => {
      mockFetch(site(RICH_PAGES));
      const rich = (await updateFund(FUND, quiet(), stats()))! as { metrics: Record<string, unknown> };
      const bare = (await updateFund({ ...FUND, ticker: "XSPI" }, quiet(), stats()))! as { metrics: Record<string, unknown> };
      const placeholder = placeholderEntry(parseNeosLineup(LINEUP_HTML)[0]) as { metrics: Record<string, unknown> };
      const keys = Object.keys(placeholder.metrics);
      expect(Object.keys(rich.metrics)).toEqual(keys);
      expect(Object.keys(bare.metrics)).toEqual(keys);
      for (const row of [rich, bare, placeholder]) expect(typeof row.metrics.returnsBasis === "string" && (row.metrics.returnsBasis as string).trim() !== "").toBe(true);
      expect(rich.metrics.returnsBasis).toBe(RETURNS_BASIS);
      expect(rich.metrics.performanceAsOf).toBe("2026-08-31");
      expect(bare.metrics.performanceAsOf).toBeNull();
      expect(bare.metrics.tr1y).toBeNull();
      expect(performanceAsOf("Aug 31 2026")).toBe("2026-08-31");
      expect(performanceAsOf("")).toBeNull();
      expect(performanceAsOf(undefined)).toBeNull();
    });
  });

  test("TER: the single all-in operating expense is both net and gross; the management fee stays separate", async () => {
    await inTempRoot(async () => {
      mockFetch(site(RICH_PAGES));
      const entry = (await updateFund(FUND, quiet(), stats()))! as Record<string, unknown>;
      expect(entry).toMatchObject({ ter: "0.68%", terValue: 0.68, terGross: "0.68%", terGrossValue: 0.68, managementFeeValue: 0.68 });
    });
  });
});

// ---------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------

describe("pipeline", () => {
  test("a full run lists every fund; an identical second run writes nothing; a one-ticker run keeps all rows", async () => {
    await inTempRoot(async (root) => {
      mockFetch(site(RICH_PAGES));
      await main(RUN_ENV);
      const index = readJson(root, "index.json");
      expect(index.funds.map((fund: { ticker: string }) => fund.ticker)).toEqual(["IWMI", "SPYI", "XSPI"]);
      expect(index.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(readdirSync(path.join(root, "funds")).sort()).toEqual(["IWMI", "SPYI", "XSPI"]);
      const keys = Object.keys(index.funds[0].metrics);
      for (const fund of index.funds) {
        expect(Object.keys(fund.metrics)).toEqual(keys);
        expect(fund.dataFile).toBe(`./funds/${fund.ticker}/meta.json`);
      }

      // Pin the stamp to the past: an identical rerun must keep it, so the diff is empty whatever the clock says.
      writeFileSync(path.join(root, "index.json"), JSON.stringify({ ...index, generatedAt: "2020-01-01T00:00:00Z" }, null, 2) + "\n");
      const first = snapshot(root);
      await main(RUN_ENV);
      expect(snapshot(root)).toEqual(first);

      await main({ ...RUN_ENV, TICKERS: "SPYI" });
      const after = readJson(root, "index.json");
      expect(after.funds.map((fund: { ticker: string }) => fund.ticker)).toEqual(["IWMI", "SPYI", "XSPI"]);
      expect(readdirSync(path.join(root, "funds")).sort()).toEqual(["IWMI", "SPYI", "XSPI"]);
    });
  });

  test("a lineup fund without a fund page read yet has dataFile null and no invented values", () => {
    const row = placeholderEntry(parseNeosLineup(LINEUP_HTML)[1]) as Record<string, any>;
    expect(row.dataFile).toBeNull();
    expect(row).toMatchObject({ terValue: null, navValue: null, holdings: 0, history: 0 });
    expect(Object.values(row.metrics).filter((value) => typeof value === "number")).toEqual([]);
  });

  test("a skipped or failed source keeps the published fund data", async () => {
    for (const options of [{ skipYahoo: true }, {}]) {
      await inTempRoot(async (root) => {
        const dir = seedFeed(root);
        const urls = mockFetch(site({}, null));
        const entry = await updateFund(FUND, { ...quiet(), ...options }, stats());
        expect(entry!.history).toBe(3);
        expect(urls.some((url) => url.includes("finance.yahoo.com"))).toBe(!("skipYahoo" in options));
        expect(readdirSync(path.join(dir, "history")).sort()).toEqual(["001.json"]);
        expect(readJson(dir, "history", "001.json").rows.length).toBe(3);
        expect(readJson(dir, "meta.json").history.totalRows).toBe(3);
      });
    }
  });

  test("SKIP_NEOS never reads neosfunds.com and keeps the published fund data; Yahoo down returns the previous row", async () => {
    await inTempRoot(async (root) => {
      const dir = seedFeed(root);
      const previous = { ticker: "SPYI", holdings: 1, history: 3, metrics: { tr1y: 14.62 } };
      const urls = mockFetch((url) => (url.includes("finance.yahoo.com") ? new Response(CHART) : null));
      const entry = await refreshHistoryOnly(FUND, previous as any, { ...quiet(), skipNeos: true }, stats());
      expect(urls.every((url) => !url.includes("neosfunds.com"))).toBe(true);
      expect(entry.history).toBe(2);
      expect((entry.metrics as { tr1y: number }).tr1y).toBe(14.62);
      expect(readJson(dir, "meta.json").holdings.totalRows).toBe(1);
      mockFetch(() => null);
      expect(await refreshHistoryOnly(FUND, previous as any, { ...quiet(), skipNeos: true }, stats())).toBe(previous as any);
    });
  });

  test("EDGAR fallback takes the filing of this series and never replaces fresher published holdings", async () => {
    const listing = `<a href="/Archives/x/other/primary_doc.xml"><a href="/Archives/x/spyi/primary_doc.xml">`;
    const routes = (period: string) => (url: string): Response | null => {
      if (url.includes("neosfunds.com/spyi")) return new Response("<html></html>");
      if (url.includes("browse-edgar")) return new Response(listing);
      if (url.includes("/other/")) return new Response(nport("NEOS Nasdaq-100 High Income ETF", "2026-09-30"));
      if (url.includes("/spyi/")) return new Response(nport("NEOS S&amp;P 500 High Income ETF", period));
      return null;
    };
    await inTempRoot(async (root) => {
      const dir = seedFeed(root, "Aug 01 2026");
      mockFetch(routes("2026-08-31"));
      const entry = await updateFund(FUND, quiet(), stats());
      expect(entry!.holdings).toBe(1);
      expect(readJson(dir, "holdings", "001.json").rows[0].Name).toBe("X CORP");
      expect(readJson(dir, "meta.json").holdings.source).toContain("/spyi/");
    });
    await inTempRoot(async (root) => {
      const dir = seedFeed(root, "Sep 21 2026");
      mockFetch(routes("2026-08-31"));
      await expect(updateFund(FUND, quiet(), stats())).rejects.toThrow(/older than the published holdings/);
      expect(readJson(dir, "holdings", "001.json").rows[0].Name).toBe("OLD");
    });
  });

  test("an unknown ticker is an error, and when every fund fails the run fails", async () => {
    await inTempRoot(async () => {
      mockFetch((url) => (url === "https://neosfunds.com/" ? new Response(LINEUP_HTML) : null));
      await expect(main({ ...RUN_ENV, TICKERS: "NOPE" })).rejects.toThrow(/not in the NEOS lineup: NOPE/);
      await expect(main({ ...RUN_ENV, EDGAR_FALLBACK: "false" })).rejects.toThrow(/every fund failed/);
    });
  });

  test("bounded runs: the MAX_FETCHES cursor wraps and return filters exclude funds without the figure", () => {
    const funds = ["A", "B", "C", "D", "E"].map((ticker) => ({ ticker }));
    const tickers = (cursor: string | null, max: number) => selectBatch(funds, cursor, max).map((fund) => fund.ticker);
    expect(tickers("D", 3)).toEqual(["E", "A", "B"]);
    expect(tickers("E", 2)).toEqual(["A", "B"]);
    expect(tickers(null, 2)).toEqual(["A", "B"]);
    expect(tickers("ZZ", 2)).toEqual(["A", "B"]);
    expect(tickers("C", 0).length).toBe(5);
    expect(filterScope(readConfig({ TICKERS: "SPYI" }))).not.toBe(filterScope(readConfig({})));
    const filters = readConfig({ PERFORMANCE_5Y: "5:", TOTAL_RETURN_10Y: "0:" });
    const passes = (metrics: object) => passesReturnFilters({ ticker: "A", metrics } as any, filters);
    expect([passes({ cagr5y: null, tr10y: 50 }), passes({ cagr5y: 8, tr10y: null }), passes({ cagr5y: 8, tr10y: 50 })]).toEqual([false, false, true]);
  });

  test("writes are atomic and skip identical content; run stamps move only when the content moved", async () => {
    await inTempRoot(async (root) => {
      const target = path.join(root, "a.json");
      expect(await writeIfChanged(target, "{}\n")).toBe("written");
      expect(await writeIfChanged(target, "{}\n")).toBe("unchanged");
      expect(readdirSync(root)).toEqual(["a.json"]);

      const index = path.join(root, "index.json");
      let clock = "2026-10-02T00:00:00Z";
      const stamp = () => clock;
      expect(await writeJsonIfContentChanged(index, { funds: [1] }, ["generatedAt"], stamp)).toBe("written");
      clock = "2026-10-03T00:00:00Z";
      expect(await writeJsonIfContentChanged(index, { funds: [1], generatedAt: "ignored" }, ["generatedAt"], stamp)).toBe("unchanged");
      expect(readJson(index).generatedAt).toBe("2026-10-02T00:00:00Z");
      expect(await writeJsonIfContentChanged(index, { funds: [1, 2] }, ["generatedAt"], stamp)).toBe("written");
      expect(readJson(index).generatedAt).toBe("2026-10-03T00:00:00Z");
    });
  });
});

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

describe("network", () => {
  /** A fetch that never answers: the headers never arrive, or the body never ends. Both honour the abort signal. */
  const stalled = (where: "headers" | "body") => {
    const calls = { n: 0 };
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      calls.n += 1;
      const signal = init?.signal;
      if (where === "headers") return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      const body = new ReadableStream({ start: (controller) => signal?.addEventListener("abort", () => controller.error(new Error("aborted"))) });
      return Promise.resolve(new Response(body));
    }) as unknown as typeof fetch;
    return calls;
  };

  test("the timeout covers headers and body, and retries are bounded by MAX_RETRIES", async () => {
    expect(FETCH_TIMEOUT_MS).toBe(45_000);
    for (const where of ["headers", "body"] as const) {
      const calls = stalled(where);
      const cfg = { ...readConfig({ REQUEST_SLEEP: "0", MAX_RETRIES: "1" }), timeoutMs: 30, retryDelayMs: 0 };
      await expect(settles(fetchRetried("https://x.invalid/", {}, cfg, "stall", (response) => response.text()))).rejects.toThrow(/stall/);
      expect(calls.n).toBe(2);
    }
  });

  test("a permanent status is not retried, a retryable one is", async () => {
    for (const [status, expectedCalls] of [[404, 1], [503, 3]] as const) {
      let calls = 0;
      globalThis.fetch = (async () => { calls += 1; return new Response("no", { status }); }) as unknown as typeof fetch;
      const cfg = { ...readConfig({ REQUEST_SLEEP: "0", MAX_RETRIES: "2" }), retryDelayMs: 0 };
      await expect(fetchRetried("https://x.invalid/", {}, cfg, "gone", (response) => response.text())).rejects.toThrow(new RegExp(`HTTP ${status}`));
      expect(calls).toBe(expectedCalls);
    }
  });

  test("CONCURRENCY is real: peak in-flight requests is 1 at 1 and 3 at 3; pacing reserves distinct lanes", async () => {
    const lanes = [0, 0, 0];
    const slots = [1, 2, 3, 4].map(() => reserveSlot(lanes, 1000, 10_000));
    expect(slots.map((slot) => slot.lane)).toEqual([0, 1, 2, 0]);
    expect(slots.map((slot) => slot.startAt)).toEqual([10_000, 10_000, 10_000, 11_000]);

    const peaks: number[] = [];
    for (const concurrency of ["1", "3"]) {
      await inTempRoot(async () => {
        let inFlight = 0;
        let peak = 0;
        const routes = site(RICH_PAGES);
        mockFetch(async (url) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return routes(url);
        });
        await main({ ...RUN_ENV, CONCURRENCY: concurrency });
        peaks.push(peak);
      });
    }
    expect(peaks).toEqual([1, 3]);
  });

  test("HISTORY_RANGE shrinks the Yahoo request with an explicit period1/period2, never `range`", async () => {
    const fixed = 1_700_000_000_000;
    expect(yahooChartUrl("SPYI", "max", fixed)).toContain("period1=0&period2=1700000000");
    expect(yahooChartUrl("SPYI", "5y", fixed)).toContain(`period1=${Math.floor(1_700_000_000 - 5 * 365.25 * 86_400)}&period2=1700000000`);
    expect(yahooChartUrl("SPYI", "5y", fixed)).not.toContain("range=");
    expect(() => yahooChartUrl("SPYI", "6mo", fixed)).toThrow(/expected max or Ny/);

    await inTempRoot(async () => {
      const urls = mockFetch(site());
      await main({ ...RUN_ENV, TICKERS: "SPYI", HISTORY_RANGE: "5y" });
      const yahoo = urls.find((url) => url.includes("finance.yahoo.com"))!;
      const period1 = Number(/period1=(\d+)/.exec(yahoo)![1]);
      expect(period1).toBeGreaterThan(0);
      expect(yahoo).not.toContain("range=");
    });
  });

  test("system CA: certificate errors are recognised, also through cause", () => {
    expect(isCertError({ code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" })).toBe(true);
    expect(isCertError(new Error("unable to get local issuer certificate"))).toBe(true);
    expect(isCertError(new Error("fetch failed", { cause: new Error("unable to get local issuer certificate") }))).toBe(true);
    expect(isCertError({ code: "ECONNRESET", message: "socket hang up" })).toBe(false);
    expect(isCertError(new Error("HTTP 403 Forbidden"))).toBe(false);
    expect(isCertError(null)).toBe(false);
  });

  test("system CA: false or an active store leave fetch alone, true restarts, auto restarts once on a cert error only", async () => {
    const calls: number[] = [];
    const reexec = (() => { calls.push(1); throw new Error("reexec"); }) as () => never;
    installSystemCa("false", reexec, false);
    installSystemCa("auto", reexec, true);
    installSystemCa("true", reexec, true);
    expect(globalThis.fetch).toBe(originalFetch);
    expect(calls.length).toBe(0);
    expect(() => installSystemCa("true", reexec, false)).toThrow("reexec");
    expect(calls.length).toBe(1);

    let behaviour: "ok" | "cert" | "reset" = "ok";
    globalThis.fetch = (async () => {
      if (behaviour === "cert") throw new Error("fetch failed", { cause: { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" } });
      if (behaviour === "reset") throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      return new Response("ok");
    }) as unknown as typeof fetch;
    const stub = globalThis.fetch;
    installSystemCa("auto", reexec, false);
    expect(globalThis.fetch).not.toBe(stub);
    expect(await (await fetch("https://example.invalid/")).text()).toBe("ok");
    behaviour = "reset";
    await expect(fetch("https://example.invalid/")).rejects.toThrow("socket hang up");
    expect(calls.length).toBe(1);
    behaviour = "cert";
    await expect(fetch("https://example.invalid/")).rejects.toThrow("reexec");
    expect(calls.length).toBe(2);
  });
});
