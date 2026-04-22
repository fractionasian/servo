"""
build_history.py — Walk the git history of data/prices.json and assemble a
rolling per-station, per-fuel price series at data/history.json.

Schema:
    {
        "days":   ["2026-04-01", ..., "2026-04-07"],
        "prices": {
            "ulp":    { "<station_id>": [191.3, 190.1, null, 191.3, ...] },
            "pulp":   { ... },
            "98":     { ... },
            "diesel": { ... }
        }
    }

Each series is aligned to `days` (oldest → newest). Missing days are null.

Run:
    python scripts/build_history.py [--days 14]
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime

FUELS = ['ulp', 'pulp', '98', 'diesel']

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRICES_PATH = 'data/prices.json'
OUTPUT_PATH = os.path.join(_REPO_ROOT, 'data', 'history.json')


def git(*args: str) -> str:
    result = subprocess.run(
        ['git', *args],
        cwd=_REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def station_id(lat: float, lng: float) -> str:
    return f'{lat:.5f},{lng:.5f}'


def parse_snapshot(json_str: str) -> tuple[str | None, dict[str, dict[str, float]]]:
    """Return (date_str, {fuel: {station_id: price}}) from a prices.json string.

    Handles both the new normalised schema and the legacy fuel_types schema
    so historical commits before the migration still contribute data.
    """
    try:
        data = json.loads(json_str)
    except json.JSONDecodeError:
        return (None, {})

    iso = data.get('updated', '')
    try:
        day = datetime.fromisoformat(iso).date().isoformat()
    except (ValueError, TypeError):
        day = None

    prices: dict[str, dict[str, float]] = {f: {} for f in FUELS}

    if 'prices' in data and 'stations' in data:
        # New schema
        for fuel, price_map in data.get('prices', {}).items():
            if fuel in prices:
                prices[fuel] = dict(price_map)
    else:
        # Legacy: fuel_types → list of station dicts
        for fuel, stations in data.get('fuel_types', {}).items():
            if fuel not in prices:
                continue
            for s in stations:
                try:
                    sid = station_id(s['lat'], s['lng'])
                    prices[fuel][sid] = s['price']
                except (KeyError, TypeError, ValueError):
                    continue

    return (day, prices)


def commit_blob(sha: str, path: str) -> str | None:
    """Return the file contents at a given commit, or None if the file didn't exist."""
    try:
        return git('show', f'{sha}:{path}')
    except subprocess.CalledProcessError:
        return None


def snapshots_for_days(days: int) -> list[tuple[str, dict[str, dict[str, float]]]]:
    """Collect the most-recent snapshot per day, taking the last `days` distinct days.

    Walks commit history newest-first; when multiple commits exist on the same day
    (e.g. manual re-runs), the first one seen (newest) wins. Stops once `days`
    distinct dates have been captured.
    """
    log = git('log', '--follow', '--format=%H', '--', PRICES_PATH).strip()
    shas = [line for line in log.splitlines() if line]

    by_day: dict[str, dict[str, dict[str, float]]] = {}

    for sha in shas:
        if len(by_day) >= days:
            break
        blob = commit_blob(sha, PRICES_PATH)
        if blob is None:
            continue
        day, prices = parse_snapshot(blob)
        if not day or day in by_day:
            continue
        by_day[day] = prices

    return sorted(by_day.items())


def build_history(days: int) -> dict:
    snapshots = snapshots_for_days(days)
    if not snapshots:
        return {'days': [], 'prices': {f: {} for f in FUELS}}

    day_list = [d for d, _ in snapshots]

    # Collect every station id that appears anywhere
    per_fuel: dict[str, dict[str, list]] = {f: {} for f in FUELS}

    for idx, (_, prices) in enumerate(snapshots):
        for fuel in FUELS:
            price_map = prices.get(fuel, {})
            for sid, p in price_map.items():
                series = per_fuel[fuel].setdefault(sid, [None] * len(day_list))
                series[idx] = p

    return {'days': day_list, 'prices': per_fuel}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=14,
                        help='How many days of history to include (default: 14)')
    args = parser.parse_args()

    history = build_history(args.days)
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        # Compact format — history files are mostly numeric and benefit from no indent
        json.dump(history, f, separators=(',', ':'))

    n_stations = sum(len(per_fuel) for per_fuel in history['prices'].values())
    print(f'Wrote {OUTPUT_PATH}: {len(history["days"])} days, '
          f'{n_stations} station-fuel series.')


if __name__ == '__main__':
    sys.exit(main())
