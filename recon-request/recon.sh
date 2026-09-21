#!/usr/bin/env bash
# Temporary reconnaissance helper (deleted before the final commit).
set -u
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
ART=recon-request/artifacts
mkdir -p "$ART"

# neosfunds.com throttles bursts: retry with backoff, and reuse previous artifacts on failure.
fetch() { # url outfile
  local url="$1" out="$2" code
  for i in 1 2 3 4 5; do
    code=$(curl -sS -A "$UA" -L --retry 2 --retry-delay 3 --max-time 60 -o "$out" -w '%{http_code}' "$url" 2>/dev/null) || code=000
    if [ "$code" = "200" ]; then
      echo "ok $code $(wc -c < "$out") $out"
      return 0
    fi
    echo "  retry $i code=$code $url"
    sleep $((i * 5))
  done
  echo "FAILED code=$code $url (keeping previous copy if any)"
  return 1
}

echo "=================== 1. OFFICIAL HOLDINGS CSV ==================="
for t in SPYI CSHI BNDI BTCI IWMI; do
  if fetch "https://neosfunds.com/wp-admin/admin-ajax.php?action=download_holdings_csv&ticker=$t" "$ART/holdings-$t.csv"; then
    echo "--- $t bytes=$(wc -c < "$ART/holdings-$t.csv") lines=$(wc -l < "$ART/holdings-$t.csv")"
    head -10 "$ART/holdings-$t.csv"
    echo "   ...tail:"
    tail -3 "$ART/holdings-$t.csv"
  fi
  sleep 4
done

echo "=================== 2. CATALOG #etf-table (all rows) ==================="
fetch 'https://neosfunds.com/' "$ART/home.html"
python3 recon-request/parse_catalog.py

echo "=================== 3. FUND PAGE surface ==================="
fetch 'https://neosfunds.com/spyi/' "$ART/spyi.html"
python3 recon-request/parse_fund.py

echo "=================== 4. shpetf-data.com premium/discount ==================="
for u in \
  "https://shpetf-data.com/neos/NEOS_Web1.40ZZ.OZ_PremiumDiscount_SPYI.csv" \
  "https://shpetf-data.com/neos/NEOS_Web1.40ZZ.OZ_PremiumDiscount_SPYI.pdf" \
  "https://shpetf-data.com/neos/" \
  ; do
  code=$(curl -sS -A "$UA" -L -o /tmp/p.out -w '%{http_code}' "$u" 2>/dev/null) || code=000
  echo "$code bytes=$(wc -c < /tmp/p.out 2>/dev/null) ct=$(head -c 120 /tmp/p.out 2>/dev/null | tr -d '\r\n') $u"
done

echo "=================== 5. other admin-ajax actions ==================="
for act in download_holdings_csv download_nav_csv download_nav_history download_distributions_csv download_premium_discount get_holdings get_nav_history; do
  code=$(curl -sS -o /tmp/a.out -w '%{http_code}' -A "$UA" -L --max-time 40 \
    "https://neosfunds.com/wp-admin/admin-ajax.php?action=$act&ticker=SPYI" 2>/dev/null) || code=000
  echo "$code bytes=$(wc -c < /tmp/a.out 2>/dev/null) action=$act :: $(head -c 140 /tmp/a.out 2>/dev/null | tr -d '\r\n')"
  sleep 3
done
