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
  CLOSED_FUNDS,
  CONTROL_NAMES,
  FETCH_TIMEOUT_MS,
  HISTORY_HEADERS,
  HOLDINGS_HEADERS,
  HOLDINGS_GUARD_RELAX,
  NEOS_CATEGORIES,
  NEOS_DISTRIBUTION_HEADERS,
  RETURNS_BASIS,
  adjCloseCell,
  annualizedFromCumulative,
  cleanText,
  closedFund,
  compareDisplayDates,
  cumulativeFromAnnualized,
  decodeHtmlEntities,
  elementTextById,
  fetchRetried,
  filterScope,
  formatAumDisplay,
  formatDistributionFrequency,
  formatMoneyText,
  formatNeosDate,
  formatPercentText,
  holdingsGuard,
  holdingsWeightCount,
  inferDistributionFrequency,
  installSystemCa,
  isCertError,
  isMissingCell,
  main,
  neosAssetCategory,
  neosFundPageUrl,
  neosHoldingsCsvUrl,
  normalizeNumberText,
  nportHoldingsSheet,
  nportIsFresh,
  nportTickers,
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
  parseNportFiling,
  parseSecCompanyNames,
  parseSecFundTickers,
  parseRange,
  parseYahooChart,
  parseYahooExchangeName,
  passesReturnFilters,
  paymentsPerYear,
  performanceAsOf,
  placeholderEntry,
  withYieldBasis,
  yieldBasisFor,
  readConfig,
  refreshHistoryOnly,
  reserveSlot,
  resetSecState,
  resolveControls,
  runtimeControls,
  sanitizeTicker,
  selectBatch,
  setApiRootForTests,
  splitPages,
  splitRowCells,
  tableById,
  toIsoDate,
  fundPageProblem,
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
  resetSecState();
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

// Official daily CSV: an equity row, a written SPXW call (OCC symbol as Cusip), the cash line (weights add up to 100).
const HOLDINGS_CSV = [
  "Date,Account,StockTicker,Cusip,SecurityName,Shares,Price,MarketValue,Weightings,NetAssets,SharesOutstanding,CreationUnits,MoneyMarketFlag",
  '09/21/2026,NEOS,AAPL,037833100,APPLE INC,"1,331,939","255.46","$340,237,157.22","2.79%","$12,192,173,280.00","229,600,000","22,960","N"',
  '09/21/2026,NEOS,"SPXW  261001P07075000",SPXW  261001P07075000,"CBOE S&P 500 INDEX PUT 10/01/2026 70.750","-1,200","2.50","$-3,000.00","-0.00%","$12,192,173,280.00","229,600,000","22,960","N"',
  '09/21/2026,NEOS,Cash&Other,Cash&Other,Cash&Other,"162,387,743","1.00","$162,387,742.50","97.21%","$12,192,173,280.00","229,600,000","22,960","Y"',
].join("\n");

// N-PORT-P samples (shared nport-reader): a U.S. equity, a written SPY call whose reference instrument is SPY, a Treasury bill
// with a filer ticker but no weight
const NPORT_AAPL = '<invstOrSec><name>APPLE INC</name><cusip>037833100</cusip><identifiers><isin value="US0378331005"/></identifiers><balance>1331939.00000000</balance><curCd>USD</curCd><valUSD>340237157.22</valUSD><pctVal>102.79</pctVal><assetCat>EC</assetCat></invstOrSec>';
const NPORT_OPTION = '<invstOrSec><name>SPDR S&amp;P 500 ETF TRUST</name><title>SPY US 10/16/26 C680</title><cusip>000000000</cusip><identifiers><other otherDesc="OCC" value="SPY   261016C00680000"/></identifiers><balance>-1200</balance><curCd>USD</curCd><valUSD>-3000</valUSD><pctVal>-2.79</pctVal><assetCat>DE</assetCat><derivativeInfo><optionSwaptionWarrantDeriv derivCat="OPT"><descRefInstrmnt><otherRefInst><identifiers><cusip value="78462F103"/><ticker value="SPY"/></identifiers></otherRefInst></descRefInstrmnt></optionSwaptionWarrantDeriv></derivativeInfo></invstOrSec>';
const NPORT_BILL = '<invstOrSec><name>UNITED STATES TREASURY BILL</name><cusip>912797QX8</cusip><identifiers><ticker value="B"/></identifiers><balance>1000000</balance><curCd>USD</curCd><valUSD>990000</valUSD><assetCat>DBT</assetCat></invstOrSec>';
const nportXml = (seriesId: string, period: string, positions: string[]) => `<edgarSubmission><genInfo><regName>NEOS ETF Trust</regName><regCik>0001848758</regCik><seriesName>NEOS S&amp;P 500 High Income ETF</seriesName><seriesId>${seriesId}</seriesId><repPdDate>${period}</repPdDate></genInfo><fundInfo><netAssets>12192173280</netAssets></fundInfo><invstOrSecs>${positions.join("")}</invstOrSecs></edgarSubmission>`;
const NPORT_XML = nportXml("S000077194", "2026-09-30", [NPORT_AAPL, NPORT_OPTION, NPORT_BILL]);
const NPORT_ACCESSION = "0000894189-26-023158";
const NPORT_DOC = "https://www.sec.gov/Archives/edgar/data/1848758/000089418926023158/primary_doc.xml";

/** SEC EDGAR: the fund and company ticker tables, the trust's submissions, one series feed for every series and one N-PORT document; null for other URLs. */
const sec = (xml: string) => (url: string): Response | null => {
  if (url === "https://www.sec.gov/files/company_tickers_mf.json") return new Response(JSON.stringify({ fields: ["cik", "seriesId", "classId", "symbol"], data: [[1848758, "S000077194", "C000237368", "SPYI"], [1848758, "S000085554", "C000250847", "IWMI"]] }));
  if (url === "https://www.sec.gov/files/company_tickers.json") return new Response(JSON.stringify({ 0: { ticker: "AAPL", title: "Apple Inc." }, 1: { ticker: "SPY", title: "SPDR S&P 500 ETF TRUST" } }));
  if (url === "https://data.sec.gov/submissions/CIK0001848758.json") return new Response(JSON.stringify({ cik: "1848758", filings: { recent: { form: ["NPORT-P"], accessionNumber: [NPORT_ACCESSION], filingDate: ["2026-10-20"], reportDate: ["2026-09-30"] } } }));
  if (url.includes("browse-edgar")) return new Response(`<feed><entry><content><accession-number>${NPORT_ACCESSION}</accession-number><filing-date>2026-10-20</filing-date><filing-type>NPORT-P</filing-type><filing-href>https://www.sec.gov/Archives/edgar/data/1848758/000089418926023158/${NPORT_ACCESSION}-index.htm</filing-href><period>2026-09-30</period></content></entry></feed>`);
  if (url === NPORT_DOC) return new Response(xml);
  return null;
};

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

  test("source URLs: lowercase fund page, the one admin-ajax holdings action, deterministic Yahoo provenance", () => {
    expect(neosFundPageUrl(" SPYI ")).toBe("https://neosfunds.com/spyi/");
    expect(neosHoldingsCsvUrl("SPYI")).toBe("https://neosfunds.com/wp-admin/admin-ajax.php?action=download_holdings_csv&ticker=SPYI");
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
});

describe("parsing 2", () => {
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
});

describe("parsing 3", () => {
  test('holdings guard: header-only, renamed weight column, broken weights, a bad weight sum and a halved sheet are rejected', () => {
    const headers = ['Name', 'Ticker', 'Weight'];
    const rows = [{ Name: 'A', Ticker: 'A', Weight: '60%' }, { Name: 'B', Ticker: 'B', Weight: '40%' }];
    expect(holdingsGuard(headers, rows, 2)).toBeNull();
    expect(holdingsGuard(headers, [['A', 'A', '60'], ['B', 'B', '40']], null)).toBeNull();
    expect(holdingsGuard([], [], 0)).toBeNull(); // nothing published before: an empty sheet is honest
    expect(holdingsGuard(headers, [], 505)).toContain('no holdings rows');
    expect(holdingsGuard(['Name', 'Ticker', 'Wt'], rows, 2)).toContain('no weight column');
    expect(holdingsGuard(headers, rows.map((row) => ({ ...row, Weight: '6​0' })), 2)).toContain('numeric weight');
    const allocation = [{ Name: 'Cash&Collateral', Ticker: '-', Weight: '100' }, { Name: 'Equities', Ticker: '-', Weight: '476' }];
    expect(holdingsGuard(headers, allocation, 2)).toContain('outside 50..150');
    expect(holdingsGuard(headers, allocation, 2, ['sum'])).toBeNull();
    expect(holdingsGuard(headers, rows, 5)).toContain('less than half');
  });

  test("N-PORT fallback (shared nport-reader): SEC ticker map, empty missing numbers, an option keeps its own identifier and no ticker, tickers only for U.S. equities", () => {
    const map = parseSecFundTickers({ fields: ["cik", "seriesId", "classId", "symbol"], data: [[1848758, "S000077194", "C000237368", "SPYI"]] });
    expect(map.get("SPYI")).toEqual({ cik: "0001848758", seriesId: "S000077194", classId: "C000237368" });
    const filing = parseNportFiling(NPORT_XML);
    expect([filing.seriesId, filing.repPdDate, filing.netAssets, filing.positions.length]).toEqual(["S000077194", "2026-09-30", 12_192_173_280, 3]);
    const names = parseSecCompanyNames({ 0: { ticker: "AAPL", title: "Apple Inc." }, 1: { ticker: "SPY", title: "SPDR S&P 500 ETF TRUST" } });
    const sheet = nportHoldingsSheet(filing, nportTickers(filing.positions, names));
    expect(Object.keys(sheet[0])).toEqual([...HOLDINGS_HEADERS]);
    expect(sheet[0]).toEqual({ Name: "APPLE INC", Ticker: "AAPL", Identifier: "037833100", Weight: "102.79%", "Market Value": "$340237157.22", "Shares Held": "1331939", "Asset Category": "EC" });
    // the written SPY call keeps its OCC code (whitespace collapsed), never SPY's CUSIP or ticker; the bill keeps no ticker ("B") and an empty weight, never 0
    expect(sheet.slice(1).map((row) => [row.Ticker, row.Identifier, row.Weight, row["Market Value"], row["Shares Held"], row["Asset Category"]])).toEqual([
      ["-", "SPY 261016C00680000", "-2.79%", "$-3000.00", "-1200", "DE"],
      ["-", "912797QX8", "", "$990000.00", "1000000", "DBT"],
    ]);
  });

  test("N-PORT freshness: a report replaces published holdings only when strictly newer; the issuer CSV's newer day always wins", () => {
    expect(nportIsFresh("2026-09-30", "2026-10-26", 508)).toBe(false); // SPYI published from the 10-26 issuer CSV
    expect(nportIsFresh("2026-09-30", "2026-09-30", 508)).toBe(false);
    expect(nportIsFresh("2026-09-30", "2026-08-31", 100)).toBe(true);
    expect(nportIsFresh("", "2026-08-31", 100)).toBe(false);
    expect(nportIsFresh("2026-09-30", null, 0)).toBe(true);
    expect(nportIsFresh("2026-09-30", null, 100)).toBe(false); // published rows without a date cannot be compared: keep them
  });
});

describe("parsing 4", () => {
  test("dates: month-name and U.S. dates are the same calendar day in every time zone", () => {
    for (const tz of ["Asia/Tokyo", "America/Los_Angeles", "UTC"]) {
      process.env.TZ = tz;
      expect(["Oct 24, 2026", "October 24 2026", "Oct 24 2026", "24 Oct 2026", "10/24/2026", "10/24/26", "2026-10-24"].map((raw) => toIsoDate(raw))).toEqual(Array(7).fill("2026-10-24"));
      expect([toIsoDate("not a date"), toIsoDate("02/30/2026")]).toEqual(["", ""]);
      expect(formatNeosDate("24 Oct 2026")).toBe("Oct 24 2026");
    }
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

type MetricsRow = { metrics: Record<string, unknown> };
// CatalogEntry is an open record; the updater always writes a metrics object on a built row
const rowOf = (entry: object | null): MetricsRow => entry as unknown as MetricsRow;

describe("metrics", () => {
  test("a young fund: horizons it is too young for are null, never 0; the others are derived from the annualized figures", async () => {
    await inTempRoot(async () => {
      mockFetch(site(RICH_PAGES));
      const { metrics } = rowOf(await updateFund(FUND, quiet(), stats()));
      expect(metrics).toMatchObject({ ytd: 10.72, tr1y: 17.65, cagr3y: 16.04, siAnn: 15.02, tr5y: null, tr10y: null, cagr5y: null, cagr10y: null });
      expect(metrics.tr3y).toBe(cumulativeFromAnnualized(16.04, 3));
      expect(Object.values(metrics).includes(0)).toBe(false);
    });
  });

  test("a fund younger than a horizon publishes no return for it: calendar anniversaries, inclusive (3y from 2023-09-01 is null on 2026-08-31)", async () => {
    await inTempRoot(async () => {
      mockFetch(site(RICH_PAGES));
      const at = async (inceptionDate: string) => rowOf(await updateFund({ ...FUND, inceptionDate }, quiet(), stats())).metrics;
      const three = await at("2023-09-01");
      expect([three.tr1y, three.cagr3y, three.tr3y, three.siAnn]).toEqual([17.65, null, null, 15.02]);
      const young = await at("2025-09-01");
      expect([young.ytd, young.tr1y, young.cagr3y, young.siAnn]).toEqual([10.72, null, null, null]);
      const anniversary = await at("2023-08-31");
      expect([anniversary.cagr3y, anniversary.tr3y]).toEqual([16.04, cumulativeFromAnnualized(16.04, 3)]);
    });
  });

  test("every row has the same metrics keys; returnsBasis and performanceAsOf travel together", async () => {
    await inTempRoot(async () => {
      mockFetch(site(RICH_PAGES));
      const rich = rowOf(await updateFund(FUND, quiet(), stats()));
      const bare = rowOf(await updateFund({ ...FUND, ticker: "XSPI" }, quiet(), stats()));
      const placeholder = rowOf(placeholderEntry(parseNeosLineup(LINEUP_HTML)[0]));
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

  test("dividendYieldBasis: the Distribution Rate is official-distribution-rate, a null yield has a null code, and every row has the same key set", async () => {
    await inTempRoot(async () => {
      mockFetch(site({ SPYI: RICH_PAGES.SPYI + DISTRIBUTION_INFO_HTML }));
      const rich = rowOf(await updateFund(FUND, quiet(), stats()));
      const lineupOnly = rowOf(await updateFund({ ...FUND, ticker: "XSPI", distributionRate: 16.78 }, quiet(), stats()));
      expect(lineupOnly.metrics).toMatchObject({ dividendYield: 16.78, dividendYieldBasis: "official-distribution-rate" });
      const bare = rowOf(await updateFund({ ...FUND, ticker: "XSPI", distributionRate: null }, quiet(), stats()));
      const placeholder = rowOf(placeholderEntry(parseNeosLineup(LINEUP_HTML)[0]));
      expect(rich.metrics.dividendYield).toBe(12.15);
      expect(rich.metrics.dividendYieldBasis).toBe("official-distribution-rate");
      for (const row of [bare, placeholder]) {
        expect(row.metrics.dividendYield).toBeNull();
        expect(row.metrics.dividendYieldBasis).toBeNull();
      }
      expect(placeholder.metrics.dividendYieldBasis).toBeNull();
      expect(yieldBasisFor(0)).toBe("official-distribution-rate");
      expect(yieldBasisFor(null)).toBeNull();
      // kept rows: the code follows the yield the row holds, and a stale code never sits next to a null yield
      const kept = withYieldBasis<MetricsRow>({ metrics: { ytd: 1, dividendYield: 9.5, dividendYieldText: "9.50%", tr1y: 2 } });
      expect(kept.metrics.dividendYieldBasis).toBe("official-distribution-rate");
      const stale = withYieldBasis<MetricsRow>({ metrics: { dividendYield: null, dividendYieldText: "—", dividendYieldBasis: "official-distribution-rate" } });
      expect(stale.metrics.dividendYieldBasis).toBeNull();
      const keys = Object.keys(placeholder.metrics);
      expect(Object.keys(rich.metrics)).toEqual(keys);
      expect(Object.keys(bare.metrics)).toEqual(keys);
      expect(Object.keys(lineupOnly.metrics)).toEqual(keys);
      const old = withYieldBasis<MetricsRow>({ metrics: { dividendYield: 1, dividendYieldText: "1%", distributionYield: 1, returnsBasis: "x", performanceAsOf: null } });
      expect(Object.keys(old.metrics)).toEqual(["dividendYield", "dividendYieldText", "dividendYieldBasis", "distributionYield", "returnsBasis", "performanceAsOf"]);
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
      expect(keys).toContain("dividendYieldBasis");
      // the 52-week keys of the range-52w block sit in every row, in front of returnsBasis and performanceAsOf
      expect(keys.slice(-9)).toEqual(["week52Low", "week52High", "range52w", "range52wClose", "range52wAsOf", "range52wSince", "range52wBasis", "returnsBasis", "performanceAsOf"]);
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

  test("two runs on the same source data write zero changes even when Yahoo adjusted closes jitter across a cent boundary", async () => {
    await inTempRoot(async (root) => {
      // Yahoo float32 noise seen live: a value on a cent boundary comes back as 31.544998 and 31.545001 a minute apart
      const jittered = (adjclose: number[]) => {
        const chart = JSON.parse(CHART);
        chart.chart.result[0].indicators.adjclose = [{ adjclose }];
        return site(RICH_PAGES, JSON.stringify(chart));
      };
      mockFetch(jittered([54.104999, 54.295001]));
      await main(RUN_ENV);
      const index = readJson(root, "index.json");
      writeFileSync(path.join(root, "index.json"), JSON.stringify({ ...index, generatedAt: "2020-01-01T00:00:00Z" }, null, 2) + "\n");
      const first = snapshot(root);
      expect(readJson(root, "funds", "SPYI", "history", "001.json").rows.map((row: Record<string, string>) => row["Adj Close"])).toEqual(["54.30", "54.10"]);
      mockFetch(jittered([54.105001, 54.294999]));
      await main(RUN_ENV);
      expect(snapshot(root)).toEqual(first);
      // a real change beyond the noise is still written
      mockFetch(jittered([54.12, 54.27]));
      await main(RUN_ENV);
      expect(readJson(root, "funds", "SPYI", "history", "001.json").rows.map((row: Record<string, string>) => row["Adj Close"])).toEqual(["54.27", "54.12"]);
      expect(adjCloseCell(31.545001, "31.54")).toBe("31.54");
      expect(adjCloseCell(31.5452, "31.54")).toBe("31.55");
      expect(adjCloseCell(31.545001, undefined)).toBe("31.55");
      expect(adjCloseCell(null, "31.54")).toBe("");
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
});

describe("pipeline 2", () => {
  test("NEOS-2: a fund page without Fund Details or the monthly table keeps a published fund exactly as published", async () => {
    await inTempRoot(async (root) => {
      mockFetch(site(RICH_PAGES));
      await main(RUN_ENV);
      const first = snapshot(root);
      for (const page of [FUND_DETAILS_HTML, MONTHLY_PERFORMANCE_HTML]) {
        mockFetch(site({ SPYI: page }));
        const lines: string[] = [];
        console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
        await main(RUN_ENV);
        expect(snapshot(root)).toEqual(first);
        expect(lines.join("\n")).toMatch(/1 failed/);
      }
      await expect(updateFund(FUND, quiet(), stats())).rejects.toThrow(/^SPYI: fund page has no Fund Details panel; kept the previous complete data/);
    });
    // a fund that never published those values keeps its honest nulls
    expect(fundPageProblem(parseNeosFundDetails("<html></html>"), null, { cusip: null, navValue: null, returns: { monthEnd: { raw: "" } } })).toBeNull();
    expect(fundPageProblem(parseNeosFundDetails("<html></html>"), null, null)).toBeNull();
  });
  test("holdings that fail the guard keep the fund exactly as published and report it failed", async () => {
    await inTempRoot(async (root) => {
      mockFetch(site(RICH_PAGES));
      await main(RUN_ENV);
      const first = snapshot(root);
      // NEOS renames its weight column in the SPYI download: every Weight cell comes out empty
      const renamed = HOLDINGS_CSV.replace("Weightings", "Weighting %");
      const good = site(RICH_PAGES);
      mockFetch((url) => (url.includes("download_holdings_csv&ticker=SPYI") ? new Response(renamed) : good(url)));
      const lines: string[] = [];
      console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
      await main(RUN_ENV);
      expect(snapshot(root)).toEqual(first);
      expect(lines.join("\n")).toMatch(/2 unchanged, 0 kept, 0 skipped, 1 failed/);
      await expect(updateFund(FUND, quiet(), stats())).rejects.toThrow(/^holdings guard: no row has a numeric weight, the published sheet had 3; kept the previous complete data/);
    });
  });

  test("a closed fund is never fetched or reported failed: its files stay as published, its index row says closed, a rerun writes nothing", async () => {
    const entry = { ticker: "SPYI", closed: "2026-10-01", source: "https://www.sec.gov/Archives/edgar/data/1/notice.htm" };
    expect(() => closedFund([{ ...entry, closed: "soon" }], "SPYI")).toThrow("CLOSED_FUNDS");
    expect(closedFund([entry], "spyi")).toEqual(entry);
    await inTempRoot(async (root) => {
      mockFetch(site(RICH_PAGES));
      await main(RUN_ENV);
      const first = snapshot(root);
      // the guard would reject these holdings
      const renamed = HOLDINGS_CSV.replace("Weightings", "Weighting %");
      const good = site(RICH_PAGES);
      CLOSED_FUNDS.push(entry);
      try {
        const urls = mockFetch((url) => (url.includes("download_holdings_csv&ticker=SPYI") ? new Response(renamed) : good(url)));
        await main({ ...RUN_ENV, TICKERS: "SPYI" });
        expect(urls.filter((url) => /spyi/i.test(url))).toEqual([]);
        expect(process.exitCode).not.toBe(1);
        const closed = snapshot(root);
        for (const file of Object.keys(first)) if (file !== "index.json") expect([file, closed[file]]).toEqual([file, first[file]]);
        const funds = readJson(root, "index.json").funds;
        expect(funds.map((fund: { ticker: string }) => fund.ticker)).toEqual(["IWMI", "SPYI", "XSPI"]);
        expect(funds.find((fund: { ticker: string }) => fund.ticker === "SPYI")).toMatchObject({ status: "closed", closedDate: "2026-10-01", closedSource: entry.source, dataFile: "./funds/SPYI/meta.json" });
        expect(funds.filter((fund: { status?: string }) => fund.status === "closed")).toHaveLength(1);
        await main(RUN_ENV);
        expect(snapshot(root)).toEqual(closed);
        // the live lineup dropped the closed fund: TICKERS still accepts it, its row and files survive
        const dropped = LINEUP_HTML.replace(/<tr><td><span class="ticker ticker-equity-high-income">SPYI<\/span>.*\n/, "");
        mockFetch((url) => (url === "https://neosfunds.com/" ? new Response(dropped) : good(url)));
        await main({ ...RUN_ENV, TICKERS: "SPYI" });
        await main(RUN_ENV);
        expect(snapshot(root)).toEqual(closed);
      } finally {
        CLOSED_FUNDS.splice(CLOSED_FUNDS.indexOf(entry), 1);
      }
    });
  });

  test("SKIP_NEOS never reads neosfunds.com and keeps the published fund data; Yahoo down returns the previous row", async () => {
    await inTempRoot(async (root) => {
      const dir = seedFeed(root);
      const previous = { ticker: "SPYI", holdings: 1, history: 3, metrics: { tr1y: 14.62 } };
      // the fresh chart joins the published days (2026-09-18 overlaps), so the older published days stay behind it
      const joined = JSON.stringify({ chart: { result: [{ timestamp: [Date.UTC(2026, 8, 18) / 1000, Date.UTC(2026, 8, 19) / 1000], indicators: { quote: [{ close: [53.1, 54.3], volume: [5, 6] }], adjclose: [{ adjclose: [53.1, 54.3] }] }, meta: { exchangeName: "PCX" } }] } });
      const urls = mockFetch((url) => (url.includes("finance.yahoo.com") ? new Response(joined) : null));
      const entry = await refreshHistoryOnly(FUND, previous as any, { ...quiet(), skipNeos: true }, stats());
      expect(urls.every((url) => !url.includes("neosfunds.com"))).toBe(true);
      expect(entry.history).toBe(4);
      expect((entry.metrics as { tr1y: number }).tr1y).toBe(14.62);
      expect(readJson(dir, "meta.json").holdings.totalRows).toBe(1);
      mockFetch(() => null);
      expect(await refreshHistoryOnly(FUND, previous as any, { ...quiet(), skipNeos: true }, stats())).toBe(previous as any);
    });
  });

  test("EDGAR fallback: a fund without its CSV is rebuilt from its own series' N-PORT when strictly newer; another series' filing or a not newer report keeps the fund as published", async () => {
    const page = (url: string): Response | null => (url.includes("neosfunds.com/") && !url.includes("download_holdings_csv") ? new Response("<html></html>") : null);
    const world = (xml: string) => (url: string) => sec(xml)(url) ?? page(url);
    await inTempRoot(async (root) => {
      const dir = seedFeed(root, "Aug 31 2026");
      mockFetch(world(nportXml("S000077194", "2026-09-30", [NPORT_AAPL, NPORT_OPTION])));
      const entry = await updateFund(FUND, quiet(), stats());
      expect(entry!.holdings).toBe(2);
      expect(readJson(dir, "holdings", "001.json").rows.map((row: Record<string, string>) => [row.Ticker, row.Identifier, row.Weight])).toEqual([["AAPL", "037833100", "102.79%"], ["-", "SPY 261016C00680000", "-2.79%"]]);
      const meta = readJson(dir, "meta.json");
      expect([meta.holdings.asOf, meta.holdings.asOfDate, meta.holdings.source, meta.source.nportDoc]).toEqual(["2026-09-30", "Sep 30 2026", NPORT_DOC, NPORT_DOC]);
      // the same report period again is not newer than the published holdings: failed, nothing written
      const before = snapshot(root);
      await expect(updateFund(FUND, quiet(), stats())).rejects.toThrow(/not newer than the published holdings \(2026-09-30\); kept the previous complete data/);
      expect(snapshot(root)).toEqual(before);
      // IWMI: SEC's table names series S000085554, the trust's only filing is S000077194's
      await expect(updateFund({ ...FUND, ticker: "IWMI" }, quiet(), stats())).rejects.toThrow(/names series S000077194, not S000085554/);
    });
    await inTempRoot(async (root) => {
      // published from the issuer CSV of Sep 21: the N-PORT report of Aug 31 is older and never replaces it; a CSV sheet has no nportDoc
      const dir = seedFeed(root, "Sep 21 2026");
      resetSecState(); // a new run: the SEC tables and documents are read again
      mockFetch(world(nportXml("S000077194", "2026-08-31", [NPORT_AAPL])));
      await expect(updateFund(FUND, quiet(), stats())).rejects.toThrow(/not newer than the published holdings \(2026-09-21\)/);
      expect(readJson(dir, "holdings", "001.json").rows[0].Name).toBe("OLD");
      mockFetch(site(RICH_PAGES));
      await updateFund(FUND, quiet(), stats());
      expect(readJson(dir, "meta.json").source.nportDoc).toBeUndefined();
    });
  });
});

describe("pipeline 3", () => {
  test("an unknown ticker is an error, and when every fund fails the run fails", async () => {
    await inTempRoot(async () => {
      mockFetch((url) => (url === "https://neosfunds.com/" ? new Response(LINEUP_HTML) : null));
      await expect(main({ ...RUN_ENV, TICKERS: "NOPE" })).rejects.toThrow(/TICKERS: NOPE not in the NEOS lineup or published feed/);
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

describe("pipeline 4", () => {
  test("a HISTORY_RANGE run after a full run keeps the older history and writes nothing, also with SKIP_NEOS (Q25)", async () => {
    await inTempRoot(async (root) => {
      mockFetch(site(RICH_PAGES));
      await main(RUN_ENV);
      const index = readJson(root, "index.json");
      writeFileSync(path.join(root, "index.json"), JSON.stringify({ ...index, generatedAt: "2020-01-01T00:00:00Z" }, null, 2) + "\n");
      const first = snapshot(root);
      // a 1y window that holds only the newest day
      const chart = JSON.parse(CHART);
      const result = chart.chart.result[0];
      result.timestamp = result.timestamp.slice(-1);
      result.indicators.quote[0].close = result.indicators.quote[0].close.slice(-1);
      result.indicators.quote[0].volume = result.indicators.quote[0].volume.slice(-1);
      result.indicators.adjclose[0].adjclose = result.indicators.adjclose[0].adjclose.slice(-1);
      mockFetch(site(RICH_PAGES, JSON.stringify(chart)));
      await main({ ...RUN_ENV, HISTORY_RANGE: "1y" });
      expect(snapshot(root)).toEqual(first);
      await main({ ...RUN_ENV, HISTORY_RANGE: "1y", SKIP_NEOS: "true" });
      expect(snapshot(root)).toEqual(first);
      expect(readJson(root, "funds", "SPYI", "meta.json").history.totalRows).toBe(2);
      // a truncated `max` answer (Yahoo served 2 bars for some funds on 2026-10-29) never shrinks the history either:
      // one that joins the published days keeps them all, one that does not join keeps the fund as published
      await main({ ...RUN_ENV, SKIP_NEOS: "true" });
      expect(snapshot(root)).toEqual(first);
      result.timestamp = [result.timestamp[0] + 30 * 86_400];
      mockFetch(site(RICH_PAGES, JSON.stringify(chart)));
      await main({ ...RUN_ENV, SKIP_NEOS: "true" });
      expect(readJson(root, "funds", "SPYI", "meta.json").history.totalRows).toBe(2);
    });
  });

  test("a relaxed guard still keeps numeric published weights from an all-blank N-PORT sheet (Q24)", async () => {
    await inTempRoot(async (root) => {
      mockFetch(site(RICH_PAGES));
      await main(RUN_ENV);
      const first = snapshot(root);
      const good = site(RICH_PAGES);
      const blank = sec(nportXml("S000077194", "2026-09-30", [NPORT_AAPL, NPORT_OPTION].map((position) => position.replace(/<pctVal>[^<]*<\/pctVal>/, ""))));
      mockFetch((url) => (url.includes("download_holdings_csv&ticker=SPYI") ? null : blank(url) ?? good(url)));
      const lines: string[] = [];
      console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
      HOLDINGS_GUARD_RELAX.SPYI = ["numeric", "sum"];
      try {
        await expect(main({ ...RUN_ENV, TICKERS: "SPYI" })).rejects.toThrow("every fund failed (1 of 1)");
      } finally {
        delete HOLDINGS_GUARD_RELAX.SPYI;
      }
      expect(snapshot(root)).toEqual(first);
      expect(lines.join("\n")).toMatch(/no row has a numeric weight, the published sheet had 3/);
      expect(holdingsWeightCount(["Name", "Weight"], [["A", "-"], ["B", "2%"]])).toBe(1);
    });
  });

  test("TICKERS outside the live lineup stops the run before any fund request; a stale catalog-only row is dropped (Q27)", async () => {
    await inTempRoot(async (root) => {
      mockFetch(site(RICH_PAGES));
      await main(RUN_ENV);
      const index = readJson(root, "index.json");
      index.funds.push({ ticker: "NOPE", name: "Nope ETF", dataFile: null, holdings: 0, history: 0 });
      writeFileSync(path.join(root, "index.json"), JSON.stringify(index));
      const before = snapshot(root);
      const urls = mockFetch(site(RICH_PAGES));
      await expect(main({ ...RUN_ENV, TICKERS: "NOPE" })).rejects.toThrow("TICKERS: NOPE not in the NEOS lineup or published feed; nothing was fetched or written");
      expect(urls).toEqual(["https://neosfunds.com/"]);
      expect(snapshot(root)).toEqual(before);
      await main(RUN_ENV);
      expect(readJson(root, "index.json").funds.map((fund: { ticker: string }) => fund.ticker)).toEqual(["IWMI", "SPYI", "XSPI"]);
    });
  });

  test("NEW FUNDS announces a fund on its first successful publish, a failed new fund as not published yet (Q28)", async () => {
    await inTempRoot(async (root) => {
      const lineup = (tickers: string[]) => LINEUP_HTML.split("\n").filter((line) => !line.startsWith('<tr><td><span class="ticker') || tickers.some((ticker) => line.includes(`>${ticker}</span>`))).join("\n");
      const world = (tickers: string[], down: string[] = []) => {
        const base = site(RICH_PAGES);
        return (url: string): Response | null => (url === "https://neosfunds.com/" ? new Response(lineup(tickers)) : down.some((ticker) => url.includes(`/${ticker.toLowerCase()}/`)) ? null : base(url));
      };
      mockFetch(world(["SPYI"]));
      await main(RUN_ENV);
      const summary = path.join(root, "summary.md");
      process.env.GITHUB_STEP_SUMMARY = summary;
      const lines: string[] = [];
      console.log = (...args: unknown[]) => { const line = args.join(" "); if (/^NEW FUNDS/.test(line)) lines.push(line); };
      mockFetch(world(["SPYI", "XSPI", "IWMI"], ["IWMI"]));
      await main(RUN_ENV);
      expect(lines).toEqual(["NEW FUNDS: XSPI", "NEW FUNDS (not published yet): IWMI"]);
      expect(readFileSync(summary, "utf8")).toContain("### NEW FUNDS\n\nNEW FUNDS: XSPI\nNEW FUNDS (not published yet): IWMI\n");
      lines.length = 0;
      await main(RUN_ENV);
      expect(lines).toEqual([]);
      mockFetch(world(["SPYI", "XSPI", "IWMI"]));
      await main(RUN_ENV);
      expect(lines).toEqual(["NEW FUNDS: IWMI"]);
    });
  });
});

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
});

describe("network 2", () => {
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
