#!/usr/bin/env python3
"""Generate simple SVG placeholder logos for fuel brands."""
import os

BRANDS = {
    'bp': ('#009900', 'BP'),
    'shell': ('#FBCE07', 'SH'),
    'caltex': ('#ED1C24', 'CX'),
    'ampol': ('#ED1C24', 'AM'),
    'puma': ('#003DA5', 'PM'),
    'pumaenergy': ('#003DA5', 'PM'),
    'united': ('#1B3C87', 'UN'),
    'vibe': ('#FF6600', 'VB'),
    '7eleven': ('#00875A', '7E'),
    'liberty': ('#0054A6', 'LB'),
    'costco': ('#E31837', 'CO'),
    'coles': ('#ED1C24', 'CL'),
    'woolworths': ('#125831', 'WW'),
    'default': ('#666666', '?'),
}

SVG_TEMPLATE = '''<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
  <circle cx="10" cy="10" r="9" fill="{colour}"/>
  <text x="10" y="14" text-anchor="middle" font-size="8" font-weight="bold" fill="white" font-family="sans-serif">{label}</text>
</svg>'''

out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'logos')
os.makedirs(out_dir, exist_ok=True)

for slug, (colour, label) in BRANDS.items():
    svg = SVG_TEMPLATE.format(colour=colour, label=label)
    path = os.path.join(out_dir, f'{slug}.svg')
    with open(path, 'w') as f:
        f.write(svg)
    print(f'  wrote {path}')

print(f'Done — {len(BRANDS)} logos in {out_dir}')
