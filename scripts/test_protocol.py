#!/usr/bin/env python3
"""Check Kesiel's Executa the way the Anna Agent talks to it, plus its release archives.

  python scripts/test_protocol.py                 # builds a native binary with Go, then tests it
  python scripts/test_protocol.py --binary PATH   # test a specific binary
  python scripts/test_protocol.py --archives      # also check every archive in executas/kesiel/dist

Plays the host: initialize / describe / invoke(ping) / invoke(reflect) — answering the tool's
reverse sampling/createMessage with a canned reply — then health, to prove the process is still
reading. Checks one JSON object per stdout line, echoed ids, an unwrapped describe that equals
executas/kesiel/manifest.json, the six allowed parameter types, and (with --archives) that every
archive holds exactly manifest.json + bin/hearthside-kesiel[.exe] with runtime.binary set and
the executable bit on.
"""
from __future__ import annotations

import argparse, json, subprocess, sys, tarfile, tempfile, time, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "executas" / "kesiel"
CANNED = {"role": "assistant", "content": {"type": "text", "text": '{"reflection": "A quiet, golden morning that left you feeling known.", "prompt": "Who else makes you feel known?"}'}, "model": "test", "stopReason": "endTurn"}
TYPES = {"string", "integer", "number", "boolean", "array", "object"}


def test_binary(binary: str) -> None:
    t0 = time.time()
    p = subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")

    def send(o):
        p.stdin.write(json.dumps(o) + "\n"); p.stdin.flush()

    def recv():
        line = p.stdout.readline()
        assert line.endswith("\n"), f"response must end with a newline: {line!r}"
        return json.loads(line)

    send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    r = recv(); assert r["id"] == 1 and "capabilities" in r["result"], r
    send({"jsonrpc": "2.0", "id": 2, "method": "describe"})
    r = recv(); assert r["id"] == 2, r
    startup = time.time() - t0
    d = r["result"]; assert "manifest" not in d and "success" not in d, "describe must not be wrapped"
    assert d == json.loads((SRC / "manifest.json").read_text(encoding="utf-8")), "describe differs from manifest.json"
    for t in d["tools"]:
        assert isinstance(t["parameters"], list)
        for prm in t["parameters"]:
            assert prm["type"] in TYPES, prm
    send({"jsonrpc": "2.0", "id": "p", "method": "invoke", "params": {"tool": "ping", "arguments": {}}})
    r = recv(); assert r["id"] == "p" and r["result"]["success"] and r["result"]["data"]["pong"], r
    send({"jsonrpc": "2.0", "id": 4, "method": "invoke", "params": {"tool": "reflect", "arguments": {"text": "Walked to the market. The light was golden and the mango lady remembered my name.", "mood": "Good"}}})
    sreq = recv(); assert sreq.get("method") == "sampling/createMessage", sreq
    assert sreq["params"]["messages"][0]["content"]["type"] == "text" and sreq["params"]["systemPrompt"]
    send({"jsonrpc": "2.0", "id": sreq["id"], "result": CANNED})
    r = recv(); assert r["id"] == 4 and r["result"]["success"], r
    assert r["result"]["data"]["reflection"] and r["result"]["data"]["prompt"], r
    send({"jsonrpc": "2.0", "id": 5, "method": "invoke", "params": {"tool": "reflect", "arguments": {"text": "too short"}}})
    r = recv(); assert r["id"] == 5 and r["result"]["success"] is False, r
    send({"jsonrpc": "2.0", "id": 6, "method": "health"})
    r = recv(); assert r["id"] == 6 and r["result"]["status"] == "ready", r   # still alive after replying
    p.stdin.close(); p.wait(timeout=10)
    print(f"protocol OK: {binary}  (describe answered in {startup*1000:.0f} ms)")


def test_archives() -> None:
    version = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))["version"]
    arts = json.loads((SRC / "executa.json").read_text(encoding="utf-8"))["distribution"]["profiles"]["binary"]["binary_artifacts"]
    for platform, art in arts.items():
        path = SRC / art["path"].replace("{version}", version)
        assert path.exists(), f"missing {path.name} — run scripts/build_binary.py"
        exe = art["entrypoint"]
        with tempfile.TemporaryDirectory() as tmp:
            if art["format"] == "zip":
                with zipfile.ZipFile(path) as z:
                    assert set(z.namelist()) == {"manifest.json", exe}, z.namelist()
                    assert (z.getinfo(exe).external_attr >> 16) & 0o111
                    z.extractall(tmp)
            else:
                with tarfile.open(path) as t:
                    assert set(t.getnames()) == {"manifest.json", exe}, t.getnames()
                    assert t.getmember(exe).mode & 0o111, "executable bit missing"
                    t.extractall(tmp, filter="data")
            m = json.loads((Path(tmp) / "manifest.json").read_text(encoding="utf-8"))
            assert m["version"] == version and m["runtime"]["binary"]["entrypoint"] == exe
            assert m["runtime"]["binary"]["permissions"][exe] == "0o755"
        print(f"archive OK: {path.name}")


def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--binary"); ap.add_argument("--archives", action="store_true"); a = ap.parse_args()
    binary = a.binary
    if not binary:
        out = Path(tempfile.mkdtemp()) / ("kesiel.exe" if sys.platform == "win32" else "kesiel")
        subprocess.run(["go", "build", "-o", str(out), "."], cwd=SRC, check=True)
        binary = str(out)
    test_binary(binary)
    if a.archives:
        test_archives()
    return 0


if __name__ == "__main__":
    sys.exit(main())
