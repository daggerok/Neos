#!/usr/bin/env bash
# Temporary reconnaissance helper (deleted before the final commit).
set -u
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
SEC_UA='daggerok Neos data updater (https://github.com/daggerok; contact: daggerok)'

echo "=================== 1. fund page HTML ==================="
curl -sSL -A "$UA" -o /tmp/spyi.html -w 'spyi http=%{http_code} size=%{size_download}\n' 'https://neosfunds.com/spyi/'
wc -c /tmp/spyi.html

echo "--- context around 'Full Holdings' ---"
grep -o -i -E '.{800}Full Holdings.{400}' /tmp/spyi.html | head -3

echo "--- any csv/xlsx hrefs ---"
grep -o -i -E '[^"'"'"' ]*\.(csv|xlsx|xls)[^"'"'"' ]*' /tmp/spyi.html | sort -u | head -40

echo "--- anchors with download attribute ---"
grep -o -i -E '<a[^>]*download[^>]*>[^<]*' /tmp/spyi.html | head -20

echo "--- admin-ajax references ---"
grep -o -E '[^"'"'"' ]*admin-ajax[^"'"'"' ]*' /tmp/spyi.html | sort -u | head -20

echo "--- wp-json references ---"
grep -o -E 'wp-json[^"'"'"' ]*' /tmp/spyi.html | sort -u | head -30

echo "--- script srcs ---"
grep -o -E '<script[^>]*src="[^"]*"' /tmp/spyi.html | sed 's/.*src="//;s/"$//' | sort -u | head -40

echo "--- theme js/css ---"
grep -o -E 'href="[^"]*HVM-ALTERA[^"]*"' /tmp/spyi.html | sort -u | head -20

echo "=================== 2. candidate holdings files ==================="
for u in \
  "https://neosfunds.com/wp-content/uploads/SPYI-Holdings.xlsx" \
  "https://neosfunds.com/wp-content/uploads/SPYI-Daily-Holdings.csv" \
  "https://neosfunds.com/wp-content/uploads/SPYI-Full-Holdings.csv" \
  "https://neosfunds.com/wp-content/uploads/SPYI-Full-Holdings.xlsx" \
  "https://neosfunds.com/wp-content/uploads/SPYI-Holdings.csv" \
  "https://neosfunds.com/wp-content/uploads/holdings/SPYI.csv" \
  "https://neosfunds.com/wp-content/uploads/NEOS-Holdings.csv" \
  "https://neosfunds.com/wp-content/uploads/spyi-holdings.csv" \
  "https://neosfunds.com/wp-content/uploads/SPYI_Holdings.csv" \
  ; do
  code=$(curl -sS -o /tmp/probe.out -w '%{http_code}' -A "$UA" -L "$u")
  echo "$code  $(wc -c < /tmp/probe.out)  $u"
done

echo "=================== 3. SEC company_tickers_mf.json ==================="
curl -sS -A "$SEC_UA" -o /tmp/mf.json -w 'mf http=%{http_code} size=%{size_download}\n' \
  'https://www.sec.gov/files/company_tickers_mf.json'
python3 /tmp/py_mf.py 2>/dev/null || python3 - <<'PY'
import json
d = json.load(open('/tmp/mf.json'))
print('fields', d['fields'])
hits = [r for r in d['data'] if 'NEOS' in str(r).upper()]
print('NEOS rows:', len(hits))
for r in hits:
    print(' ', r)
PY

echo "=================== 4. Yahoo probe ==================="
for t in SPYI QQQI IWMI BTCI CSHI; do
  curl -sS -A "$UA" -o /tmp/y.json -w "$t http=%{http_code} " \
    "https://query1.finance.yahoo.com/v8/finance/chart/$t?period1=0&period2=9999999999&interval=1d&events=div%7Csplit&includeAdjustedClose=true"
  python3 - <<'PY'
import json
try:
    d = json.load(open('/tmp/y.json'))
    r = d['chart']['result'][0]
    ev = r.get('events', {})
    print('rows', len(r['timestamp']), 'divs', len(ev.get('dividends', {})), 'meta', r['meta'].get('regularMarketPrice'))
except Exception as e:
    print('ERR', e)
PY
done

echo "=================== 5. SEC N-PORT for NEOS trust ==================="
curl -sS -A "$SEC_UA" -o /tmp/nport.json -w 'nport http=%{http_code} size=%{size_download}\n' \
  'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001848758&type=NPORT-P&dateb=&owner=include&count=5&output=atom'
head -c 2000 /tmp/nport.json
echo
echo "=================== 6. explore-etfs catalog source ==================="
curl -sS -A "$UA" -o /tmp/home.html -w 'home http=%{http_code} size=%{size_download}\n' 'https://neosfunds.com/'
grep -o -i -E '<section[^>]*explore[^>]*>' /tmp/home.html | head -5
grep -o -i -E '[^"'"'"' ]*explore[^"'"'"' ]*' /tmp/home.html | sort -u | head -20
