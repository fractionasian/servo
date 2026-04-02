#!/usr/bin/env python3
"""Generate simple SVG placeholder logos for all FuelWatch WA brands."""
import os

BRANDS = {
    # Major chains
    'bp': ('#009900', 'BP'),
    'shell': ('#FBCE07', 'SH'),
    'caltex': ('#ED1C24', 'CX'),
    'ampol': ('#ED1C24', 'AM'),
    'egampol': ('#ED1C24', 'EA'),
    'puma': ('#003DA5', 'PM'),
    'pumaenergy': ('#003DA5', 'PM'),
    'united': ('#1B3C87', 'UN'),
    'vibe': ('#FF6600', 'VB'),
    '7eleven': ('#00875A', '7E'),
    'liberty': ('#0054A6', 'LB'),
    'costco': ('#E31837', 'CO'),
    'coles': ('#ED1C24', 'CL'),
    'woolworths': ('#125831', 'WW'),
    # WA-specific brands
    'gull': ('#E8A317', 'GL'),
    'burk': ('#2D5F2D', 'BK'),
    'betterchoice': ('#FF8C00', 'BC'),
    'metropetroleum': ('#1E90FF', 'MP'),
    'omgmetro': ('#1E90FF', 'OM'),
    'solo': ('#FF4500', 'SO'),
    'astron': ('#6A0DAD', 'AS'),
    'atlas': ('#4682B4', 'AT'),
    'eagle': ('#B8860B', 'EG'),
    'phoenix': ('#CC5500', 'PH'),
    'independent': ('#708090', 'IN'),
    'fastfuel247': ('#20B2AA', 'FF'),
    'reddyexpress': ('#DC143C', 'RE'),
    'petrofuels': ('#2E8B57', 'PF'),
    'maiseyfuels': ('#8B4513', 'MF'),
    'cglfuel': ('#556B2F', 'CG'),
    'dunnings': ('#8B0000', 'DN'),
    'perrys': ('#4169E1', 'PE'),
    'ior': ('#333333', 'IO'),
    'ugo': ('#FF1493', 'UG'),
    'wafuels': ('#DAA520', 'WA'),
    'xconvenience': ('#9932CC', 'XC'),
    'broomediesel': ('#8B6914', 'BD'),
    # Fallback
    'default': ('#555555', '?'),
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

print(f'Generated {len(BRANDS)} logo SVGs in {out_dir}')
