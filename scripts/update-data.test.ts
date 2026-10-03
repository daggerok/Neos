/**
 * Unit tests for the NEOS ETF data updater.
 *
 * Every HTML sample below is a faithful transcription of the markup
 * neosfunds.com actually serves (verified against the live pages and the daily
 * holdings CSV on 2026-09-21), trimmed to the parts that matter. The tests are
 * the guard for the two things the committed feed cannot show by itself: the
 * quirks of the provider markup (rows whose `</td>` is missing, the duplicated
 * `id="etf-table"`, the footnote markers on fee cells) and the row/header shape
 * contract every generated page file must keep.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  HOLDINGS_HEADERS,
  HISTORY_HEADERS,
  NEOS_ADMIN_AJAX_URL,
  NEOS_CATEGORIES,
  NEOS_DISTRIBUTION_HEADERS,
  NEOS_ETF_TRUST_CIK,
  NEOS_ETF_TRUST_FILE_NUMBER,
  NEOS_LINEUP_URL,
  NEOS_SITE,
  annualizedFromCumulative,
  cleanText,
  compareDisplayDates,
  cumulativeFromAnnualized,
  decodeHtmlEntities,
  elementTextById,
  formatAumDisplay,
  formatDistributionFrequency,
  formatMoneyText,
  formatNeosDate,
  formatPercentText,
  inferDistributionFrequency,
  isMissingCell,
  neosAssetCategory,
  neosEdgarFilingsUrl,
  neosFundPageUrl,
  neosHoldingsCsvUrl,
  neosProvenanceHoldingsUrl,
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
  performanceAsOf,
  RETURNS_BASIS,
  parseNportXml,
  parseRange,
  parseYahooChart,
  parseYahooExchangeName,
  paymentsPerYear,
  CONTROL_NAMES,
  installSystemCa,
  isCertError,
  readConfig,
  resolveControls,
  runtimeControls,
  sanitizeTicker,
  splitPages,
  splitRowCells,
  tableById,
  tableRowsByIdRaw,
  toIsoDate,
  yahooChartProvenanceUrl,
  yahooChartUrl,
} from "./update-data";

const REPO_ROOT = path.join(import.meta.dir, "..");
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), "utf8");
const file = () => JSON.parse(read("scripts/update-data.config.json"));

// ---------------------------------------------------------------------------
// 1. Source URLs
// ---------------------------------------------------------------------------

describe("source URLs", () => {
  test("the fund page is the lowercase ticker directory neosfunds.com serves", () => {
    expect(neosFundPageUrl("SPYI")).toBe("https://neosfunds.com/spyi/");
    expect(neosFundPageUrl(" qqqi ")).toBe("https://neosfunds.com/qqqi/");
    expect(NEOS_SITE).toBe("https://neosfunds.com");
    expect(NEOS_LINEUP_URL).toBe("https://neosfunds.com/#explore-etfs");
  });

  test("the holdings download is the admin-ajax action etf-pages.js calls", () => {
    expect(NEOS_ADMIN_AJAX_URL).toBe("https://neosfunds.com/wp-admin/admin-ajax.php");
    expect(neosHoldingsCsvUrl("SPYI")).toBe(
      "https://neosfunds.com/wp-admin/admin-ajax.php?action=download_holdings_csv&ticker=SPYI",
    );
    expect(neosProvenanceHoldingsUrl("cshi")).toContain("ticker=CSHI");
    // Only this one action exists on the site; every other action answers 400.
    expect(neosHoldingsCsvUrl("SPYI")).toContain("action=download_holdings_csv");
  });

  test("the EDGAR fallback targets the NEOS ETF Trust, not the adviser", () => {
    expect(neosEdgarFilingsUrl()).toContain(`CIK=${NEOS_ETF_TRUST_CIK}`);
    expect(neosEdgarFilingsUrl()).toContain("type=NPORT-P");
    expect(NEOS_ETF_TRUST_CIK).toBe("0001848758");
    expect(NEOS_ETF_TRUST_FILE_NUMBER).toBe("811-23645");
  });

  test("the Yahoo chart URL carries no wall-clock value in its provenance form", () => {
    const url = yahooChartProvenanceUrl("SPYI");
    expect(url).toBe(
      "https://query1.finance.yahoo.com/v8/finance/chart/SPYI" +
        "?period1=0&period2=9999999999&interval=1d&events=div%7Csplit&includeAdjustedClose=true",
    );
    // Deterministic: the same ticker always yields the same recorded URL.
    expect(yahooChartProvenanceUrl("SPYI")).toBe(yahooChartProvenanceUrl("spyi"));
  });

  test("the fetch URL is deterministic for a fixed clock and honours the range", () => {
    const fixed = 1_700_000_000_000;
    expect(yahooChartUrl("SPYI", "max", fixed)).toContain("period1=0&period2=1700000000");
    expect(yahooChartUrl("SPYI", "max", fixed)).not.toContain("&range=");
    // Yahoo ignores `range` when period1=0: the range must move period1 itself.
    const fiveYears = yahooChartUrl("SPYI", "5y", fixed);
    expect(fiveYears).not.toContain("&range=");
    expect(fiveYears).toContain(`period1=${Math.floor(1_700_000_000 - 5 * 365.25 * 86_400)}&period2=1700000000`);
    expect(() => yahooChartUrl("SPYI", "6mo", fixed)).toThrow(/expected max or Ny/);
  });
});

// ---------------------------------------------------------------------------
// 2. Normalization
// ---------------------------------------------------------------------------

describe("normalization", () => {
  test("sanitizeTicker strips whitespace and uppercases", () => {
    expect(sanitizeTicker(" spyi ")).toBe("SPYI");
    expect(sanitizeTicker("q-q-q-i")).toBe("QQQI");
    expect(sanitizeTicker(undefined)).toBe("");
  });

  test("cleanText drops the registered/trademark signs and collapses whitespace", () => {
    expect(cleanText("S&P 500\u00ae  High\nIncome ETF")).toBe("S&P 500 High Income ETF");
    expect(cleanText("Nasdaq-100\u2122 High Income ETF")).toBe("Nasdaq-100 High Income ETF");
    expect(cleanText(null)).toBe("");
  });

  test("normalizeNumberText strips currency, separators, percent and footnotes", () => {
    expect(normalizeNumberText("$12,151,808,030")).toBe("12151808030");
    expect(normalizeNumberText("12.15%")).toBe("12.15");
    expect(normalizeNumberText("0.68%*")).toBe("0.68");
    expect(normalizeNumberText("-0.05%")).toBe("-0.05");
    expect(normalizeNumberText("($0.10)")).toBe("-0.10");
    expect(normalizeNumberText("2.97E8")).toBe("297000000");
  });

  test("numberOrNull returns null for the placeholders the site prints, never NaN", () => {
    expect(numberOrNull("--")).toBeNull();
    expect(numberOrNull("\u2014")).toBeNull();
    expect(numberOrNull("N/A")).toBeNull();
    expect(numberOrNull("")).toBeNull();
    expect(numberOrNull("0")).toBe(0);
    expect(numberOrNull("$53.640")).toBe(53.64);
    expect(numberOrNull("-0.05%")).toBe(-0.05);
    expect(numberOrNull("$12,151,808,030")).toBe(12151808030);
    expect(numberOrNull(Number.NaN)).toBeNull();
  });

  test("isMissingCell keys on the normalized text so `0.00%` is a value", () => {
    expect(isMissingCell("--")).toBe(true);
    expect(isMissingCell("\u2014")).toBe(true);
    expect(isMissingCell("")).toBe(true);
    expect(isMissingCell("0.00%")).toBe(false);
    expect(isMissingCell(0)).toBe(false);
  });

  test("decodeHtmlEntities handles the entities the pages actually emit", () => {
    expect(decodeHtmlEntities("S&amp;P 500")).toBe("S&P 500");
    // The registered/trademark signs are dropped, never rendered as entities.
    expect(decodeHtmlEntities("Nasdaq-100&reg;")).toBe("Nasdaq-100");
    expect(decodeHtmlEntities("Russell 2000&#174;")).toBe("Russell 2000\u00ae");
  });
});

// ---------------------------------------------------------------------------
// 3. Dates
// ---------------------------------------------------------------------------

describe("dates", () => {
  test("toIsoDate accepts every form the site and the feed use", () => {
    expect(toIsoDate("08/29/2022")).toBe("2022-08-29");
    expect(toIsoDate("8/29/2022")).toBe("2022-08-29");
    expect(toIsoDate("2026-09-18")).toBe("2026-09-18");
    expect(toIsoDate("August 29, 2022")).toBe("2022-08-29");
    expect(toIsoDate("Aug 29 2022")).toBe("2022-08-29");
    expect(toIsoDate("")).toBe("");
  });

  test("formatNeosDate renders the display form the UI expects", () => {
    expect(formatNeosDate("08/29/2022")).toBe("Aug 29 2022");
    expect(formatNeosDate("2026-02-02")).toBe("Feb 02 2026");
    expect(formatNeosDate("")).toBe("");
  });

  test("compareDisplayDates orders the published display dates chronologically", () => {
    expect(compareDisplayDates("Aug 29 2022", "Sep 18 2026")).toBeLessThan(0);
    expect(compareDisplayDates("Sep 18 2026", "Aug 29 2022")).toBeGreaterThan(0);
    expect(compareDisplayDates("Feb 02 2026", "Feb 02 2026")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Formatters
// ---------------------------------------------------------------------------

describe("formatters", () => {
  test("formatAumDisplay uses the compact form the ETF Guide prints", () => {
    expect(formatAumDisplay(12_151_808_030)).toBe("$12.15B");
    expect(formatAumDisplay(1_864_838_475)).toBe("$1.86B");
    expect(formatAumDisplay(113_242_709)).toBe("$113.24M");
    expect(formatAumDisplay(4_634_398)).toBe("$4.63M");
  });

  test("percent and money text render an em dash for null, never a blank cell", () => {
    expect(formatPercentText(12.15)).toBe("12.15%");
    expect(formatPercentText(-0.05)).toBe("-0.05%");
    expect(formatPercentText(null)).toBe("\u2014");
    expect(formatMoneyText(53.64)).toBe("$53.64");
    expect(formatMoneyText(null)).toBe("\u2014");
  });
});

// ---------------------------------------------------------------------------
// 5. Range parsing and configuration
// ---------------------------------------------------------------------------

describe("range parsing", () => {
  test("parseRange requires the explicit min:max syntax", () => {
    expect(parseRange("", "TER")).toBeUndefined();
    expect(parseRange(":", "TER")).toBeUndefined();
    expect(parseRange("0:0.70", "TER")).toEqual({ min: 0, max: 0.7 });
    expect(parseRange("0.98:", "TER")).toEqual({ min: 0.98, max: Number.POSITIVE_INFINITY });
    expect(() => parseRange("1:2:3", "TER")).toThrow(/exactly one colon/);
    expect(() => parseRange("5:1", "TER")).toThrow(/greater than max/);
  });

  test("parseAumRange accepts the presets and dollar amounts with K/M/B/T", () => {
    expect(parseAumRange("micro")).toEqual({ min: 10_000_000, max: 300_000_000, source: "micro" });
    expect(parseAumRange("large")).toEqual({ min: 10_000_000_000, max: Infinity, source: "large" });
    expect(parseAumRange("nano")).toEqual({ min: 0, max: 10_000_000, source: "nano" });
    expect(parseAumRange("1B:")).toEqual({ min: 1_000_000_000, max: Infinity, source: "1B:" });
    expect(parseAumRange(":$300M")).toEqual({ min: -Infinity, max: 300_000_000, source: ":$300M" });
    expect(parseAumRange(":")).toBeUndefined();
    expect(() => parseAumRange("nonsense:")).toThrow(/not an amount/);
  });
});

describe("readConfig", () => {
  test("defaults match the documented USAGE block", () => {
    const config = readConfig({});
    expect(config.concurrency).toBe(2);
    expect(config.requestSleep).toBe(1.5);
    expect(config.maxFetches).toBe(0);
    expect(config.holdingsPageSize).toBe(250);
    expect(config.historyPageSize).toBe(1000);
    expect(config.maxRetries).toBe(3);
    expect(config.historyRange).toBe("max");
    expect(config.tickers).toEqual([]);
    expect(config.skipYahoo).toBe(false);
    expect(config.skipNeos).toBe(false);
    expect(config.edgarFallback).toBe(true);
    expect(config.secUa).toBe("daggerok ETF feed daggerok@gmail.com");
  });

  test("a comma/space separated TICKERS list is normalized and ANDed", () => {
    const config = readConfig({ TICKERS: "spyi, qqqi  cshi" });
    expect(config.tickers).toEqual(["SPYI", "QQQI", "CSHI"]);
  });

  test("filters and page sizes come from the environment", () => {
    const config = readConfig({
      AUM: "1B:",
      TER: ":0.98",
      DIVIDEND_YIELD: "10:",
      SEC_YIELD: ":5",
      PERFORMANCE_3Y: "10:",
      TOTAL_RETURN_1Y: "0:",
      HOLDINGS_PAGE_SIZE: "100",
      HISTORICAL_PAGE_SIZE: "500",
      STORE_RAW_DOWNLOADS: "yes",
      SKIP_YAHOO: "1",
      EDGAR_FALLBACK: "1",
      HISTORY_RANGE: "10y",
      CATEGORY: "Fixed Income",
    });
    expect(config.aumRange).toEqual({ min: 1_000_000_000, max: Infinity, source: "1B:" });
    expect(config.terRange).toEqual({ min: -Infinity, max: 0.98 });
    expect(config.dividendYieldRange).toEqual({ min: 10, max: Infinity });
    expect(config.secYieldRange).toEqual({ min: -Infinity, max: 5 });
    expect(config.performanceRanges["3Y"]).toEqual({ min: 10, max: Infinity });
    expect(config.totalReturnRanges["1Y"]).toEqual({ min: 0, max: Infinity });
    expect(config.holdingsPageSize).toBe(100);
    expect(config.historyPageSize).toBe(500);
    expect(config.storeRawDownloads).toBe(true);
    expect(config.skipYahoo).toBe(true);
    expect(config.edgarFallback).toBe(true);
    expect(config.historyRange).toBe("10y");
    expect(config.category).toBe("Fixed Income");
  });
});

// ---------------------------------------------------------------------------
// 6. HTML extraction — including the provider's missing `</td>`
// ---------------------------------------------------------------------------

describe("HTML table extraction", () => {
  const HTML = `
    <table class="table" id="etf-table"><tr><th>Ticker</th><th>Fund Name</th></tr>
      <tr><td>SPYI</td><td>S&amp;P 500 High Income ETF</td></tr></table>
    <table class="table fund-details-font"><tr><td>Fund Inception</td><td>8/29/2022
      </tr><tr><td>CUSIP</td><td>78433H303</td></tr></table>`;

  test("splitRowCells keeps every value when a closing tag is missing", () => {
    // The live lineup ships exactly this: three cells, only the last one closed.
    const row = `<td>16.78%                                <td>0.18%                                <td>0.98%</td>`;
    expect(splitRowCells(row)).toEqual(["16.78%", "0.18%", "0.98%"]);
  });

  test("splitRowCells strips inner markup and reads th cells too", () => {
    const row = `<th>Distribution Rate<span class="sort-caret"><i class="zmdi"></i></span></th><td>12.15%</td>`;
    expect(splitRowCells(row)).toEqual(["Distribution Rate", "12.15%"]);
  });

  test("parseHtmlTables returns every table's rows in document order", () => {
    const tables = parseHtmlTables(HTML);
    expect(tables.length).toBe(2);
    expect(tables[0][0]).toEqual(["Ticker", "Fund Name"]);
    expect(tables[1][1]).toEqual(["CUSIP", "78433H303"]);
  });

  test("tableById reads the id-carrying table and tableRowsByIdRaw keeps its markup", () => {
    const table = tableById(HTML, "etf-table");
    expect(table).not.toBeNull();
    expect(table![1]).toEqual(["SPYI", "S&P 500 High Income ETF"]);
    expect(tableRowsByIdRaw(HTML, "etf-table")[1]).toContain("SPYI");
    // Both `#explore-etfs` tabs carry `id="etf-table"`; the reader takes the first.
    expect(tableById(HTML, "no-such-id")).toBeNull();
  });

  test("elementTextById reads an element's text", () => {
    expect(elementTextById(`<div id="as-of">As of 09/18/2026</div>`, "as-of")).toBe("As of 09/18/2026");
    expect(elementTextById(HTML, "as-of")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. The lineup table — the catalog
// ---------------------------------------------------------------------------

// Trimmed from the server-rendered `#explore-etfs` table: the header row, a
// plain equity row, the XSPI row whose `</td>` are missing, and the IWMI row
// whose fee cell carries a footnote marker.
const LINEUP_HTML = `
<div id="explore-etfs">
  <div id="fund-overview" class="col-md-12 etf-tab-content etf-tab-active">
    <div class="table-responsive">
      <table class="table" id="etf-table">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Fund Name</th>
            <th>Distribution Frequency</th>
            <th data-sort-col="distribution-rate" class="sortable">Distribution Rate<span class="sort-caret"><i class="zmdi zmdi-triangle-down"></i></span></th>
            <th data-sort-col="sec-yield" class="sortable">30-Day SEC Yield<span class="sort-caret"><i class="zmdi zmdi-triangle-down"></i></span></th>
            <th data-sort-col="expense-ratio" class="sortable">Management Fee<span class="sort-caret"><i class="zmdi zmdi-triangle-down"></i></span></th>
            <th data-sort-col="net-assets" class="sortable">Net Assets<span class="sort-caret"><i class="zmdi zmdi-triangle-down"></i></span></th>
            <th data-sort-col="inception-date" class="sortable">Inception Date<span class="sort-caret"><i class="zmdi zmdi-triangle-down"></i></span></th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><span class="ticker ticker-equity-high-income">SPYI</span></td>
            <td><a href="https://neosfunds.com/spyi/">S&amp;P 500<sup>&reg;</sup> High Income ETF</a></td>
            <td>Monthly</td>
            <td>12.15%                                </td>
            <td>0.46%                                </td>
            <td>0.68%</td>
            <td>$12,151,808,030</td>
            <td>08/29/2022</td>
          </tr>
          <tr>
            <td><span class="ticker ticker-enhanced-fixed-income">XSPI</span></td>
            <td><a href="https://neosfunds.com/xspi/">Boosted S&amp;P 500<sup>&reg;</sup> High Income ETF</a></td>
            <td>Monthly</td>
            <td>16.78%                                <td>0.18%                                <td>0.98%</td>
            <td>$113,242,709</td>
            <td>02/02/2026</td>
          </tr>
          <tr>
            <td><span class="ticker ticker-equity-high-income">IWMI</span></td>
            <td><a href="https://neosfunds.com/iwmi/">Russell 2000<sup>&reg;</sup> High Income ETF</a></td>
            <td>Monthly</td>
            <td>14.51%                                </td>
            <td>0.52%                                </td>
            <td>0.68%*</td>
            <td>$1,279,666,480</td>
            <td>06/24/2024</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</div>`;

describe("parseNeosLineup", () => {
  const funds = parseNeosLineup(LINEUP_HTML);
  const byTicker = Object.fromEntries(funds.map((fund) => [fund.ticker, fund]));

  test("the header row is not a fund", () => {
    expect(funds.map((fund) => fund.ticker)).toEqual(["SPYI", "XSPI", "IWMI"]);
  });

  test("a row whose `</td>` are missing still yields all eight columns", () => {
    const xspi = byTicker["XSPI"];
    expect(xspi.categoryClass).toBe("ticker-enhanced-fixed-income");
    expect(xspi.distributionRate).toBe(16.78);
    expect(xspi.secYield).toBe(0.18);
    expect(xspi.managementFee).toBe(0.98);
    expect(xspi.netAssets).toBe(113_242_709);
    expect(xspi.inceptionDate).toBe("2026-02-02");
    // `ticker-enhanced-fixed-income` is the site's class for the Boosted group.
    expect(xspi.category).toBe("Boosted High Income");
  });

  test("the ticker class maps to the asset-class group, and the fund name is decoded", () => {
    expect(byTicker["SPYI"].category).toBe("Equity High Income");
    expect(byTicker["SPYI"].name).toBe("S&P 500 High Income ETF");
    expect(byTicker["SPYI"].fundPage).toBe("https://neosfunds.com/spyi/");
  });

  test("a footnote marker on a figure is not part of the figure", () => {
    expect(byTicker["IWMI"].managementFee).toBe(0.68);
    expect(byTicker["IWMI"].managementFeeText).toBe("0.68%");
  });

  test("the five groups the website prints are the five the parser knows", () => {
    expect([...NEOS_CATEGORIES]).toEqual([
      "Equity High Income",
      "Boosted High Income",
      "High Income Alternatives",
      "Hedged Equity Income",
      "Enhanced Fixed Income",
    ]);
  });
});

describe("parseNeosCategoryCards", () => {
  test("a category heading claims the tickers of the cards under it", () => {
    const html = `
      <h3>Equity High Income</h3>
      <a href="https://neosfunds.com/spyi/">S&P 500 High Income ETF</a>
      <a href="https://neosfunds.com/qqqi/">Nasdaq-100 High Income ETF</a>
      <h3>High Income Alternatives</h3>
      <a href="https://neosfunds.com/btci/">Bitcoin High Income ETF</a>`;
    const mapping = parseNeosCategoryCards(html);
    expect(mapping.get("SPYI")).toBe("Equity High Income");
    expect(mapping.get("QQQI")).toBe("Equity High Income");
    expect(mapping.get("BTCI")).toBe("High Income Alternatives");
  });
});

// ---------------------------------------------------------------------------
// 8. Fund Details
// ---------------------------------------------------------------------------

// Trimmed from https://neosfunds.com/spyi/. The first row is the one that ships
// no `</td>`; NAV and Market Price are duplicated label/value pairs, so the
// order inside the panel is what keeps them apart.
const FUND_DETAILS_HTML = `
<h2 class="color-primary right-line">Fund Details</h2>
<div class="table-responsive">
  <table class="table fund-details-font">
    <thead>
      <tr>
        <th class="fund-details-table-sizing-th">Fund Details</th>
        <th class="text-right fund-details-table-sizing-th">As of: 09/18/2026</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="fund-details-table-sizing">Fund Inception</td>
        <td class="fund-details-table-sizing" style="text-align: right;">8/29/2022
      </tr>
      <tr>
        <td class="fund-details-table-sizing">Fund Ticker</td>
        <td class="fund-details-table-sizing" style="text-align: right;">SPYI</td>
      </tr>
      <tr>
        <td class="fund-details-table-sizing">CUSIP</td>
        <td class="fund-details-table-sizing" style="text-align: right;">
          78433H303                            </td>
      </tr>
      <tr>
        <td class="fund-details-table-sizing">ISIN</td>
        <td class="fund-details-table-sizing" style="text-align: right;">US78433H3030</td>
      </tr>
      <tr>
        <td class="fund-details-table-sizing">Management Fee</td>
        <td class="fund-details-table-sizing" style="text-align: right;">0.68%</td>
      </tr>
      <tr>
        <td class="fund-details-table-sizing">Total Annual Fund Operating Expenses</td>
        <td class="fund-details-table-sizing" style="text-align: right;">0.68%</td>
      </tr>
      <tr>
        <td class="fund-details-table-sizing">Net Assets</td>
        <td class="fund-details-table-sizing" style="text-align: right;">$12,151,808,030</td>
      </tr>
      <tr>
        <td class="fund-details-table-sizing">Shares Outstanding</td>
        <td class="fund-details-table-sizing" style="text-align: right;">228,840,000</td>
      </tr>
      <tr>
        <td class="fund-details-table-sizing">Primary Exchange</td>
        <td class="fund-details-table-sizing" style="text-align: right;">CBOE</td>
      </tr>
      <tr>
        <td class="fund-details-table-sizing">Underlying Exposure</td>
        <td class="fund-details-table-sizing" style="text-align: right;">S&amp;P 500 Index</td>
      </tr>
      <tr>
        <td class="fund-details-table-sizing">Distribution Frequency</td>
        <td class="fund-details-table-sizing" style="text-align: right;">Monthly</td>
      </tr>
    </tbody>
  </table>
</div>
<div class="col-md-6">
  <table style="border-bottom: 3px solid #b4b4b4;" class="table fund-details-font">
    <thead><tr><th class="th-dark-blue-style">Closing NAV Price</th><th class="th-dark-blue-style"><span class="neos-sr-only">Spacer column</span></th></tr></thead>
    <tbody>
      <tr><td class="bg-f7f7f7">Net Asset Value</td><td class="bg-f7f7f7 text-right"> $53.640
        </td></tr>
      <tr><td class="bg-f7f7f7">Daily Change ($)</td><td class="bg-f7f7f7 text-right">$0.10</td></tr>
      <tr><td class="bg-f7f7f7">Daily Change (%)</td><td class="bg-f7f7f7 text-right">0.19%</td></tr>
    </tbody>
  </table>
</div>
<div class="col-md-6">
  <table style="border-bottom: 3px solid #b4b4b4;" class="table fund-details-font">
    <thead><tr><th class="th-dark-blue-style">Closing Market Price</th><th class="th-dark-blue-style"><span class="neos-sr-only">Spacer column</span></th></tr></thead>
    <tbody>
      <tr><td class="bg-f7f7f7">Market Price</td><td class="bg-f7f7f7 text-right">$53.65</td></tr>
      <tr><td class="bg-f7f7f7">Daily Change ($)</td><td class="bg-f7f7f7 text-right">$0.09</td></tr>
      <tr><td class="bg-f7f7f7">Daily Change (%)</td><td class="bg-f7f7f7 text-right">0.17%</td></tr>
    </tbody>
  </table>
</div>`;

describe("parseNeosFundDetails", () => {
  const details = parseNeosFundDetails(FUND_DETAILS_HTML);

  test("identifiers and the as-of date come from the panel", () => {
    expect(details.ticker).toBe("SPYI");
    expect(details.cusip).toBe("78433H303");
    expect(details.isin).toBe("US78433H3030");
    expect(details.inceptionDate).toBe("2022-08-29");
    expect(details.asOfDate).toBe("2026-09-18");
  });

  test("assets, share count, exchange and underlying exposure are read", () => {
    expect(details.netAssets).toBe(12_151_808_030);
    expect(details.netAssetsText).toBe("$12,151,808,030");
    expect(details.sharesOutstanding).toBe(228_840_000);
    expect(details.sharesOutstandingText).toBe("228,840,000");
    expect(details.primaryExchange).toBe("CBOE");
    expect(details.underlyingExposure).toBe("S&P 500 Index");
    expect(details.distributionFrequency).toBe("Monthly");
  });

  test("the two Daily Change pairs stay with their own quote", () => {
    expect(details.netAssetValue).toBe(53.64);
    expect(details.navDailyChangeValue).toBe(0.1);
    expect(details.navDailyChangePercent).toBe(0.19);
    expect(details.marketPrice).toBe(53.65);
    expect(details.marketPriceDailyChangeValue).toBe(0.09);
    expect(details.marketPriceDailyChangePercent).toBe(0.17);
  });

  test("fees keep their published display text", () => {
    expect(details.managementFeeText).toBe("0.68%");
    expect(details.totalOperatingExpensesText).toBe("0.68%");
  });

  // The panel of the hedged/alternatives funds ships the `Primary Exchange` row
  // without its opening `<tr>`, and their quote tables publish the official
  // premium/discount instead of an index row.
  const ORPHAN_ROW_HTML = `
    <h2>Fund Details</h2>
    <table class="table fund-details-font">
      <thead><tr><th class="fund-details-table-sizing-th">Fund Details</th><th class="text-right fund-details-table-sizing-th">As of: 09/18/2026</th></tr></thead>
      <tbody>
        <tr>
          <td class="fund-details-table-sizing">Shares Outstanding</td>
          <td class="fund-details-table-sizing" style="text-align: right;"> 6,924,981                            </td>
        </tr>
        <td class="fund-details-table-sizing">Primary Exchange</td> <td class="fund-details-table-sizing" style="text-align: right;">NASDAQ</td>
        <tr>
          <td class="fund-details-table-sizing">Distribution Frequency</td>
          <td class="fund-details-table-sizing" style="text-align: right;">Monthly</td>
        </tr>
      </tbody>
    </table>
    <table class="table fund-details-font">
      <thead><tr><th class="th-dark-blue-style">Premium / Discount</th><th class="th-dark-blue-style"><span class="neos-sr-only">Spacer column</span></th></tr></thead>
      <tbody>
        <tr><td class="bg-f7f7f7">Premium Discount (%)</td><td class="bg-f7f7f7 text-right">-0.15%</td></tr>
        <tr><td class="bg-f7f7f7">30-Day Median Bid-Ask Spread (%)</td><td class="bg-f7f7f7 text-right">0.29%</td></tr>
      </tbody>
    </table>`;

  test("a row that lost its `<tr>` still pairs its label with its value", () => {
    const orphaned = parseNeosFundDetails(ORPHAN_ROW_HTML);
    expect(orphaned.primaryExchange).toBe("NASDAQ");
    expect(orphaned.sharesOutstanding).toBe(6_924_981);
    expect(orphaned.distributionFrequency).toBe("Monthly");
  });

  test("the panel's own premium/discount and bid-ask spread are read, not derived", () => {
    const orphaned = parseNeosFundDetails(ORPHAN_ROW_HTML);
    expect(orphaned.premiumDiscount).toBe(-0.15);
    expect(orphaned.premiumDiscountText).toBe("-0.15%");
    expect(orphaned.bidAskSpread).toBe(0.29);
    expect(orphaned.bidAskSpreadText).toBe("0.29%");
  });
});

// ---------------------------------------------------------------------------
// 9. Distribution Information and history
// ---------------------------------------------------------------------------

// Trimmed from the `Distributions` block of https://neosfunds.com/spyi/.
const DISTRIBUTION_INFO_HTML = `
<div class="row mb-4">
  <table style="border-bottom: 3px solid #b4b4b4;" class="table fund-details-font">
    <thead>
      <tr>
        <th class="dist-info-line-height-th">Distribution Information <br>(as of 08/31/2026)</th>
        <th><span class="neos-sr-only">Spacer column</span></th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="bg-f7f7f7 dist-info-line-height">Distribution Frequency</td>
        <td class="bg-f7f7f7 text-right dist-info-line-height">Monthly </td>
      </tr>
      <tr>
        <td class="bg-f7f7f7 dist-info-line-height" data-container="body" title="Distribution Rate">Distribution Rate <img src="/wp-content/uploads/info-2.svg"></td>
        <td class="bg-f7f7f7 text-right dist-info-line-height">12.15%</td>
      </tr>
      <tr>
        <td class="bg-f7f7f7 dist-info-line-height" data-container="body" title="12-Month Trailing Distribution Rate">12-Month Trailing Distribution Rate <img src="/wp-content/uploads/info-2.svg"></td>
        <td class="bg-f7f7f7 text-right dist-info-line-height">11.82%</td>
      </tr>
      <tr>
        <td class="bg-f7f7f7 dist-info-line-height">Distribution Amount / Share ($)</td>
        <td class="bg-f7f7f7 text-right dist-info-line-height">$0.5423</td>
      </tr>
      <tr>
        <td class="bg-f7f7f7 dist-info-line-height">Distribution Amount / Share (%)</td>
        <td class="bg-f7f7f7 text-right dist-info-line-height">1.01%</td>
      </tr>
      <tr>
        <td class="bg-f7f7f7 dist-info-line-height">30-Day SEC Yield</td>
        <td class="bg-f7f7f7 text-right dist-info-line-height">0.46%</td>
      </tr>
    </tbody>
  </table>
</div>`;

describe("parseNeosDistributionInfo", () => {
  const info = parseNeosDistributionInfo(DISTRIBUTION_INFO_HTML)!;

  test("the block is found by its own heading and carries its as-of date", () => {
    expect(info).not.toBeNull();
    expect(info.asOfDate).toBe("2026-08-31");
    expect(info.frequency).toBe("Monthly");
  });

  test("the rates are read as numbers as well as display text", () => {
    expect(info.distributionRate).toBe(12.15);
    expect(info.distributionRateText).toBe("12.15%");
    expect(info.trailingRate12M).toBe(11.82);
    expect(info.trailingRate12MText).toBe("11.82%");
    expect(info.secYield).toBe(0.46);
    expect(info.secYieldText).toBe("0.46%");
  });

  test("the latest distribution amount is read in both money and percent form", () => {
    expect(info.distributionAmount).toBe(0.5423);
    expect(info.distributionAmountText).toBe("$0.5423");
    expect(info.distributionAmountPercent).toBe(1.01);
    expect(info.distributionAmountPercentText).toBe("1.01%");
  });

  test("a fund with no Distribution Information block yields null", () => {
    expect(parseNeosDistributionInfo("<div>nothing here</div>")).toBeNull();
  });
});

// Trimmed from the year-tabbed calendar: a closed year, a year whose final
// months are declared but not yet paid, and the year the fund launched in.
const DISTRIBUTION_HISTORY_HTML = `
<div class="distributions-tabs">
  <div id="tab-distribution-history">
    <div class="dc-year-table" id="dc-year-2022">
      <div class="table-responsive">
        <table class="table fund-details-font dc-table">
          <thead><tr><th>Declaration Date</th><th>Ex-Div Date</th><th>Record Date</th><th>Payable Date</th><th>Amount ($)</th></tr></thead>
          <tbody>
            <tr><td class="bg-f7f7f7">09/20/2022</td><td class="bg-f7f7f7">09/21/2022</td><td class="bg-f7f7f7">09/22/2022</td><td class="bg-f7f7f7">09/23/2022</td><td class="bg-f7f7f7">$0.4853</td></tr>
            <tr><td class="bg-f7f7f7">12/22/2022</td><td class="bg-f7f7f7">12/23/2022</td><td class="bg-f7f7f7">12/27/2022</td><td class="bg-f7f7f7">12/28/2022</td><td class="bg-f7f7f7">$0.4615</td></tr>
          </tbody>
        </table>
      </div>
    </div>
    <div class="dc-year-table" id="dc-year-2026">
      <div class="table-responsive">
        <table class="table fund-details-font dc-table">
          <thead><tr><th>Declaration Date</th><th>Ex-Div Date</th><th>Record Date</th><th>Payable Date</th><th>Amount ($)</th></tr></thead>
          <tbody>
            <tr><td class="bg-f7f7f7">01/20/2026</td><td class="bg-f7f7f7">01/21/2026</td><td class="bg-f7f7f7">01/21/2026</td><td class="bg-f7f7f7">01/23/2026</td><td class="bg-f7f7f7">$0.5309</td></tr>
            <tr><td class="bg-f7f7f7">08/18/2026</td><td class="bg-f7f7f7">08/19/2026</td><td class="bg-f7f7f7">08/20/2026</td><td class="bg-f7f7f7">08/25/2026</td><td class="bg-f7f7f7">$0.5423</td></tr>
            <tr><td class="bg-f7f7f7">12/15/2026</td><td class="bg-f7f7f7">12/16/2026</td><td class="bg-f7f7f7">12/16/2026</td><td class="bg-f7f7f7">12/18/2026</td><td class="bg-f7f7f7"></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</div>`;

describe("parseNeosDistributionHistory", () => {
  const rows = parseNeosDistributionHistory(DISTRIBUTION_HISTORY_HTML);

  test("the calendar is published newest first, whatever order the years are in", () => {
    expect(rows.map((row) => row["Declaration Date"])).toEqual([
      "12/15/2026",
      "08/18/2026",
      "01/20/2026",
      "12/22/2022",
      "09/20/2022",
    ]);
  });

  test("the header row of each year block is not a payout", () => {
    expect(rows.every((row) => /^\d{2}\/\d{2}\/\d{4}$/.test(row["Declaration Date"]))).toBe(true);
    expect(rows.length).toBe(5);
  });

  test("every row carries exactly the published headers", () => {
    for (const row of rows) {
      expect(Object.keys(row)).toEqual([...NEOS_DISTRIBUTION_HEADERS]);
    }
  });

  test("a declared but unpaid month keeps its empty Amount cell verbatim", () => {
    expect(rows[0]["Amount ($)"]).toBe("");
    expect(rows[1]["Amount ($)"]).toBe("$0.5423");
  });
});

// ---------------------------------------------------------------------------
// 10. Performance tables and the growth-of-$10,000 series
// ---------------------------------------------------------------------------

const MONTHLY_PERFORMANCE_HTML = `
<div id="monthly-performance">
  <p class="performance-as-of-date color-primary">Data as of: 08/31/2026</p>
  <div class="table-responsive">
    <table style="border-bottom: 3px solid #b4b4b4;" class="table fund-details-font">
      <thead>
        <tr>
          <th class="th-dark-blue-style"><span class="neos-sr-only">Spacer column</span></th>
          <th class="th-dark-blue-style">1 Mo</th>
          <th class="th-dark-blue-style">3 Mo</th>
          <th class="th-dark-blue-style">6 Mo</th>
          <th class="th-dark-blue-style">YTD</th>
          <th class="th-dark-blue-style">Inception<br><span style="font-size: 16px;">(Cumulative)</span></th>
          <th class="th-dark-blue-style">1 Yr</th>
          <th class="th-dark-blue-style">3 Yr</th>
          <th class="th-dark-blue-style">5 Yr</th>
          <th class="th-dark-blue-style">10 Yr</th>
          <th class="th-dark-blue-style">Inception<br><span style="font-size: 16px;">(Annualized)</span></th>
        </tr>
        <tr>
          <th class="th-dark-blue-style"><span class="neos-sr-only">Spacer column</span></th>
          <th class="th-dark-blue-style">Cumulative</th>
          <th class="th-dark-blue-style">Cumulative</th>
          <th class="th-dark-blue-style">Cumulative</th>
          <th class="th-dark-blue-style">Cumulative</th>
          <th class="th-dark-blue-style">Cumulative</th>
          <th class="th-dark-blue-style">Annualized</th>
          <th class="th-dark-blue-style">Annualized</th>
          <th class="th-dark-blue-style">Annualized</th>
          <th class="th-dark-blue-style">Annualized</th>
          <th class="th-dark-blue-style">Annualized</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="bg-f7f7f7">NAV Performance</td>
          <td class="bg-f7f7f7 text-center">2.47%</td>
          <td class="bg-f7f7f7 text-center">2.55%</td>
          <td class="bg-f7f7f7 text-center">9.33%</td>
          <td class="bg-f7f7f7 text-center">10.72%</td>
          <td class="bg-f7f7f7 text-center">75.14%</td>
          <td class="bg-f7f7f7 text-center">17.65%</td>
          <td class="bg-f7f7f7 text-center">16.04%</td>
          <td class="bg-f7f7f7 text-center"><span class="first-two">--</span>%</td>
          <td class="bg-f7f7f7 text-center"><span class="first-two">--</span>%</td>
          <td class="bg-f7f7f7 text-center">15.02%</td>
        </tr>
        <tr>
          <td class="bg-f7f7f7">Market Performance</td>
          <td class="bg-f7f7f7 text-center">2.52%</td>
          <td class="bg-f7f7f7 text-center">2.60%</td>
          <td class="bg-f7f7f7 text-center">9.41%</td>
          <td class="bg-f7f7f7 text-center">10.68%</td>
          <td class="bg-f7f7f7 text-center">75.12%</td>
          <td class="bg-f7f7f7 text-center">17.63%</td>
          <td class="bg-f7f7f7 text-center">16.02%</td>
          <td class="bg-f7f7f7 text-center"><span class="first-two">--</span>%</td>
          <td class="bg-f7f7f7 text-center"><span class="first-two">--</span>%</td>
          <td class="bg-f7f7f7 text-center">15.01%</td>
        </tr>
        <tr>
          <td class="bg-f7f7f7 text-left">Cboe S&amp;P 500 BuyWrite Monthly Index</td>
          <td class="bg-f7f7f7 text-center">1.60%</td>
          <td class="bg-f7f7f7 text-center">4.76%</td>
          <td class="bg-f7f7f7 text-center">7.79%</td>
          <td class="bg-f7f7f7 text-center">10.01%</td>
          <td class="bg-f7f7f7 text-center">57.92%</td>
          <td class="bg-f7f7f7 text-center">19.31%</td>
          <td class="bg-f7f7f7 text-center">13.43%</td>
          <td class="bg-f7f7f7 text-center"><span class="first-two">--</span>%</td>
          <td class="bg-f7f7f7 text-center"><span class="first-two">--</span>%</td>
          <td class="bg-f7f7f7 text-center">12.08%</td>
        </tr>
      </tbody>
    </table>
  </div>
</div>`;

describe("parseNeosPerformanceSection", () => {
  const monthly = parseNeosPerformanceSection(MONTHLY_PERFORMANCE_HTML, "monthly-performance")!;

  test("the as-of date is the table's own, not the page's", () => {
    expect(monthly.asOfDate).toBe("2026-08-31");
  });

  test("NAV, market and the first benchmark row are kept apart", () => {
    expect(monthly.nav.mo1).toBe(2.47);
    expect(monthly.nav.ytd).toBe(10.72);
    expect(monthly.nav.sinceInceptionCumulative).toBe(75.14);
    expect(monthly.nav.yr3).toBe(16.04);
    expect(monthly.nav.sinceInception).toBe(15.02);
    expect(monthly.market.mo1).toBe(2.52);
    expect(monthly.benchmarkName).toBe("Cboe S&P 500 BuyWrite Monthly Index");
    expect(monthly.benchmark.mo1).toBe(1.6);
  });

  test("a `--%` cell is null, so the app renders an em dash rather than a fake zero", () => {
    expect(monthly.nav.yr5).toBeNull();
    expect(monthly.nav.yr10).toBeNull();
  });

  test("the Cumulative/Annualized grouping row is not mistaken for a benchmark", () => {
    expect(monthly.benchmarkName).not.toBe("Annualized");
    expect(monthly.benchmarkName).not.toBe("Cumulative");
  });

  test("a section the page does not carry yields null", () => {
    expect(parseNeosPerformanceSection(MONTHLY_PERFORMANCE_HTML, "quarterly-performance")).toBeNull();
  });
});

const NAV_INDEX_HTML = `
<h2 class="color-primary right-line">Growth of $10,000 at NAV Since Inception</h2>
<canvas id="navIndexChart"></canvas>
<script>
document.addEventListener("DOMContentLoaded", function() {
const dates = ["2022-08-29","2022-08-30","2022-09-01"];
const navValues = ["10000","9893","9819"];
const indexValues2 = ["10000","10100","10150"];
const ctx = document.getElementById('navIndexChart');
});
</script>`;

describe("returnsBasis and performanceAsOf", () => {
  test("performanceAsOf is the Performance table date as ISO, null when unknown", () => {
    const monthly = parseNeosPerformanceSection(MONTHLY_PERFORMANCE_HTML, "monthly-performance")!;
    expect(performanceAsOf(monthly.asOfDate)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(performanceAsOf("Aug 31 2026")).toBe("2026-08-31");
    expect(performanceAsOf("")).toBeNull();
    expect(performanceAsOf(undefined)).toBeNull();
  });

  test("returnsBasis is a non-empty honest label", () => {
    expect(RETURNS_BASIS.trim()).not.toBe("");
    expect(RETURNS_BASIS).not.toBe("-");
    expect(RETURNS_BASIS).toContain("official NEOS");
  });
});

describe("parseNeosNavIndex", () => {
  test("the inline series behind the growth chart is read as numbers", () => {
    const series = parseNeosNavIndex(NAV_INDEX_HTML)!;
    expect(series.startDate).toBe("2022-08-29");
    expect(series.endDate).toBe("2022-09-01");
    expect(series.points).toBe(3);
    expect(series.values[0]).toBe(10000);
    expect(series.values[2]).toBe(9819);
    expect(series.benchmarkValues[2]).toBe(10150);
  });

  test("a page with no growth series yields null", () => {
    expect(parseNeosNavIndex("<html></html>")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 11. Documents
// ---------------------------------------------------------------------------

const DOCUMENTS_HTML = `
<div class="table-responsive">
  <table class="table fund-details-font">
    <thead><tr><th>Documents</th><th><span class="neos-sr-only">Spacer column</span></th></tr></thead>
    <tbody>
      <tr><td>Prospectus</td><td><a href="https://neosfunds.com/wp-content/uploads/SPYI-Prospectus.pdf">PDF</a></td></tr>
      <tr><td>Summary Prospectus</td><td><a href="https://neosfunds.com/wp-content/uploads/SPYI-Summary-Prospectus.pdf">PDF</a></td></tr>
      <tr><td>Statement of Additional Information</td><td><a href="https://neosfunds.com/wp-content/uploads/neos_sai-042926.pdf">PDF</a></td></tr>
      <tr><td>Annual Report</td><td><a href="https://neosfunds.com/wp-content/uploads/SPYI-Annual-Report.pdf">PDF</a></td></tr>
      <tr><td>Semi-Annual Report</td><td><a href="https://neosfunds.com/wp-content/uploads/SPYI-Semi-Annual-1.pdf">PDF</a></td></tr>
      <tr><td>Fiscal Year Q1 Portfolio Holdings</td><td><a href="https://neosfunds.com/wp-content/uploads/SPYI-Part-F-3.31.26-Confidential-v.2.pdf">PDF</a></td></tr>
      <tr><td>Fiscal Year Q3 Portfolio Holdings</td><td><a href="https://neosfunds.com/wp-content/uploads/SPYI-Fiscal-Year-Q3-Portfolio-Holdings.pdf">PDF</a></td></tr>
      <tr><td>2025 Supplemental Tax Information</td><td><a href="https://neosfunds.com/wp-content/uploads/NEOS-Tax-Insert-2025.pdf">PDF</a></td></tr>
    </tbody>
  </table>
</div>
<div id="tab-form-8937" class="tab-pane">
  <p>Form 8937</p>
  <a href="https://neosfunds.com/wp-content/uploads/NEOS-SP-500-R-High-Income-ETF-Form-8937-12.31.25.pdf">12/31/2025</a>
</div>
<div id="tab-19a1-notices" class="tab-pane">
  <a href="https://neosfunds.com/wp-content/uploads/SPYI-Prospectus.pdf">Prospectus</a>
</div>`;

describe("parseNeosDocuments", () => {
  const documents = parseNeosDocuments(DOCUMENTS_HTML);

  test("every published document is mapped to its own field", () => {
    expect(documents.prospectus).toEndWith("/SPYI-Prospectus.pdf");
    expect(documents.summaryProspectus).toEndWith("/SPYI-Summary-Prospectus.pdf");
    expect(documents.sai).toEndWith("/neos_sai-042926.pdf");
    expect(documents.annualReport).toEndWith("/SPYI-Annual-Report.pdf");
    expect(documents.semiAnnualReport).toEndWith("/SPYI-Semi-Annual-1.pdf");
  });

  test("the quarterly portfolio-holdings PDFs are told apart by their label", () => {
    expect(documents.fiscalQ1Holdings).toContain("Part-F");
    expect(documents.fiscalQ3Holdings).toContain("Fiscal-Year-Q3");
  });

  test("tax inserts and the Form 8937 tab are both covered", () => {
    expect(documents.taxInfo).toContain("NEOS-Tax-Insert-2025.pdf");
    expect(documents.form8937).toContain("Form-8937");
  });

  test("an empty 8937 tab does not borrow the next tab's PDF", () => {
    const withoutForm = parseNeosDocuments(
      `<div id="tab-form-8937"></div><div id="tab-19a1">` +
        `<a href="https://neosfunds.com/wp-content/uploads/XSPI-Prospectus.pdf">Prospectus</a></div>`,
    );
    expect(withoutForm.form8937).toBeNull();
  });

  test("a fund with no documents table leaves every field null", () => {
    const empty = parseNeosDocuments("<div>nothing</div>");
    expect(Object.values(empty).every((value) => value === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. CSV reading and the holdings contract
// ---------------------------------------------------------------------------

describe("parseCsv", () => {
  test("a BOM, CRLF line endings and quoted commas are all handled", () => {
    const rows = parseCsv('\uFEFFa,b\n"1,5",2\r\n3,4\n');
    expect(rows[0]).toEqual(["a", "b"]);
    expect(rows[1]).toEqual(["1,5", "2"]);
    expect(rows[2]).toEqual(["3", "4"]);
  });

  test("escaped quotes survive and blank lines are dropped", () => {
    expect(parseCsv('"a""b",c\n\n')[0]).toEqual(['a"b', "c"]);
  });
});

// Trimmed from the official daily download
// (admin-ajax.php?action=download_holdings_csv&ticker=SPYI): an equity row, a
// written SPXW call whose Cusip is the OCC symbol, and the cash line.
const HOLDINGS_CSV = [
  "Date,Account,StockTicker,Cusip,SecurityName,Shares,Price,MarketValue,Weightings,NetAssets,SharesOutstanding,CreationUnits,MoneyMarketFlag",
  '09/21/2026,NEOS,CBTX,126761100,CBOE OPTIONS EXCHANGE,"0.0000","0.00","$0.00","0.00%","$12,192,173,280.00","229,600,000","22,960","N"',
  '09/21/2026,NEOS,AAPL,037833100,APPLE INC,"1,331,939","255.46","$340,237,157.22","2.79%","$12,192,173,280.00","229,600,000","22,960","N"',
  '09/21/2026,NEOS,"SPXW  261001P07075000",SPXW  261001P07075000,"CBOE S&P 500 INDEX PUT 10/01/2026 70.750","-1,200","2.50","$-3,000.00","-0.00%","$12,192,173,280.00","229,600,000","22,960","N"',
  '09/21/2026,NEOS,Cash&Other,Cash&Other,Cash&Other,"162,387,743","1.00","$162,387,742.50","1.33%","$12,192,173,280.00","229,600,000","22,960","Y"',
].join("\n");

describe("parseNeosHoldingsCsv", () => {
  const parsed = parseNeosHoldingsCsv(HOLDINGS_CSV);

  test("the column set is the shared contract's, not the provider's", () => {
    expect(parsed.headers).toEqual([...HOLDINGS_HEADERS]);
    for (const row of parsed.rows) {
      expect(Object.keys(row)).toEqual([...HOLDINGS_HEADERS]);
    }
  });

  test("the as-of date and the position totals come from the file's own columns", () => {
    expect(parsed.asOfDate).toBe("2026-09-21");
    expect(parsed.netAssets).toBe(12_192_173_280);
    expect(parsed.sharesOutstanding).toBe(229_600_000);
    expect(parsed.creationUnits).toBe(22_960);
    expect(parsed.totalRows).toBe(4);
  });

  test("values are carried verbatim, including a written option's negative market value", () => {
    const option = parsed.rows[2];
    // cleanText collapses the OCC symbol's padding to a single space; the value
    // itself (and the negative share count of a written option) is untouched.
    expect(option.Ticker).toBe("SPXW 261001P07075000");
    expect(option['Market Value']).toBe("$-3000.00");
    expect(option['Shares Held']).toBe("-1,200");
    expect(option['Asset Category']).toBe("Option");
  });

  test("the cash line keeps its MoneyMarketFlag-derived category", () => {
    const cash = parsed.rows[3];
    expect(cash.Name).toBe("Cash&Other");
    expect(cash['Asset Category']).toBe("Cash");
  });

  test("a file that is not a holdings CSV is rejected instead of parsed blindly", () => {
    expect(() => parseNeosHoldingsCsv("Date,Other\n09/21/2026,x")).toThrow(/no StockTicker/);
  });
});

describe("neosAssetCategory", () => {
  test("options, cash, treasuries and funds are told apart, everything else is equity", () => {
    expect(neosAssetCategory("SPXW  261001P07075000", "CBOE S&P 500 INDEX PUT", "N")).toBe("Option");
    expect(neosAssetCategory("Cash&Other", "Cash&Other", "Y")).toBe("Cash");
    expect(neosAssetCategory("912797SA6", "United States Treasury Bill 10/01/2026", "N")).toBe("Treasury");
    expect(neosAssetCategory("AGG", "iShares Core U.S. Aggregate Bond ETF", "N")).toBe("Fund");
    expect(neosAssetCategory("AAPL", "APPLE INC", "N")).toBe("Equity");
  });
});

// ---------------------------------------------------------------------------
// 13. SEC EDGAR Form N-PORT-P (holdings fallback)
// ---------------------------------------------------------------------------

const NPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/nport">
  <headerData><repPdDate>2026-06-30</repPdDate></headerData>
  <formData>
    <genInfo><seriesName>NEOS S&amp;P 500 High Income ETF</seriesName></genInfo>
    <invstOrSecs>
      <invstOrSec>
        <name>APPLE INC</name>
        <identifiers><cusip value="037833100"/><isin value="US0378331005"/></identifiers>
        <balance>1331939.00000000</balance>
        <valUSD>340237157.22000000</valUSD>
        <pctVal>2.79000000</pctVal>
        <assetCat>EC</assetCat>
        <ticker value="AAPL"/>
      </invstOrSec>
      <invstOrSec>
        <name>SPXW 10/01/2026 PUT 70.750</name>
        <balance>-1200.00000000</balance>
        <valUSD>-3000.00000000</valUSD>
        <assetCat>OPT</assetCat>
      </invstOrSec>
    </invstOrSecs>
  </formData>
</edgarSubmission>`;

describe("parseNportXml / nportToHoldings", () => {
  const report = parseNportXml(NPORT_XML);

  test("the reporting period and the series name come from the filing header", () => {
    expect(report.repPdDate).toBe("2026-06-30");
    expect(report.seriesName).toBe("NEOS S&P 500 High Income ETF");
    expect(report.positions.length).toBe(2);
  });

  test("positions carry balance, value and the filing's own percent", () => {
    expect(report.positions[0].name).toBe("APPLE INC");
    expect(report.positions[0].ticker).toBe("AAPL");
    expect(report.positions[0].cusip).toBe("037833100");
    expect(report.positions[0].valueUsd).toBe(340_237_157.22);
    expect(report.positions[0].percent).toBe(2.79);
    expect(report.positions[1].balance).toBe(-1200);
  });

  test("the fallback folds onto the same holdings contract with a % weight", () => {
    const rows = nportToHoldings(report.positions, 12_192_173_280);
    expect(Object.keys(rows[0])).toEqual([...HOLDINGS_HEADERS]);
    expect(rows[0].Weight).toBe("2.79%");
    expect(rows[0]['Market Value']).toBe("$340237157.22");
    expect(rows[0]['Shares Held']).toBe("1331939");
    expect(rows[0]['Asset Category']).toBe("EC");
    // An N-PORT percent is published as-is; only a missing one is derived.
    expect(nportToHoldings([{ ...report.positions[1], percent: null }], 12_192_173_280)[0].Weight).toBe("0.00%");
  });
});

// ---------------------------------------------------------------------------
// 14. Yahoo chart feed
// ---------------------------------------------------------------------------

const YAHOO_JSON = {
  chart: {
    result: [
      {
        meta: { exchangeName: "PCX", fullExchangeName: "NYSEArca" },
        timestamp: [1_661_817_600, 1_661_904_000, 1_662_000_000, 1_662_086_400],
        indicators: {
          // 2022-08-31 has neither a close nor an adjusted close, 2022-09-01 has
          // only an adjusted close: the first is skipped, the second is kept.
          quote: [{ close: [100, null, null, 103], volume: [10, 20, 30, 40] }],
          adjclose: [{ adjclose: [99.5, null, 101.5, 102.5] }],
        },
        events: {
          dividends: {
            "1661817600": { amount: 0.5309, date: 1_661_817_600 },
            "1661904000": { amount: 0.5219, date: 1_662_000_000 },
          },
        },
      },
    ],
  },
};

describe("parseYahooChart / parseYahooExchangeName", () => {
  const parsed = parseYahooChart(YAHOO_JSON);

  test("the daily rows are published newest first", () => {
    expect(parsed.history.map((row) => row.date)).toEqual(["2022-09-02", "2022-09-01", "2022-08-30"]);
  });

  test("a day with no close at all is dropped rather than published as a blank row", () => {
    expect(parsed.history.some((row) => row.date === "2022-08-31")).toBe(false);
    expect(parsed.history.length).toBe(3);
  });

  test("a day that only has an adjusted close keeps it and leaves Close null", () => {
    const partial = parsed.history.find((row) => row.date === "2022-09-01")!;
    expect(partial.close).toBeNull();
    expect(partial.adjClose).toBe(101.5);
  });

  test("a complete day keeps all three series", () => {
    const complete = parsed.history.find((row) => row.date === "2022-08-30")!;
    expect(complete.close).toBe(100);
    expect(complete.adjClose).toBe(99.5);
    expect(complete.volume).toBe(10);
  });

  test("dividend events become the distribution fallback", () => {
    expect(parsed.dividends.length).toBe(2);
    expect(parsed.dividends[0].amount).toBe(0.5219);
  });

  test("the exchange name is available when the site omits one", () => {
    expect(parseYahooExchangeName(YAHOO_JSON)).toBe("PCX");
  });

  test("an error payload yields empty series, never a throw", () => {
    expect(parseYahooChart({ chart: { error: { code: "Not Found" } } })).toEqual({ history: [], dividends: [] });
  });
});

// ---------------------------------------------------------------------------
// 15. Return math and frequency codes
// ---------------------------------------------------------------------------

describe("return math", () => {
  test("a cumulative figure is the annualized one compounded over its years", () => {
    expect(cumulativeFromAnnualized(25, 2)).toBe(56.25);
    expect(cumulativeFromAnnualized(10.72, 1)).toBe(10.72);
    expect(cumulativeFromAnnualized(null, 3)).toBeNull();
  });

  test("the inverse returns the annualized figure", () => {
    expect(annualizedFromCumulative(56.25, 2)).toBe(25);
    expect(annualizedFromCumulative(10.72, 1)).toBe(10.72);
    expect(annualizedFromCumulative(null, 3)).toBeNull();
    expect(annualizedFromCumulative(-150, 3)).toBeNull();
  });

  test("the pair round-trips the figures NEOS publishes", () => {
    expect(annualizedFromCumulative(cumulativeFromAnnualized(16.04, 3), 3)).toBe(16.04);
    expect(annualizedFromCumulative(cumulativeFromAnnualized(15.02, 4), 4)).toBe(15.02);
  });
});

describe("distribution frequency", () => {
  test("paymentsPerYear reads every label the pages print", () => {
    expect(paymentsPerYear("Monthly")).toBe(12);
    expect(paymentsPerYear("Quarterly")).toBe(4);
    expect(paymentsPerYear("Semi-Annually")).toBe(6);
    expect(paymentsPerYear("Annually")).toBe(1);
    expect(paymentsPerYear("Weekly")).toBe(52);
    expect(paymentsPerYear("Irregular")).toBeNull();
    expect(paymentsPerYear(null)).toBeNull();
  });

  test("the catalog's coded label matches the app's sortable form", () => {
    expect(formatDistributionFrequency("Monthly")).toBe("01 - Monthly");
    expect(formatDistributionFrequency("Quarterly")).toBe("04 - Quarterly");
    expect(formatDistributionFrequency("Semi-Annually")).toBe("06 - Semi-annually");
    expect(formatDistributionFrequency("Annually")).toBe("12 - Annually");
    expect(formatDistributionFrequency("None")).toBe("00 - None");
    expect(formatDistributionFrequency("Unknown")).toBe("00 - Unknown");
    expect(formatDistributionFrequency("Irregular")).toBe("99 - Irregular");
    expect(formatDistributionFrequency("")).toBe("00 - None");
  });

  test("a frequency is inferred from ex-dates only when the site publishes none", () => {
    const monthly = ["2026-01-20", "2026-02-17", "2026-03-17", "2026-04-21", "2026-05-19", "2026-06-15"];
    expect(inferDistributionFrequency(monthly, new Date("2026-09-21T00:00:00Z"))).toBe("01 - Monthly");
    const quarterly = ["2025-12-19", "2026-03-20", "2026-06-19"];
    expect(inferDistributionFrequency(quarterly, new Date("2026-09-21T00:00:00Z"))).toBe("04 - Quarterly");
    expect(inferDistributionFrequency([], new Date("2026-09-21T00:00:00Z"))).toBe("00 - Unknown");
  });
});

// ---------------------------------------------------------------------------
// 16. Paging
// ---------------------------------------------------------------------------

describe("page files", () => {
  test("rows are split into fixed-size pages in order", () => {
    const pages = splitPages([1, 2, 3, 4, 5], 2);
    expect(pages).toEqual([[1, 2], [3, 4], [5]]);
    expect(splitPages([], 250)).toEqual([]);
  });

  test("page files are numbered with three digits from 001", () => {
    expect(pageFileName(1)).toBe("001.json");
    expect(pageFileName(12)).toBe("012.json");
    expect(pageFileName(1000)).toBe("1000.json");
  });
});

test('configuration precedence: file < advanced < nonblank input < environment', () => {
  const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'SPYI' }, { CONCURRENCY: 3, TICKERS: 'QQQI' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '5' });
  expect(c.CONCURRENCY).toBe('5');
  expect(c.TICKERS).toBe('QQQI');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
  expect(resolveControls({ TICKERS: 'SPYI' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
  expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
  expect(resolveControls({ HISTORY_PAGE_SIZE: 1000 }, {}, {}, { HISTORICAL_PAGE_SIZE: '500' }).HISTORY_PAGE_SIZE).toBe('500');
});

test('blank input inherits the file value', () => {
  expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
  expect(resolveControls({ MAX_RETRIES: 3 }, {}, { MAX_RETRIES: '' }).MAX_RETRIES).toBe('3');
});

test('scheduled path (empty inputs and advanced) equals the config defaults', () => {
  const defaults = file();
  const scheduled = resolveControls(defaults, JSON.parse('{}'), JSON.parse('{}'), {});
  expect(scheduled).toEqual(defaults);
  for (const value of Object.values(scheduled)) expect(typeof value).toBe('string');
});

test('resolver rejects unknown keys, invalid values and environment-file injection', () => {
  for (const value of [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { HISTORY_RANGE: 'forever' }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { SKIP_NEOS: 'perhaps' }, { AUM: '1:2:3' }, { TER: '5:1' }, { TICKERS: ['SPYI'] }, { TICKERS: null }, null, []]) {
    expect(() => resolveControls(value)).toThrow();
  }
  expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
  expect(() => resolveControls({}, {}, { TICKERS: 'a\nb' })).toThrow();
  expect(() => resolveControls({}, {}, {}, { SEC_UA: 'x\0bad' })).toThrow();
  expect(() => resolveControls({}, [])).toThrow();
  expect(() => resolveControls({}, JSON.parse('{"CONCURRENCY":{"a":1}}'))).toThrow();
  expect(() => JSON.parse('{not json')).toThrow();
});

test('provider-specific defaults resolve to the documented values', () => {
  const config = readConfig(resolveControls(file()));
  expect(config.maxFetches).toBe(0);
  expect(config.requestSleep).toBe(2);
  expect(config.concurrency).toBe(2);
  expect(config.maxRetries).toBe(3);
  expect(config.tickers).toEqual([]);
  expect(config.category).toBe('');
  expect(config.aumRange).toBeUndefined();
  expect(config.terRange).toBeUndefined();
  expect(config.holdingsPageSize).toBe(250);
  expect(config.historyPageSize).toBe(1000);
  expect(config.historyRange).toBe('max');
  expect(config.storeRawDownloads).toBe(false);
  expect(config.edgarFallback).toBe(true);
  expect(config.skipYahoo).toBe(false);
  expect(config.skipNeos).toBe(false);
  expect(config.secUa).toBe('daggerok ETF feed daggerok@gmail.com');
  expect(file().SEC_UA).toBe('daggerok ETF feed daggerok@gmail.com');
  expect(config.performanceRanges).toEqual({});
  expect(config.totalReturnRanges).toEqual({});
  expect(readConfig(resolveControls(file(), {}, { PERFORMANCE_3Y: '10:' })).performanceRanges['3Y']).toEqual({ min: 10, max: Infinity });
});

test('runtimeControls feeds the CLI with file defaults and env overrides', async () => {
  expect(await runtimeControls({})).toEqual(file());
  expect((await runtimeControls({ TICKERS: 'SPYI', SEC_UA: 'ci-contact' })).TICKERS).toBe('SPYI');
});

test('config keys, CONTROL_NAMES, --help and README controls table are in sync', () => {
  expect(Object.keys(file()).sort()).toEqual([...CONTROL_NAMES].sort());
  expect(new Set(CONTROL_NAMES).size).toBe(CONTROL_NAMES.length);
  for (const name of CONTROL_NAMES) expect(name).toMatch(/^[A-Z0-9_]+$/);
  const doc = read('README.md');
  const table = doc.slice(doc.indexOf('### Update controls'), doc.indexOf('### Examples'));
  for (const name of CONTROL_NAMES) {
    const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(1Y|3Y|5Y|10Y)$/);
    expect(table).toContain(tenor ? '`_' + tenor[2] + '`' : '`' + name + '`');
    if (tenor) expect(table).toContain('`' + tenor[1] + '_YTD`');
  }
  expect(doc).toContain('scripts/update-data.config.json');
  const help = Bun.spawnSync(['bun', 'scripts/update-data.ts', '--help'], { cwd: new URL('..', import.meta.url).pathname });
  const usage = help.stdout.toString();
  for (const name of CONTROL_NAMES) {
    const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(YTD|1Y|3Y|5Y|10Y)$/);
    expect(usage).toContain(tenor ? tenor[1] + '_YTD|1Y|3Y|5Y|10Y' : name);
  }
});

test('workflow: <= 25 inputs, advanced JSON, schedule, fixed api/neos output, no inputs interpolation', () => {
  const wf = read('.github/workflows/update-data.yml');
  const block = wf.slice(wf.indexOf('    inputs:'), wf.indexOf('\npermissions:'));
  const names = [...block.matchAll(/^      (\w+):$/gm)].map((m) => m[1]);
  expect(names.length).toBeLessThanOrEqual(25);
  expect(names).toContain('advanced');
  expect(block).toMatch(/advanced:[\s\S]*?default: '\{\}'/);
  for (const name of names.filter((n) => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase() as any);
  expect(wf).toContain("cron: '0 0 * * 0'");
  expect(wf).not.toMatch(/^  push:/m);
  expect(wf).toContain('toJSON(inputs)');
  expect(wf).toContain('resolveControls');
  expect(wf).not.toMatch(/\$\{\{\s*inputs\./);
  expect(wf).not.toContain('OUTPUT_DIR');
  expect(wf).toContain('git add api/neos\n          if git diff --cached --quiet -- api/neos');
  expect([...wf.matchAll(/git add (\S+)/g)].map((m) => m[1])).toEqual(['api/neos']);
  expect(wf).toContain('vars.SEC_UA');
  expect(wf).toContain('timeout-minutes: 30');
  expect(wf).toContain('persist-credentials: false');
  expect(wf).not.toMatch(/OUTPUT_DIR|\.\.\//);
});

test('README follows the standard section order and documents the verification commands', () => {
  const doc = read('README.md');
  const order = ['# NEOS', '## Using Bun', '## Updating the static NEOS data', '### Data sources', '### Metrics and caveats', '### Update controls', '### Examples', '## TypeScript and verification', '## Brands table', '## Sibling applications', '## License'];
  let at = -1;
  for (const heading of order) {
    const next = doc.indexOf('\n' + heading + '\n', at + 1) >= 0 ? doc.indexOf('\n' + heading + '\n', at + 1) : doc.startsWith(heading + '\n') && at < 0 ? 0 : -1;
    expect(next).toBeGreaterThan(at - (at < 0 ? 1 : 0));
    at = next;
  }
  for (const command of ['bun install --frozen-lockfile', 'bun test', 'bun build --target=bun scripts/update-data.ts --outfile=/dev/null', 'git diff --check']) expect(doc).toContain(command);
});

test('scripts/ carries only the config, the updater and its test', () => {
  const names = [...new Bun.Glob('*').scanSync({ cwd: path.join(REPO_ROOT, 'scripts'), onlyFiles: false })].sort();
  expect(names).toEqual(['update-data.config.json', 'update-data.test.ts', 'update-data.ts']);
});

describe('system CA support', () => {
  test('USE_SYSTEM_CA resolver accepts auto/true/false case-insensitively and rejects others', () => {
    expect(file().USE_SYSTEM_CA).toBe('auto');
    for (const value of ['auto', 'true', 'false', 'AUTO', 'True', 'FALSE']) {
      expect(resolveControls(file(), {}, {}, { USE_SYSTEM_CA: value }).USE_SYSTEM_CA).toBe(value);
    }
    expect(() => resolveControls(file(), {}, {}, { USE_SYSTEM_CA: 'maybe' })).toThrow('USE_SYSTEM_CA');
    expect(() => resolveControls(file(), { USE_SYSTEM_CA: 'yes' })).toThrow('USE_SYSTEM_CA');
  });

  test('isCertError recognises untrusted-certificate errors, also through cause', () => {
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('unable to get local issuer certificate'))).toBe(true);
    expect(isCertError(new Error('fetch failed', { cause: new Error('unable to get local issuer certificate') }))).toBe(true);
    expect(isCertError({ code: 'ECONNRESET', message: 'socket hang up' })).toBe(false);
    expect(isCertError(new Error('HTTP 403 Forbidden'))).toBe(false);
    expect(isCertError(null)).toBe(false);
  });

  describe('installSystemCa', () => {
    const originalFetch = globalThis.fetch;
    const restore = () => { globalThis.fetch = originalFetch; };
    const reexecSpy = () => {
      const calls: number[] = [];
      const reexec = (() => { calls.push(1); throw new Error('reexec'); }) as () => never;
      return { calls, reexec };
    };

    test('mode false and an already active store leave fetch unchanged', () => {
      try {
        const { calls, reexec } = reexecSpy();
        installSystemCa('false', reexec, false);
        expect(globalThis.fetch).toBe(originalFetch);
        installSystemCa('auto', reexec, true);
        expect(globalThis.fetch).toBe(originalFetch);
        installSystemCa('true', reexec, true);
        expect(globalThis.fetch).toBe(originalFetch);
        expect(calls.length).toBe(0);
      } finally { restore(); }
    });

    test('mode true restarts immediately', () => {
      try {
        const { calls, reexec } = reexecSpy();
        expect(() => installSystemCa('true', reexec, false)).toThrow('reexec');
        expect(calls.length).toBe(1);
      } finally { restore(); }
    });

    test('mode auto wraps fetch: cert error restarts once, other errors rethrown, success passes through', async () => {
      try {
        const { calls, reexec } = reexecSpy();
        let behaviour: 'ok' | 'cert' | 'reset' = 'ok';
        globalThis.fetch = (async () => {
          if (behaviour === 'cert') throw new Error('fetch failed', { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } });
          if (behaviour === 'reset') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
          return new Response('ok');
        }) as unknown as typeof fetch;
        const stub = globalThis.fetch;
        installSystemCa('auto', reexec, false);
        expect(globalThis.fetch).not.toBe(stub);
        expect(await (await fetch('https://example.invalid/')).text()).toBe('ok');
        behaviour = 'reset';
        await expect(fetch('https://example.invalid/')).rejects.toThrow('socket hang up');
        expect(calls.length).toBe(0);
        behaviour = 'cert';
        await expect(fetch('https://example.invalid/')).rejects.toThrow('reexec');
        expect(calls.length).toBe(1);
      } finally { restore(); }
    });
  });
});


// ---------------------------------------------------------------------------
// Keep previous data (SKIP_*, source failures) and EDGAR series identity
// ---------------------------------------------------------------------------
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync as readSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  edgarPrimaryDocLinks,
  fallbackIsStale,
  refreshHistoryOnly,
  seriesNameMatches,
  setApiRootForTests,
  updateFund,
} from "./update-data";

const FUND = {
  ticker: "SPYI", name: "NEOS S&P 500 High Income ETF", category: "Equity", categoryClass: "", frequency: "Monthly",
  distributionRate: null, distributionRateText: "", secYield: null, secYieldText: "", managementFee: 0.68,
  managementFeeText: "0.68%", netAssets: null, netAssetsText: "", inceptionDate: "", fundPage: "https://neosfunds.com/spyi/",
};
const PREVIOUS_ROWS = [
  { Date: "2026-09-18", Close: "53.10", "Adj Close": "53.10", Volume: "1" },
  { Date: "2026-09-17", Close: "53.00", "Adj Close": "53.00", Volume: "2" },
  { Date: "2026-09-16", Close: "52.90", "Adj Close": "52.90", Volume: "3" },
];

function seedFeed(holdingsAsOf = "Sep 21 2026") {
  const root = mkdtempSync(path.join(tmpdir(), "neos-feed-"));
  const dir = path.join(root, "funds", "SPYI");
  mkdirSync(path.join(dir, "history"), { recursive: true });
  mkdirSync(path.join(dir, "holdings"), { recursive: true });
  writeFileSync(path.join(dir, "history", "001.json"), JSON.stringify({ ticker: "SPYI", page: 1, pageSize: 1000, totalRows: 3, headers: [...HISTORY_HEADERS], rows: PREVIOUS_ROWS }));
  writeFileSync(path.join(dir, "holdings", "001.json"), JSON.stringify({ ticker: "SPYI", page: 1, rows: [{ Name: "OLD" }] }));
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
    ticker: "SPYI",
    holdings: { pages: ["./holdings/001.json"], totalRows: 1, asOfDate: holdingsAsOf },
    history: { pages: ["./history/001.json"], pageSize: 1000, totalRows: 3, asOf: "2026-09-18", asOfDate: "Sep 18 2026", source: "yahoo" },
  }));
  setApiRootForTests(root);
  return { root, dir };
}

const NPORT = (series: string, repPdDate: string) =>
  `<repPdDate>${repPdDate}</repPdDate><seriesName>${series}</seriesName><invstOrSec><name>X CORP</name><cusip>123456789</cusip><balance>10</balance><valUSD>500</valUSD><pctVal>1.5</pctVal><assetCat>EC</assetCat></invstOrSec>`;

function mockFetch(routes: (url: string) => Response | null) {
  const urls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return routes(url) ?? new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = real; } };
}
const quiet = () => readConfig({ REQUEST_SLEEP: "0", MAX_RETRIES: "1" });
const stats = () => ({ updated: 0, unchanged: 0, skipped: 0, failed: 0 });

describe("previous data survives a skipped or failed source", () => {
  test("SKIP_YAHOO keeps the published history pages and manifest", async () => {
    const { dir } = seedFeed();
    const m = mockFetch((url) => url.includes("neosfunds.com/spyi") ? new Response("<html></html>") : url.includes("download_holdings_csv") ? new Response(HOLDINGS_CSV) : null);
    try {
      const entry = await updateFund(FUND, { ...quiet(), skipYahoo: true }, stats());
      expect(entry.history).toBe(3);
      expect(readdirSync(path.join(dir, "history"))).toEqual(["001.json"]);
      expect(JSON.parse(readSync(path.join(dir, "meta.json"), "utf8")).history.totalRows).toBe(3);
    } finally { m.restore(); }
  });

  test("a failing Yahoo request keeps the published history", async () => {
    const { dir } = seedFeed();
    const m = mockFetch((url) => url.includes("neosfunds.com/spyi") ? new Response("<html></html>") : url.includes("download_holdings_csv") ? new Response(HOLDINGS_CSV) : null);
    try {
      const entry = await updateFund(FUND, quiet(), stats());
      expect(m.urls.some((url) => url.includes("query1.finance.yahoo.com"))).toBe(true);
      expect(entry.history).toBe(3);
      expect(JSON.parse(readSync(path.join(dir, "history", "001.json"), "utf8")).rows.length).toBe(3);
    } finally { m.restore(); }
  });

  test("SKIP_NEOS never reads neosfunds.com and keeps the published fund data", async () => {
    const { dir } = seedFeed();
    const previousEntry = { ticker: "SPYI", holdings: 1, history: 3, metrics: { tr1y: 14.62 } };
    const chart = JSON.stringify({ chart: { result: [{ timestamp: [1_790_000_000], indicators: { quote: [{ close: [54.1], volume: [5] }], adjclose: [{ adjclose: [54.1] }] }, meta: {} }] } });
    const m = mockFetch((url) => url.includes("finance.yahoo.com") ? new Response(chart) : null);
    try {
      const entry = await refreshHistoryOnly(FUND, previousEntry, { ...quiet(), skipNeos: true }, stats());
      expect(m.urls.every((url) => !url.includes("neosfunds.com"))).toBe(true);
      expect(entry.history).toBe(1);
      expect((entry.metrics as { tr1y: number }).tr1y).toBe(14.62);
      const meta = JSON.parse(readSync(path.join(dir, "meta.json"), "utf8"));
      expect(meta.holdings.totalRows).toBe(1);
      expect(meta.history.totalRows).toBe(1);
      // Yahoo down: the previous row is returned untouched.
      const failing = mockFetch(() => null);
      try {
        expect(await refreshHistoryOnly(FUND, previousEntry, { ...quiet(), skipNeos: true }, stats())).toBe(previousEntry);
      } finally { failing.restore(); }
    } finally { m.restore(); }
  });
});

describe("EDGAR fallback verifies the series and freshness", () => {
  test("seriesNameMatches is exact after normalization, never a sibling", () => {
    expect(seriesNameMatches("NEOS S&amp;P 500(R) High Income ETF".replace("&amp;", "&"), "NEOS S&P 500 High Income ETF")).toBe(true);
    expect(seriesNameMatches("NEOS Nasdaq-100 High Income ETF", "NEOS S&P 500 High Income ETF")).toBe(false);
    expect(seriesNameMatches(null, "NEOS S&P 500 High Income ETF")).toBe(false);
  });
  test("edgarPrimaryDocLinks keeps order and drops duplicates", () => {
    expect(edgarPrimaryDocLinks(`<a href="/Archives/a/primary_doc.xml"><a href='/Archives/b/primary_doc.xml'><a href="/Archives/a/primary_doc.xml">`)).toEqual(["/Archives/a/primary_doc.xml", "/Archives/b/primary_doc.xml"]);
  });
  test("fallbackIsStale compares the report period with the published date", () => {
    expect(fallbackIsStale("2026-08-31", "Sep 21 2026")).toBe(true);
    expect(fallbackIsStale("2026-09-30", "Sep 21 2026")).toBe(false);
    expect(fallbackIsStale("2026-08-31", undefined)).toBe(false);
  });

  const listing = `<a href="/Archives/x/other/primary_doc.xml"><a href="/Archives/x/spyi/primary_doc.xml">`;
  const route = (spyiPeriod: string) => (url: string) => {
    if (url.includes("neosfunds.com/spyi")) return new Response("<html></html>");
    if (url.includes("browse-edgar")) return new Response(listing);
    if (url.includes("/other/")) return new Response(NPORT("NEOS Nasdaq-100 High Income ETF", "2026-09-30"));
    if (url.includes("/spyi/")) return new Response(NPORT("NEOS S&amp;P 500 High Income ETF", spyiPeriod));
    return null; // holdings CSV and Yahoo: 404
  };

  test("a failed CSV takes the filing of THIS series, not the trust's newest filing", async () => {
    const { dir } = seedFeed("Aug 01 2026");
    const m = mockFetch(route("2026-08-31"));
    try {
      const entry = await updateFund(FUND, quiet(), stats());
      expect(entry.holdings).toBe(1);
      const page = JSON.parse(readSync(path.join(dir, "holdings", "001.json"), "utf8"));
      expect(page.rows[0].Name).toBe("X CORP");
      expect(JSON.parse(readSync(path.join(dir, "meta.json"), "utf8")).holdings.source).toContain("/spyi/");
    } finally { m.restore(); }
  });

  test("an older filing never replaces fresher published holdings", async () => {
    const { dir } = seedFeed("Sep 21 2026");
    const m = mockFetch(route("2026-08-31"));
    try {
      await expect(updateFund(FUND, quiet(), stats())).rejects.toThrow(/older than the published holdings/);
      expect(JSON.parse(readSync(path.join(dir, "holdings", "001.json"), "utf8")).rows[0].Name).toBe("OLD");
    } finally { m.restore(); }
  });
});

// ---------------------------------------------------------------------------
// Run robustness: cursor, placeholders, pacing, timeouts, writes, exit code
// ---------------------------------------------------------------------------
import {
  FETCH_TIMEOUT_MS,
  fetchRetried,
  filterScope,
  main,
  passesReturnFilters,
  placeholderEntry,
  reserveSlot,
  selectBatch,
  writeIfChanged,
  writeJsonIfContentChanged,
} from "./update-data";

describe("bounded runs (MAX_FETCHES cursor)", () => {
  const funds = ["A", "B", "C", "D", "E"].map((ticker) => ({ ticker }));
  test("a batch wraps around the end of the list", () => {
    expect(selectBatch(funds, "D", 3).map((fund) => fund.ticker)).toEqual(["E", "A", "B"]);
  });
  test("a cursor on the last fund starts over instead of stalling forever", () => {
    expect(selectBatch(funds, "E", 2).map((fund) => fund.ticker)).toEqual(["A", "B"]);
  });
  test("no cursor, unknown cursor and no limit", () => {
    expect(selectBatch(funds, null, 2).map((fund) => fund.ticker)).toEqual(["A", "B"]);
    expect(selectBatch(funds, "ZZ", 2).map((fund) => fund.ticker)).toEqual(["A", "B"]);
    expect(selectBatch(funds, "C", 0).length).toBe(5);
    expect(selectBatch(funds, "C", 99).length).toBe(5);
  });
  test("the cursor scope changes with the filter set", () => {
    expect(filterScope(readConfig({ TICKERS: "SPYI" }))).not.toBe(filterScope(readConfig({})));
  });
});

describe("index rows without a fund page read yet", () => {
  test("a placeholder carries the full metrics shape, null values and dataFile null", () => {
    const row = placeholderEntry(parseNeosLineup(LINEUP_HTML)[0]) as Record<string, any>;
    expect(row.dataFile).toBeNull();
    expect(Object.keys(row.metrics)).toEqual([
      "ytd", "tr1y", "tr3y", "tr5y", "tr10y", "cagr3y", "cagr5y", "cagr10y", "siAnn", "dividendYield", "dividendYieldText",
      "distributionYield", "distributionYieldText", "yield12M", "yield12MText", "secYield", "secYieldText", "returnsBasis", "performanceAsOf",
    ]);
    expect(row.metrics.tr1y).toBeNull();
    expect(row.metrics.returnsBasis.length).toBeGreaterThan(0);
    expect(row.terValue).toBeNull();
  });
});

describe("return filters", () => {
  test("a fund without the filtered figure is excluded", () => {
    const config = readConfig({ PERFORMANCE_5Y: "5:", TOTAL_RETURN_10Y: "0:" });
    expect(passesReturnFilters({ ticker: "A", metrics: { cagr5y: null, tr10y: 50 } } as any, config)).toBe(false);
    expect(passesReturnFilters({ ticker: "A", metrics: { cagr5y: 8, tr10y: null } } as any, config)).toBe(false);
    expect(passesReturnFilters({ ticker: "A", metrics: { cagr5y: 8, tr10y: 50 } } as any, config)).toBe(true);
  });
});

describe("pacing and timeouts", () => {
  test("simultaneous callers reserve distinct lanes synchronously", () => {
    const lanes = [0, 0, 0];
    const slots = [1, 2, 3, 4].map(() => reserveSlot(lanes, 1000, 10_000));
    expect(slots.map((slot) => slot.lane)).toEqual([0, 1, 2, 0]);
    expect(slots.map((slot) => slot.startAt)).toEqual([10_000, 10_000, 10_000, 11_000]);
  });

  test("a stalled request times out per attempt, is retried, then fails", async () => {
    expect(FETCH_TIMEOUT_MS).toBe(45_000);
    let calls = 0;
    const real = globalThis.fetch;
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      calls += 1;
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }) as unknown as typeof fetch;
    try {
      const config = { ...readConfig({ REQUEST_SLEEP: "0", MAX_RETRIES: "1" }), timeoutMs: 20, retryDelayMs: 0 };
      await expect(fetchRetried("https://x.invalid/", {}, config, "stall", (response) => response.text())).rejects.toThrow(/stall/);
      expect(calls).toBe(2);
    } finally { globalThis.fetch = real; }
  });

  test("a permanent status (404) is not retried", async () => {
    let calls = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async () => { calls += 1; return new Response("no", { status: 404 }); }) as unknown as typeof fetch;
    try {
      const config = { ...readConfig({ REQUEST_SLEEP: "0", MAX_RETRIES: "3" }), retryDelayMs: 0 };
      await expect(fetchRetried("https://x.invalid/", {}, config, "gone", (response) => response.text())).rejects.toThrow(/HTTP 404/);
      expect(calls).toBe(1);
    } finally { globalThis.fetch = real; }
  });
});

describe("writes", () => {
  test("writeIfChanged leaves no tmp file and does not rewrite identical content", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "neos-w-"));
    const target = path.join(dir, "a.json");
    expect(await writeIfChanged(target, "{}\n")).toBe("written");
    expect(await writeIfChanged(target, "{}\n")).toBe("unchanged");
    expect(readdirSync(dir)).toEqual(["a.json"]);
  });

  test("run stamps move only when the content moved", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "neos-s-"));
    const target = path.join(dir, "index.json");
    let clock = "2026-10-02T00:00:00Z";
    const stamp = () => clock;
    expect(await writeJsonIfContentChanged(target, { funds: [1] }, ["generatedAt"], stamp)).toBe("written");
    clock = "2026-10-03T00:00:00Z";
    expect(await writeJsonIfContentChanged(target, { funds: [1], generatedAt: "ignored" }, ["generatedAt"], stamp)).toBe("unchanged");
    expect(JSON.parse(readSync(target, "utf8")).generatedAt).toBe("2026-10-02T00:00:00Z");
    expect(await writeJsonIfContentChanged(target, { funds: [1, 2] }, ["generatedAt"], stamp)).toBe("written");
    expect(JSON.parse(readSync(target, "utf8")).generatedAt).toBe("2026-10-03T00:00:00Z");
  });
});

describe("main() against a mocked site", () => {
  const CHART = JSON.stringify({ chart: { result: [{ timestamp: [1_790_000_000, 1_790_086_400], indicators: { quote: [{ close: [54.1, 54.3], volume: [5, 6] }], adjclose: [{ adjclose: [54.1, 54.3] }] }, meta: { exchangeName: "PCX" } }] } });
  const routes = (url: string): Response | null => {
    if (url === "https://neosfunds.com/") return new Response(LINEUP_HTML);
    if (/neosfunds\.com\/[a-z]+\/$/.test(url)) return new Response("<html></html>");
    if (url.includes("download_holdings_csv")) return new Response(HOLDINGS_CSV);
    if (url.includes("finance.yahoo.com")) return new Response(CHART);
    return null;
  };
  const snapshot = (root: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full); else out[path.relative(root, full)] = readSync(full, "utf8");
      }
    };
    walk(root);
    return out;
  };
  const env = { REQUEST_SLEEP: "0", MAX_RETRIES: "1", CONCURRENCY: "3", USE_SYSTEM_CA: "false" };

  test("a rerun with identical upstream data writes nothing and the index lists every fund", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "neos-main-"));
    setApiRootForTests(root);
    const m = mockFetch(routes);
    const log = console.log;
    console.log = () => {};
    try {
      await main(env);
      const first = snapshot(root);
      const index = JSON.parse(first["index.json"]);
      expect(index.funds.map((fund: any) => fund.ticker)).toEqual(["IWMI", "SPYI", "XSPI"]);
      expect(index.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await main(env);
      expect(snapshot(root)).toEqual(first);
      // A one-ticker run keeps every other fund in the index.
      await main({ ...env, TICKERS: "SPYI" });
      expect(JSON.parse(readSync(path.join(root, "index.json"), "utf8")).funds.length).toBe(3);
    } finally { console.log = log; m.restore(); }
  });

  test("an unknown ticker is an error and a total failure exits non-zero", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "neos-fail-"));
    setApiRootForTests(root);
    const m = mockFetch((url) => (url === "https://neosfunds.com/" ? new Response(LINEUP_HTML) : null));
    const log = console.log;
    console.log = () => {};
    try {
      await expect(main({ ...env, TICKERS: "NOPE" })).rejects.toThrow(/not in the NEOS lineup: NOPE/);
      await expect(main({ ...env, EDGAR_FALLBACK: "false" })).rejects.toThrow(/every fund failed/);
    } finally { console.log = log; m.restore(); }
  });
});
