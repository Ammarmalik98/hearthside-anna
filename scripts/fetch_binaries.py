#!/usr/bin/env python3
"""Download the Kesiel Executa archives from a GitHub Release into executas/kesiel/dist/.

  python scripts/fetch_binaries.py --repo <you>/<hearthside-repo> [--tag kesiel-v0.1.0]

Needs the GitHub CLI (`gh`) logged in. Verifies every archive against its .sha256 file.
"""
from __future__ import annotations

import argparse, hashlib, json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "executas" / "kesiel" / "dist"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--tag")
    a = ap.parse_args()
    version = json.loads((ROOT / "executas" / "kesiel" / "executa.json").read_text())["version"]
    tag = a.tag or f"kesiel-v{version}"
    DIST.mkdir(parents=True, exist_ok=True)
    subprocess.check_call(["gh", "release", "download", tag, "--repo", a.repo, "--dir", str(DIST), "--clobber"])
    bad = 0
    for sha in DIST.glob("*.sha256"):
        want, name = sha.read_text().split()
        got = hashlib.sha256((DIST / name).read_bytes()).hexdigest()
        print(("OK   " if got == want else "BAD  ") + name)
        bad += got != want
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
