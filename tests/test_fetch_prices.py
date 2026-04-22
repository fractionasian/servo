"""Tests for scripts/fetch_prices.py"""

import sys
import os
import xml.etree.ElementTree as ET
import json

# Allow importing from scripts/
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))

import fetch_prices


def _make_rss(items):
    """Build a minimal FuelWatch RSS XML string from a list of item dicts."""
    root = ET.Element('rss', version='2.0')
    channel = ET.SubElement(root, 'channel')
    for item_data in items:
        item = ET.SubElement(channel, 'item')
        for tag, value in item_data.items():
            el = ET.SubElement(item, tag)
            el.text = value
    return ET.tostring(root, encoding='unicode')


# ---------------------------------------------------------------------------
# parse_rss tests
# ---------------------------------------------------------------------------

def test_parse_rss_single_station():
    xml_str = _make_rss([{
        'trading-name': 'Caltex Morley',
        'brand': 'Caltex',
        'address': '123 Collier Rd',
        'location': 'MORLEY',
        'price': '1.839',
        'latitude': '-31.8901',
        'longitude': '115.9012',
    }])
    result = fetch_prices.parse_rss(xml_str)
    assert len(result) == 1
    station = result[0]
    assert station['station'] == 'Caltex Morley'
    assert station['brand'] == 'Caltex'
    assert station['address'] == '123 Collier Rd'
    assert station['suburb'] == 'Morley'
    assert station['price'] == 1.839
    assert station['lat'] == -31.8901
    assert station['lng'] == 115.9012


def test_parse_rss_multiple_stations():
    xml_str = _make_rss([
        {
            'trading-name': 'BP Cannington',
            'brand': 'BP',
            'address': '1 Cannington Rd',
            'location': 'CANNINGTON',
            'price': '1.799',
            'latitude': '-32.0123',
            'longitude': '115.9345',
        },
        {
            'trading-name': 'Coles Express Fremantle',
            'brand': 'Coles Express',
            'address': '99 High St',
            'location': 'FREMANTLE',
            'price': '1.819',
            'latitude': '-32.0564',
            'longitude': '115.7472',
        },
    ])
    result = fetch_prices.parse_rss(xml_str)
    assert len(result) == 2
    assert result[0]['station'] == 'BP Cannington'
    assert result[1]['station'] == 'Coles Express Fremantle'


def test_parse_rss_suburb_title_case():
    """Suburb comes in as UPPERCASE from FuelWatch and must be title-cased."""
    xml_str = _make_rss([{
        'trading-name': 'Vibe Bibra Lake',
        'brand': 'Vibe',
        'address': '50 Progress Dr',
        'location': 'BIBRA LAKE',
        'price': '1.779',
        'latitude': '-32.1234',
        'longitude': '115.8234',
    }])
    result = fetch_prices.parse_rss(xml_str)
    assert result[0]['suburb'] == 'Bibra Lake'


def test_parse_rss_empty_feed():
    """An RSS feed with no items returns an empty list."""
    xml_str = _make_rss([])
    result = fetch_prices.parse_rss(xml_str)
    assert result == []


# ---------------------------------------------------------------------------
# build_prices_json tests
# ---------------------------------------------------------------------------

def test_build_prices_json_structure():
    morley = {'station': 'BP Morley', 'brand': 'BP', 'address': '1 Rd',
              'suburb': 'Morley', 'price': 1.799, 'lat': -31.9, 'lng': 115.9}
    fuel_data = {
        'ulp':    [morley],
        'diesel': [],
        'pulp':   [],
        '98':     [],
    }
    result = fetch_prices.build_prices_json(fuel_data)
    parsed = json.loads(result)

    assert 'updated' in parsed
    assert 'stations' in parsed
    assert 'prices' in parsed
    assert set(parsed['prices'].keys()) == {'ulp', 'diesel', 'pulp', '98'}
    assert len(parsed['stations']) == 1
    station = parsed['stations'][0]
    assert station['name'] == 'BP Morley'
    assert station['id'] == fetch_prices.station_id(-31.9, 115.9)
    assert parsed['prices']['ulp'][station['id']] == 1.799


def test_build_prices_json_dedupes_across_fuels():
    """A station appearing in multiple fuel types should be stored once."""
    coords = {'lat': -32.0, 'lng': 115.8}
    s_ulp    = {'station': 'Shell X', 'brand': 'Shell', 'address': '2 Rd',
                'suburb': 'Perth', 'price': 1.799, **coords}
    s_diesel = {'station': 'Shell X', 'brand': 'Shell', 'address': '2 Rd',
                'suburb': 'Perth', 'price': 1.899, **coords}
    result = fetch_prices.build_prices_json({
        'ulp': [s_ulp], 'diesel': [s_diesel], 'pulp': [], '98': [],
    })
    parsed = json.loads(result)
    assert len(parsed['stations']) == 1
    sid = parsed['stations'][0]['id']
    assert parsed['prices']['ulp'][sid] == 1.799
    assert parsed['prices']['diesel'][sid] == 1.899


def test_station_id_stable_across_precision():
    """Coord-based id rounds to 5 decimals so tiny float wobble is absorbed."""
    assert fetch_prices.station_id(-31.900001, 115.900002) == \
           fetch_prices.station_id(-31.900003, 115.900001)


def test_build_prices_json_timestamp_format():
    """Timestamp should include timezone offset +08:00 (AWST)."""
    result = fetch_prices.build_prices_json({'ulp': [], 'diesel': [], 'pulp': [], '98': []})
    parsed = json.loads(result)
    assert '+08:00' in parsed['updated']
