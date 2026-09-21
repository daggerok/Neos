import re, html

h = open('recon-request/artifacts/spyi.html', encoding='utf-8', errors='replace').read()
print('page bytes', len(h))

print('=== all element ids ===')
print(sorted(set(re.findall(r'id="([^"]+)"', h))))

print('=== onclick handlers ===')
print(sorted(set(re.findall(r'onclick="([^"]{0,140})"', h))))

print('=== canvas ids ===')
print(sorted(set(re.findall(r'<canvas[^>]*id="([^"]+)"', h))))

print('=== navIndexChart context ===')
i = h.find('navIndexChart')
print(re.sub(r'\s+', ' ', h[max(0, i - 3000):i + 1500]) if i > 0 else 'none')

print('=== distribution history table (first 3000 chars) ===')
m = re.search(r'id="tab-distribution-history"(.*?)</table>', h, re.S)
print(m.group(1)[:3000] if m else 'none')

print('=== distribution-info block ===')
i = h.find('id="distribution-info"')
print(re.sub(r'\s+', ' ', h[i:i + 2500]) if i > 0 else 'none')

print('=== anchors mentioning csv/json/nav/history/pdf ===')
for a in sorted(set(re.findall(r'href="([^"]*)"', h))):
    if any(k in a.lower() for k in ('.csv', '.json', 'nav', 'premium', 'discount', 'history', 'premiumdiscount')):
        print('  ', a)

print('=== inline script vars (first 40) ===')
for m in re.finditer(r'<script[^>]*>(.*?)</script>', h, re.S):
    body = m.group(1)
    if 'var ' in body and len(body) < 6000 and 'wpforms' not in body:
        print('---')
        print(re.sub(r'\s+', ' ', body)[:1500])
