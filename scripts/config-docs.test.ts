/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CONTROL_NAMES, readConfig, resolveControls, runtimeControls } from './update-data';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const file = () => JSON.parse(read('scripts/update-data.config.json'));

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
  expect(resolveControls({ MAX_RETRIES: 0 }, {}, { MAX_RETRIES: '' }).MAX_RETRIES).toBe('0');
});

test('scheduled path (empty inputs and advanced) equals the config defaults', () => {
  const defaults = file();
  const scheduled = resolveControls(defaults, JSON.parse('{}'), JSON.parse('{}'), {});
  expect(scheduled).toEqual(defaults);
  for (const value of Object.values(scheduled)) expect(typeof value).toBe('string');
});

test('resolver rejects unknown keys, invalid values and environment-file injection', () => {
  for (const value of [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { SKIP_NEOS: 'perhaps' }, { AUM: '1:2:3' }, { TER: '5:1' }, { TICKERS: ['SPYI'] }, { TICKERS: null }, null, []]) {
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
  expect(config.secUa).toContain('daggerok/Neos');
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
});
