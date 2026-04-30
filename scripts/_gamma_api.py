"""Vendored subset of polymarket-bot/src/polymarket_bot/api.py.

predictopoly's daily refresh runs in GitHub Actions where the polymarket-bot
sibling repo isn't available. Rather than make polymarket-bot a pip dep or a
submodule, we copy the two functions 07_fetch_active.py actually uses
(fetch_open_markets, parse_clob_tokens) plus their shared _get helper.

Forked from polymarket-bot upstream commit at the time of vendoring (April
2026). If we ever want price-history or single-market fetches, port them
deliberately rather than re-pointing at the upstream - predictopoly should
not silently inherit upstream behavior changes.

Read-only. No wallet, no auth.
"""
from __future__ import annotations

import json
import random
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

GAMMA = "https://gamma-api.polymarket.com"

_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 predictopoly-refresh/0.1"
)


def _get(base: str, path: str, params: dict | None = None, retries: int = 6,
         timeout: int = 45) -> Any:
    # Retry budget tuned for the daily GHA refresh: gamma occasionally drops
    # connections mid-page during a multi-window fetch. Exponential backoff
    # with jitter (1, 2, 4, 8, 16, 30s capped) covers a ~60s flap window
    # without giving up. 400 is a real client error and short-circuits;
    # everything else (timeouts, 5xx, 429, connection resets) retries.
    url = base + path
    if params:
        url = f"{url}?{urlencode(params)}"
    req = Request(url, headers={"User-Agent": _UA, "Accept": "application/json"})
    for attempt in range(retries):
        try:
            with urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except HTTPError as e:
            if e.code == 400:
                return None
            if attempt == retries - 1:
                raise
            backoff = min(30, 2 ** attempt) + random.uniform(0, 0.5)
            print(f"  gamma {e.code} on {path}, retry {attempt + 1}/{retries} in {backoff:.1f}s",
                  file=sys.stderr)
            time.sleep(backoff)
        except Exception as e:
            if attempt == retries - 1:
                raise
            backoff = min(30, 2 ** attempt) + random.uniform(0, 0.5)
            print(f"  gamma {type(e).__name__} on {path}, retry {attempt + 1}/{retries} in {backoff:.1f}s",
                  file=sys.stderr)
            time.sleep(backoff)
    return None


def fetch_open_markets(
    limit_per_page: int = 100,
    max_pages: int = 50,
    end_date_min: str | None = None,
    end_date_max: str | None = None,
    active_only: bool = True,
) -> tuple[list[dict], bool]:
    """Paginate through OPEN (not resolved) markets.

    Returns (markets, capped). `capped=True` means gamma 500'd mid-pagination
    and we stopped early - the caller should narrow the window and retry the
    missing tail rather than ship an incomplete result.

    end_date_min/max are ISO dates (YYYY-MM-DD). Polymarket has many zombie
    markets with endDate in the past that never got closed=true - without
    end_date_min, the ascending-by-endDate cursor wastes pages on those before
    reaching actually-approaching markets.

    active_only filters out markets that exist but aren't trading.

    Cap behavior: gamma 500s on /markets at variable offsets - sometimes
    deep (3000+ pages), sometimes shallow (offset 200) depending on backend
    load. Verified empirically 2026-04-29 across three back-to-back runs:
    same window can cap at offset 3900 then 3300 then 200 minutes apart.
    Retry alone can't fix this - the server is genuinely refusing. The
    caller (07_fetch_active.fetch_all_active) handles `capped=True` by
    splitting the date window and recursing, which reliably gets us under
    whatever per-query ceiling gamma is enforcing today.
    """
    out = []
    offset = 0
    capped = False
    for page in range(max_pages):
        params: dict[str, Any] = {
            "closed": "false",
            "limit": limit_per_page,
            "offset": offset,
            "order": "endDate",
            "ascending": "true",
        }
        if active_only:
            params["active"] = "true"
        if end_date_min:
            params["end_date_min"] = end_date_min
        if end_date_max:
            params["end_date_max"] = end_date_max
        try:
            batch = _get(GAMMA, "/markets", params)
        except HTTPError as e:
            # Gamma 500s mid-pagination = the per-query cap, not a transient
            # blip. Flag capped=True and bail; the caller will split the
            # date range and recurse. Below 5xx (e.g. 4xx that wasn't 400)
            # is genuine and we re-raise.
            if e.code >= 500:
                print(
                    f"  gamma {e.code} at offset={offset} after {page} pages, "
                    f"window {end_date_min}..{end_date_max} - flagging capped",
                    file=__import__("sys").stderr,
                )
                capped = True
                break
            raise
        except (URLError, TimeoutError, ConnectionError, OSError) as e:
            # Network failure after _get exhausted all retries. Treat as
            # cap-equivalent so the recursive caller can split the window
            # and try smaller; the alternative is a hard crash on every
            # transient gamma flap that lasts longer than ~5 min.
            print(
                f"  gamma {type(e).__name__} at offset={offset} after {page} pages, "
                f"window {end_date_min}..{end_date_max} - flagging capped",
                file=__import__("sys").stderr,
            )
            capped = True
            break
        if not isinstance(batch, list) or not batch:
            break
        out.extend(batch)
        if len(batch) < limit_per_page:
            break
        offset += limit_per_page
        time.sleep(0.25)
    return out, capped


def parse_clob_tokens(m: dict) -> tuple[str | None, str | None]:
    """Return (yes_token, no_token). Polymarket sometimes stores them as a
    JSON-encoded string rather than a proper list."""
    tokens = m.get("clobTokenIds")
    if isinstance(tokens, str):
        try:
            tokens = json.loads(tokens)
        except Exception:
            tokens = None
    if not tokens or len(tokens) < 2:
        return None, None
    return tokens[0], tokens[1]
