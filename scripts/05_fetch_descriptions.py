"""Fetch rich description + startDate + image for each market from Polymarket's
gamma API. Saves to data/descriptions.jsonl (resumable)."""

import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pandas as pd
import ssl
import urllib.request
import urllib.error

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data"
OUT = DATA / "descriptions.jsonl"

API = "https://gamma-api.polymarket.com/markets/{id}"
WORKERS = 30
TIMEOUT = 10


def fetch_one(mid):
    try:
        req = urllib.request.Request(API.format(id=mid), headers={"User-Agent": "predictopoly-scraper"})
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=SSL_CTX) as r:
            d = json.loads(r.read())
        return {
            "id": str(mid),
            "desc": d.get("description") or "",
            "start": d.get("startDate") or "",
            "image": d.get("image") or "",
            "outcomes": d.get("outcomes") or "",
            "resolved_by": d.get("resolvedBy") or "",
            "group": d.get("groupItemTitle") or "",
            "ok": True,
        }
    except urllib.error.HTTPError as e:
        return {"id": str(mid), "ok": False, "err": f"HTTP {e.code}"}
    except Exception as e:
        return {"id": str(mid), "ok": False, "err": str(e)[:100]}


def main():
    df = pd.read_parquet(DATA / "resolved_markets.parquet")
    all_ids = df["id"].astype(str).tolist()
    total = len(all_ids)

    done = set()
    if OUT.exists():
        with OUT.open() as f:
            for line in f:
                try:
                    done.add(json.loads(line)["id"])
                except Exception:
                    pass
        print(f"Resuming: {len(done)} already fetched", file=sys.stderr)

    todo = [x for x in all_ids if x not in done]
    print(f"To fetch: {len(todo)}/{total}", file=sys.stderr)

    t0 = time.time()
    n_ok = n_err = 0
    with OUT.open("a") as f, ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(fetch_one, mid): mid for mid in todo}
        for i, fut in enumerate(as_completed(futures), 1):
            rec = fut.result()
            f.write(json.dumps(rec) + "\n")
            if rec.get("ok"):
                n_ok += 1
            else:
                n_err += 1
            if i % 500 == 0:
                f.flush()
                rate = i / (time.time() - t0)
                eta = (len(todo) - i) / max(rate, 0.001)
                print(
                    f"  {i}/{len(todo)} ({rate:.1f}/s, ETA {eta/60:.1f}m) ok={n_ok} err={n_err}",
                    file=sys.stderr,
                )

    print(f"\nDone. ok={n_ok} err={n_err} elapsed={(time.time()-t0)/60:.1f}m", file=sys.stderr)


if __name__ == "__main__":
    main()
