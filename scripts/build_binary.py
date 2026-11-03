#!/usr/bin/env python3
"""Build Kesiel's Executa for every platform and package it the way Anna expects.

  python scripts/build_binary.py            # all platforms (Go cross-compiles from any machine)
  python scripts/build_binary.py --platform linux-x86_64

Needs Go 1.22+ (https://go.dev/dl/). Writes, for each platform, into executas/kesiel/dist/:

  hearthside-kesiel-<version>-<platform>.tar.gz   (.zip on Windows)
      manifest.json            the tool manifest, with runtime.binary set for that platform
      bin/hearthside-kesiel    the static executable (mode 0755; .exe on Windows)
  hearthside-kesiel-<version>-<platform>.<ext>.sha256

This mirrors Anna's reference packaging (static binary, CGO off, manifest + bin/ only).
"""
from __future__ import annotations

import argparse, hashlib, io, json, os, shutil, subprocess, sys, tarfile, time, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "executas" / "kesiel"
DIST = SRC / "dist"
NAME = "hearthside-kesiel"
TARGETS = {  # Anna platform key -> (GOOS, GOARCH)
    "linux-x86_64": ("linux", "amd64"),
    "linux-aarch64": ("linux", "arm64"),
    "darwin-arm64": ("darwin", "arm64"),
    "darwin-x86_64": ("darwin", "amd64"),
    "windows-x86_64": ("windows", "amd64"),
}


def versions() -> str:
    m = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))["version"]
    e = json.loads((SRC / "executa.json").read_text(encoding="utf-8"))["version"]
    if m != e:
        sys.exit(f"version mismatch: manifest.json {m} vs executa.json {e} — make them equal")
    return m


def add_tar(t: tarfile.TarFile, name: str, data: bytes, mode: int) -> None:
    info = tarfile.TarInfo(name)
    info.size, info.mode, info.mtime = len(data), mode, int(time.time())
    info.uname = info.gname = "anna"
    t.addfile(info, io.BytesIO(data))


def build(platform: str, version: str) -> Path:
    goos, goarch = TARGETS[platform]
    exe = "bin/" + NAME + (".exe" if goos == "windows" else "")
    work = ROOT / "build" / platform
    shutil.rmtree(work, ignore_errors=True); (work / "bin").mkdir(parents=True)
    env = {**os.environ, "GOOS": goos, "GOARCH": goarch, "CGO_ENABLED": "0"}
    subprocess.run(["go", "build", "-trimpath", "-ldflags=-s -w", "-o", str(work / exe), "."], cwd=SRC, env=env, check=True)

    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    manifest["runtime"] = {"type": "binary", "binary": {"entrypoint": exe, "permissions": {exe: "0o755"}}}
    mbytes = (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    binary = (work / exe).read_bytes()

    DIST.mkdir(parents=True, exist_ok=True)
    base = f"{NAME}-{version}-{platform}"
    if goos == "windows":
        archive = DIST / f"{base}.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("manifest.json", mbytes)
            zi = zipfile.ZipInfo(exe, time.localtime()[:6]); zi.external_attr = 0o100755 << 16; zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, binary)
    else:
        archive = DIST / f"{base}.tar.gz"
        with tarfile.open(archive, "w:gz") as t:
            add_tar(t, "manifest.json", mbytes, 0o644)
            add_tar(t, exe, binary, 0o755)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    Path(str(archive) + ".sha256").write_text(f"{digest}  {archive.name}\n")
    print(f"built {archive.relative_to(ROOT)}  ({len(binary)//1024} KB binary, sha256 {digest[:12]}…)")
    return archive


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--platform", choices=sorted(TARGETS), action="append", help="repeatable; default: all")
    a = ap.parse_args()
    version = versions()
    for old in DIST.glob(f"{NAME}-*") if DIST.exists() else []:
        if f"-{version}-" not in old.name:
            old.unlink()  # keep dist/ to the current version only
    for p in a.platform or TARGETS:
        build(p, version)


if __name__ == "__main__":
    main()
