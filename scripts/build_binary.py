#!/usr/bin/env python3
"""Build the Kesiel Executa into a single native binary and package it for Anna.

  python scripts/build_binary.py --platform linux-x86_64

Produces executas/kesiel/dist/hearthside-kesiel-<version>-<platform>.tar.gz (or .zip on
Windows) containing bin/hearthside-kesiel[.exe], plus a .sha256 file. Run it on a machine
(or CI runner) of the target platform — PyInstaller does not cross-compile. The GitHub
Actions workflow in .github/workflows/release-executa.yml does all four platforms.
"""
from __future__ import annotations

import argparse, hashlib, json, os, platform, shutil, subprocess, sys, tarfile, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXE_DIR = ROOT / "executas" / "kesiel"
NAME = "hearthside-kesiel"
PLATFORMS = {"linux-x86_64", "darwin-arm64", "darwin-x86_64", "windows-x86_64"}


def guess_platform() -> str:
    m = platform.machine().lower()
    arch = "arm64" if m in ("arm64", "aarch64") else "x86_64"
    osname = {"linux": "linux", "darwin": "darwin", "win32": "windows"}.get(sys.platform, sys.platform)
    return f"{osname}-{arch}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--platform", default=guess_platform(), choices=sorted(PLATFORMS))
    a = ap.parse_args()
    version = json.loads((EXE_DIR / "executa.json").read_text())["version"]
    manifest_version = json.loads((EXE_DIR / "manifest.json").read_text())["version"]
    if version != manifest_version:
        sys.exit(f"version mismatch: executa.json {version} vs manifest.json {manifest_version}")

    work = ROOT / "build" / a.platform
    shutil.rmtree(work, ignore_errors=True); work.mkdir(parents=True)
    subprocess.check_call([sys.executable, "-m", "PyInstaller", "--onefile", "--clean", "--noconfirm",
                           "--name", NAME, "--distpath", str(work / "pyi-dist"), "--workpath", str(work / "pyi-work"),
                           "--specpath", str(work), str(EXE_DIR / "hearthside_kesiel_plugin.py")])
    exe = NAME + (".exe" if a.platform.startswith("windows") else "")
    stage = work / "stage"; (stage / "bin").mkdir(parents=True)
    shutil.copy2(work / "pyi-dist" / exe, stage / "bin" / exe)
    os.chmod(stage / "bin" / exe, 0o755)
    shutil.copy2(EXE_DIR / "manifest.json", stage / "manifest.json")

    out_dir = EXE_DIR / "dist"; out_dir.mkdir(exist_ok=True)
    base = f"{NAME}-{version}-{a.platform}"
    if a.platform.startswith("windows"):
        archive = out_dir / f"{base}.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
            for p in stage.rglob("*"):
                if p.is_file():
                    z.write(p, p.relative_to(stage).as_posix())
    else:
        archive = out_dir / f"{base}.tar.gz"
        with tarfile.open(archive, "w:gz") as t:
            for p in sorted(stage.rglob("*")):
                t.add(p, p.relative_to(stage).as_posix(), recursive=False)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    Path(str(archive) + ".sha256").write_text(f"{digest}  {archive.name}\n")
    # leave an unpacked copy for the protocol smoke test
    shutil.rmtree(out_dir / a.platform, ignore_errors=True)
    shutil.copytree(stage, out_dir / a.platform)
    print(f"built {archive.relative_to(ROOT)}  sha256={digest[:16]}…")


if __name__ == "__main__":
    main()
