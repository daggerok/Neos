#!/usr/bin/env bash
# Temporary reconnaissance helper (deleted before the final commit).
set -u
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
SEC_UA='daggerok-Neos-ETF-Updater/1.0 (daggerok@users.noreply.github.com)'
THEME='https://neosfunds.com/wp-content/themes/HVM-ALTERA'
ART=recon-request/artifacts
mkdir -p "$ART"
get() { curl -sS -A "$UA" -L -o "$2" -w "%{http_code} %{size_download} $2\n" "$1"; }

echo "=================== 1. theme JS ==================="
for f in etf-pages.js portfolio.js global.js app.min.js; do
  get "$THEME/js/$f" "$ART/$f"
done

echo "--- downloadHoldingsCSV definition ---"
grep -o -E '.{0,120}downloadHoldingsCSV.{0,1200}' "$ART/etf-pages.js" | head -5

echo "--- all ajax actions / endpoints in etf-pages.js ---"
grep -o -E "action['\"]?\s*:\s*['\"][^'\"]+" "$ART/etf-pages.js" | sort -u | head -40
grep -o -E "ajaxurl[^;]{0,200}" "$ART/etf-pages.js" | head -20
grep -o -E "https?://[^'\"]+" "$ART/etf-pages.js" | sort -u | head -40
grep -o -E "\.(csv|json|xlsx|xml)\b" "$ART/etf-pages.js" | sort -u | head

echo "--- portfolio.js endpoints ---"
grep -o -E "https?://[^'\"]+" "$ART/portfolio.js" | sort -u | head -40
grep -o -E "action['\"]?\s*:\s*['\"][^'\"]+" "$ART/portfolio.js" | sort -u | head -40

echo "=================== 2. inline JSON in fund page ==================="
curl -sS -A "$UA" -L -o "$ART/spyi.html" -w 'spyi %{http_code} %{size_download}\n' 'https://neosfunds.com/spyi/'
echo "--- ajaxurl / localized vars ---"
grep -o -E 'var [a-zA-Z_]+ *= *\{[^}]{0,400}' "$ART/spyi.html" | head -20
grep -o -E 'ajaxurl[^,;]{0,120}' "$ART/spyi.html" | head -10
echo "--- admin-ajax actions in page ---"
grep -o -E "action=['\"][a-z0-9_-]+['\"]" "$ART/spyi.html" | sort -u | head -20
grep -o -E "'action' *: *'[a-z0-9_-]+'" "$ART/spyi.html" | sort -u | head -20
echo "--- data-* attributes with urls ---"
grep -o -E 'data-[a-z-]+="[^"]{0,200}"' "$ART/spyi.html" | grep -iE 'url|file|json|holdings|nav' | sort -u | head -30
echo "--- chart data / growth series ---"
grep -o -E '.{0,200}growth.{0,300}' "$ART/spyi.html" | head -5
grep -o -E 'chartData[^;]{0,300}' "$ART/spyi.html" | head -5

echo "=================== 3. probe admin-ajax ==================="
for act in get_holdings get_fund_holdings download_holdings holdings neos_holdings get_holdings_csv fund_holdings get_nav_history nav_history; do
  code=$(curl -sS -o "$ART/ajax-$act.out" -w '%{http_code}' -A "$UA" -L \
    --data-urlencode "action=$act" --data-urlencode 'ticker=SPYI' \
    "https://neosfunds.com/wp-admin/admin-ajax.php")
  echo "$code $(wc -c < "$ART/ajax-$act.out") action=$act :: $(head -c 160 "$ART/ajax-$act.out" | tr -d '\n')"
done

echo "=================== 4. explore-etfs section ==================="
curl -sS -A "$UA" -L -o "$ART/home.html" -w 'home %{http_code} %{size_download}\n' 'https://neosfunds.com/'
python3 - <<'PY'
import re
h = open('recon-request/artifacts/home.html', encoding='utf-8', errors='replace').read()
i = h.find('id="explore-etfs"')
print('explore-etfs offset', i)
if i > 0:
    seg = h[i-200:i+6000]
    open('recon-request/artifacts/explore-etfs.html','w').write(seg)
    print(seg[:3000])
PY

echo "=================== 5. SEC with declared UA ==================="
sleep 2
curl -sS -A "$SEC_UA" -o "$ART/mf.json" -w 'mf %{http_code} %{size_download}\n' 'https://www.sec.gov/files/company_tickers_mf.json'
python3 - <<'PY'
import json
try:
    d = json.load(open('recon-request/artifacts/mf.json'))
    print('fields', d['fields'])
    hits = [r for r in d['data'] if 'NEOS' in str(r).upper()]
    print('NEOS rows:', len(hits))
    for r in hits:
        print(' ', r)
except Exception as e:
    print('mf ERR', e)
    print(open('recon-request/artifacts/mf.json', encoding='utf-8', errors='replace').read()[:600])
PY
sleep 2
curl -sS -A "$SEC_UA" -o "$ART/nport.atom" -w 'nport %{http_code} %{size_download}\n' \
  'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001848758&type=NPORT-P&dateb=&owner=include&count=10&output=atom'
head -c 1200 "$ART/nport.atom"
echo
sleep 2
curl -sS -A "$SEC_UA" -o "$ART/submissions.json" -w 'submissions %{http_code} %{size_download}\n' \
  'https://data.sec.gov/submissions/CIK0001848758.json'
python3 - <<'PY'
import json
try:
    d = json.load(open('recon-request/artifacts/submissions.json'))
    print('name', d.get('name'), 'tickers', d.get('tickers'))
    r = d['filings']['recent']
    forms = r['form']
    nport = [(forms[i], r['accessionNumber'][i], r['filingDate'][i], r['primaryDocument'][i])
             for i in range(len(forms)) if forms[i].startswith('NPORT')]
    print('NPORT filings:', len(nport))
    for x in nport[:15]:
        print(' ', x)
except Exception as e:
    print('submissions ERR', e)
PY
