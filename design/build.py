# Builds the clickable design (index.html) from template.html, fs.css, fs.js and data/.  python3 design/build.py design
import base64, json, sys
V = sys.argv[1]
data = V + '/data/'
s = open(V + '/template.html').read()
s = s.replace('</style>', open(V + '/fs.css').read() + '</style>', 1).replace('</script>', open(V + '/fs.js').read() + '</script>', 1)
e = lambda p: base64.b64encode(open(p, 'rb').read()).decode()
usage = json.dumps(json.load(open(data + 'usage-days.json'))['days'], separators=(',', ':'))
o = s.replace('__HANDS__', open(data + 'hands-compact.json').read()).replace('__ADAM__', e(data + 'adam.webp')).replace('__GOD__', e(data + 'god.webp')).replace('__USAGE__', usage).replace('__RECIPES__', open(data + 'recipes-real.json').read()).replace('__ART__', e(V + '/fresco-crop.webp'))
o = o.replace('__CARDS__', json.dumps({k: {**v, 'html': v['html'].replace('<a ', '<a target="_blank" rel="noopener" ')} for k, v in json.load(open(V + '/cards.json')).items()}).replace('</', '<\\/'))
open(V + '/index.html', 'w').write(o)
print('built', len(o))
