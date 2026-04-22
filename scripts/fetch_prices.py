"""
fetch_prices.py — Fetches FuelWatch RSS for all 4 fuel types and writes data/prices.json.

Run manually:
    python scripts/fetch_prices.py

Or via GitHub Actions on a schedule.
"""

import json
import os
import ssl
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

FUELWATCH_URL = 'https://www.fuelwatch.wa.gov.au/fuelwatch/fuelWatchRSS'

FUEL_TYPES = {
    'ulp':    '1',
    'pulp':   '2',
    '98':     '6',
    'diesel': '4',
}

# AWST is UTC+8
AWST = timezone(timedelta(hours=8))

# Path to output file — relative to the repo root, regardless of cwd
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_PATH = os.path.join(_REPO_ROOT, 'data', 'prices.json')


def fetch_rss(product_code: str, day: str = 'tomorrow') -> str:
    """Fetch FuelWatch RSS XML for the given product code.

    Args:
        product_code: FuelWatch numeric product code (e.g. '1' for ULP).
        day:          'today' or 'tomorrow' (default 'tomorrow').

    Returns:
        Raw XML string.
    """
    params = f'?Product={product_code}&Day={day}'
    url = FUELWATCH_URL + params
    req = urllib.request.Request(
        url,
        headers={
            'User-Agent': (
                'Mozilla/5.0 (compatible; servo-fuel-map/1.0; '
                '+https://github.com/fractionasian/servo)'
            )
        },
    )
    # FuelWatch uses a self-signed certificate in its chain.
    # We disable verification only for this known government endpoint.
    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(req, timeout=30, context=ssl_ctx) as resp:
        return resp.read().decode('utf-8')


def parse_rss(xml_str: str) -> list[dict]:
    """Parse FuelWatch RSS XML into a list of station dicts.

    Args:
        xml_str: Raw RSS XML string.

    Returns:
        List of dicts with keys: station, brand, address, suburb, price, lat, lng.
    """
    root = ET.fromstring(xml_str)
    stations = []

    for item in root.iter('item'):
        def _text(tag):
            el = item.find(tag)
            return el.text.strip() if el is not None and el.text else ''

        location = _text('location')
        stations.append({
            'station': _text('trading-name'),
            'brand':   _text('brand'),
            'address': _text('address'),
            'suburb':  location.title(),
            'price':   float(_text('price')),
            'lat':     float(_text('latitude')),
            'lng':     float(_text('longitude')),
        })

    return stations


def station_id(lat: float, lng: float) -> str:
    """Stable station identifier derived from coordinates (~1m precision)."""
    return f'{lat:.5f},{lng:.5f}'


def build_prices_json(fuel_data: dict) -> str:
    """Wrap fuel data into the normalised output JSON structure.

    Schema:
        updated:  ISO 8601 + AWST offset
        stations: [{ id, name, brand, address, suburb, lat, lng }]
        prices:   { fuel_type: { station_id: price } }

    Station identity is coord-based so a station keeps its id across runs
    even if its trading name or brand string shifts slightly.
    """
    stations_by_id: dict[str, dict] = {}
    prices: dict[str, dict[str, float]] = {fuel: {} for fuel in fuel_data}

    for fuel, station_list in fuel_data.items():
        for s in station_list:
            sid = station_id(s['lat'], s['lng'])
            if sid not in stations_by_id:
                stations_by_id[sid] = {
                    'id':      sid,
                    'name':    s['station'],
                    'brand':   s['brand'],
                    'address': s['address'],
                    'suburb':  s['suburb'],
                    'lat':     s['lat'],
                    'lng':     s['lng'],
                }
            prices[fuel][sid] = s['price']

    payload = {
        'updated':  datetime.now(tz=AWST).isoformat(timespec='seconds'),
        'stations': list(stations_by_id.values()),
        'prices':   prices,
    }
    return json.dumps(payload, indent=2)


def main():
    """Fetch all 4 fuel types and write data/prices.json."""
    fuel_data = {}
    for fuel_name, product_code in FUEL_TYPES.items():
        print(f'Fetching {fuel_name} (product {product_code})...', flush=True)
        xml_str = fetch_rss(product_code)
        stations = parse_rss(xml_str)
        fuel_data[fuel_name] = stations
        print(f'  → {len(stations)} stations', flush=True)

    output = build_prices_json(fuel_data)
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        f.write(output)
    print(f'Written to {OUTPUT_PATH}')


if __name__ == '__main__':
    main()
