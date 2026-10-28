#!/usr/bin/env python3
"""Protocol smoke test for the Kesiel Executa (source or built binary).

  python scripts/test_protocol.py                                   # runs the Python source
  python scripts/test_protocol.py --binary executas/kesiel/dist/linux-x86_64/bin/hearthside-kesiel

Plays the Anna host: sends initialize / describe / invoke(ping) / invoke(reflect), answers the
tool's reverse `sampling/createMessage` with a canned reply, and checks the Anna rules:
one JSON object per stdout line, ids echoed, describe result unwrapped, the process keeps
reading stdin after replying, and describe matches executas/kesiel/manifest.json.
"""
from __future__ import annotations

import argparse, json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "executas" / "kesiel" / "hearthside_kesiel_plugin.py"
CANNED = {"role": "assistant", "content": {"type": "text", "text": '{"reflection": "A quiet, golden morning that left you feeling known.", "prompt": "Who else makes you feel known?"}'}, "model": "test", "stopReason": "endTurn"}


def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--binary"); a = ap.parse_args()
    cmd = [a.binary] if a.binary else [sys.executable, str(SRC)]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")

    def send(obj):
        p.stdin.write(json.dumps(obj) + "\n"); p.stdin.flush()

    def recv():
        line = p.stdout.readline()
        assert line.endswith("\n"), f"response must end with a newline: {line!r}"
        return json.loads(line)

    send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    r = recv(); assert r["id"] == 1 and "capabilities" in r["result"], r
    send({"jsonrpc": "2.0", "id": 2, "method": "describe"})
    r = recv(); assert r["id"] == 2, r
    d = r["result"]; assert "manifest" not in d and "success" not in d, "describe must not be wrapped"
    assert d == json.loads((ROOT / "executas" / "kesiel" / "manifest.json").read_text(encoding="utf-8")), "describe differs from manifest.json"
    for t in d["tools"]:
        assert isinstance(t["parameters"], list)
        for prm in t["parameters"]:
            assert prm["type"] in {"string", "integer", "number", "boolean", "array", "object"}, prm
    send({"jsonrpc": "2.0", "id": 3, "method": "invoke", "params": {"tool": "ping", "arguments": {}}})
    r = recv(); assert r["id"] == 3 and r["result"]["success"] and r["result"]["data"]["pong"], r
    send({"jsonrpc": "2.0", "id": 4, "method": "invoke", "params": {"tool": "reflect", "arguments": {"text": "Walked to the market. The light was golden and the mango lady remembered my name.", "mood": "Good"}}})
    sreq = recv(); assert sreq.get("method") == "sampling/createMessage", sreq
    assert sreq["params"]["messages"][0]["content"]["type"] == "text"
    send({"jsonrpc": "2.0", "id": sreq["id"], "result": CANNED})
    r = recv(); assert r["id"] == 4 and r["result"]["success"], r
    assert r["result"]["data"]["reflection"] and r["result"]["data"]["prompt"], r
    send({"jsonrpc": "2.0", "id": 5, "method": "health"})
    r = recv(); assert r["id"] == 5 and r["result"]["status"] == "ready", r   # still alive after replying
    p.stdin.close(); p.wait(timeout=10)
    print("protocol OK:", " ".join(cmd))
    return 0


if __name__ == "__main__":
    sys.exit(main())
