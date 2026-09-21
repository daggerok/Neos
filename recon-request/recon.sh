#!/usr/bin/env bash
# Temporary reconnaissance helper (deleted before the final commit).
set -u
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
THEME='https://neosfunds.com/wp-content/themes/HVM-ALTERA'
ART=recon-request/artifacts
mkdir -p "$ART"

echo "=================== FULL etf-pages.js ==================="
curl -sS -A "$UA" -L -o "$ART/etf-pages.js" 'https://neosfunds.com/wp-content/themes/HVM-ALTERA/js/etf-pages.js'
cat "$ART/etf-pages.js"
echo
echo "=================== FULL portfolio.js ==================="
curl -sS -A "$UA" -L -o "$ART/portfolio.js" 'https://neosfunds.com/wp-content/themes/HVM-ALTERA/js/portfolio.js'
cat "$ART/portfolio.js"
echo
echo "=================== etf_ajax + localized vars (extracted) ==================="
grep -o -E 'var etf_ajax = .{0,900}' "$ART/spyi.html" 2>/dev/null | head -3
curl -sS -A "$UA" -L -o "$ART/spyi.html" 'https://neosfunds.com/spyi/'
grep -o -E 'var etf_ajax = .{0,1200}' "$ART/spyi.html" | head -3
echo "--- all wp_localize_script objects ---"
grep -o -E 'var [a-zA-Z_]+ *= *\{"[^;]{0,800}' "$ART/spyi.html" | head -10
