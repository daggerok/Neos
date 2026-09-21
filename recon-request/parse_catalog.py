import re, html

h = open('recon-request/artifacts/home.html', encoding='utf-8', errors='replace').read()
i = h.find('id="explore-etfs"')
seg = h[i:i + 60000]

print('=== table ids inside explore-etfs ===')
print(sorted(set(re.findall(r'<table[^>]*id="([^"]+)"', seg))))
print('=== data-targets ===')
print(sorted(set(re.findall(r'data-target="([^"]+)"', seg))))

for tid in sorted(set(re.findall(r'<table[^>]*id="([^"]+)"', seg))):
    m = re.search(r'<table[^>]*id="%s"[^>]*>(.*?)</table>' % re.escape(tid), h, re.S)
    if not m:
        continue
    print('=== TABLE %s ===' % tid)
    for r in re.findall(r'<tr>(.*?)</tr>', m.group(1), re.S):
        cells = re.findall(r'<t[hd][^>]*>(.*?)</t[hd]>', r, re.S)
        out = []
        for c in cells:
            txt = re.sub(r'<[^>]+>', '', c)
            out.append(html.unescape(txt).strip().replace('\t', ' '))
        print('\t'.join(out))
