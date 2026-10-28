"""Hearthside · Kesiel — the backend tool (Anna Executa) for the Hearthside journal.

Speaks Executa JSON-RPC 2.0 over stdin/stdout (one JSON object per line).
Kesiel's thinking happens on Anna's own LLM through *reverse sampling*: this
process asks the host to run the model (`sampling/createMessage`), so no API
key ever lives here.

Methods exposed through `invoke`:
  reflect        — a short, warm reflection on one journal entry + one follow-up question
  suggest_prompt — a fresh writing prompt shaped by the writer's recent moods/themes
  ping           — smoke test

Rules from the Anna protocol docs that this file follows:
  * stdout carries protocol messages only; logs go to stderr
  * every response is one line of JSON ending in "\n", echoing the request id
  * `describe` returns the manifest directly in `result` (no wrapper), promptly
  * keep reading stdin until it closes

Stdlib only, so it freezes cleanly into a single binary with PyInstaller.
"""

from __future__ import annotations

import json
import re
import sys
import uuid
from typing import Any

VERSION = "0.1.0"

MANIFEST: dict[str, Any] = {
    "display_name": "Kesiel (Hearthside)",
    "version": VERSION,
    "description": "Kesiel, the gentle companion inside the Hearthside journal: reflects on journal entries and suggests writing prompts, using Anna's LLM via reverse sampling.",
    "host_capabilities": ["llm.sample"],
    "credentials": [],
    "runtime": {"type": "binary"},
    "tools": [
        {
            "name": "reflect",
            "description": "Read one journal entry and return a brief, warm reflection plus one open follow-up question to write about next.",
            "parameters": [
                {"name": "text", "type": "string", "description": "The journal entry's plain text.", "required": True},
                {"name": "title", "type": "string", "description": "The entry's title, if any.", "required": False, "default": ""},
                {"name": "mood", "type": "string", "description": "Mood the writer picked (e.g. Good, Low).", "required": False, "default": ""},
                {"name": "name", "type": "string", "description": "What the writer likes to be called.", "required": False, "default": ""},
                {"name": "recent", "type": "string", "description": "Optional short digest of the last few entries, for gentle continuity.", "required": False, "default": ""},
            ],
            "timeout": 60,
        },
        {
            "name": "suggest_prompt",
            "description": "Suggest one fresh journaling prompt shaped by the writer's recent entries (themes and moods).",
            "parameters": [
                {"name": "recent", "type": "string", "description": "Short digest of recent entries (date, title, mood, opening lines).", "required": False, "default": ""},
            ],
            "timeout": 45,
        },
        {
            "name": "ping",
            "description": "Smoke test; returns pong.",
            "parameters": [],
            "timeout": 10,
        },
    ],
}

# Keep in step with REFLECT_SYSTEM in bundle/app.js (the frontend's fallback path).
REFLECT_SYSTEM = (
    "You are Kesiel, the gentle companion who lives in the margins of Hearthside, a private journal. "
    "You have just read one journal entry. Write a brief reflection back to the writer: warm, specific to what "
    "they wrote, never preachy, never diagnosing, no therapy-speak, no exclamation marks. Notice one concrete "
    "detail and gently name a feeling or pattern you see. Then offer ONE open question they could write about next.\n"
    "Rules: 2-4 sentences for the reflection (under 70 words). The question under 20 words. Write in the same "
    "language as the entry. If the entry mentions self-harm or being in danger, kindly encourage reaching out to "
    "someone they trust or local emergency services.\n"
    'Reply ONLY with JSON: {"reflection": "...", "prompt": "..."}'
)

PROMPT_SYSTEM = (
    "You are Kesiel, the gentle companion inside Hearthside, a private journal. Suggest ONE journaling prompt "
    "for today: open-ended, concrete, kind, under 20 words, no exclamation marks. If recent entries are given, "
    "let their themes or moods shape it gently without quoting them. Reply ONLY with JSON: {\"prompt\": \"...\"}"
)

MAX_TEXT = 6000


def log(*parts: Any) -> None:
    print("[kesiel]", *parts, file=sys.stderr, flush=True)


def _write(envelope: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(envelope, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _request_sampling(system: str, user: str, max_tokens: int = 400, temperature: float = 0.7) -> str:
    """Reverse-RPC `sampling/createMessage` to the Anna host; blocks until the reply arrives."""
    rid = str(uuid.uuid4())
    _write({
        "jsonrpc": "2.0",
        "id": rid,
        "method": "sampling/createMessage",
        "params": {
            "messages": [{"role": "user", "content": {"type": "text", "text": user}}],
            "systemPrompt": system,
            "maxTokens": max_tokens,
            "temperature": temperature,
        },
    })
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            env = json.loads(line)
        except json.JSONDecodeError:
            log("ignoring non-JSON line while waiting for sampling")
            continue
        if env.get("id") == rid and "method" not in env:
            if "error" in env:
                err = env["error"] or {}
                raise RuntimeError(f"{err.get('code', '')} {err.get('message', 'sampling failed')}".strip())
            result = env.get("result") or {}
            content = result.get("content") or {}
            if isinstance(content, list):
                return "".join(c.get("text", "") for c in content if isinstance(c, dict))
            return str(content.get("text", "")) if isinstance(content, dict) else str(content)
        _dispatch(env)  # some other request arrived meanwhile — handle it inline
    raise RuntimeError("stdin closed before the sampling reply arrived")


def _parse_json_reply(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        try:
            obj = json.loads(m.group(0))
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
    return {"reflection": text.strip("\"'` \n")} if text else {}


def _clip(value: Any, n: int) -> str:
    return str(value or "").strip()[:n]


def reflect(args: dict[str, Any]) -> dict[str, Any]:
    text = _clip(args.get("text"), MAX_TEXT)
    if len(text.split()) < 5:
        return {"success": False, "error": "text is too short to reflect on"}
    name = _clip(args.get("name"), 40)
    user = (
        (f"Writer's name: {name}\n" if name else "")
        + f"Entry title: {_clip(args.get('title'), 120) or 'Untitled'}\n"
        + f"Mood they picked: {_clip(args.get('mood'), 20) or 'not set'}\n\n"
        + f"Entry:\n{text}"
    )
    recent = _clip(args.get("recent"), 1200)
    if recent:
        user += f"\n\n(For gentle continuity only — their last few entries:)\n{recent}"
    raw = _request_sampling(REFLECT_SYSTEM, user, max_tokens=400)
    obj = _parse_json_reply(raw)
    reflection = _clip(obj.get("reflection"), 900)
    if not reflection:
        return {"success": False, "error": "the model returned an empty reflection"}
    return {"success": True, "data": {"reflection": reflection, "prompt": _clip(obj.get("prompt"), 200)}}


def suggest_prompt(args: dict[str, Any]) -> dict[str, Any]:
    recent = _clip(args.get("recent"), 1500)
    raw = _request_sampling(PROMPT_SYSTEM, recent or "(no recent entries)", max_tokens=120, temperature=0.9)
    obj = _parse_json_reply(raw)
    prompt = _clip(obj.get("prompt") or obj.get("reflection"), 200)
    if not prompt:
        return {"success": False, "error": "the model returned an empty prompt"}
    return {"success": True, "data": {"prompt": prompt}}


def invoke(method: str, args: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(args, dict):
        args = {}
    try:
        if method == "ping":
            return {"success": True, "data": {"pong": True, "version": VERSION}}
        if method == "reflect":
            return reflect(args)
        if method == "suggest_prompt":
            return suggest_prompt(args)
    except Exception as e:  # noqa: BLE001 — report, never crash the process
        log("invoke failed:", method, repr(e))
        return {"success": False, "error": f"{method} failed: {e}"}
    return {"success": False, "error": f"unknown method: {method}"}


def _dispatch(env: dict[str, Any]) -> None:
    method = env.get("method")
    rid = env.get("id")
    if method is None:  # a stray response — nothing to do
        return
    try:
        if method == "initialize":
            result = {
                "protocolVersion": "2.0",
                "server_info": {"name": MANIFEST["display_name"], "version": VERSION},
                "capabilities": {"sampling": {}},
            }
        elif method == "describe":
            result = MANIFEST
        elif method == "health":
            result = {"status": "ready", "version": VERSION}
        elif method == "invoke":
            params = env.get("params") or {}
            tool = params.get("tool") or params.get("method") or params.get("name") or ""
            arguments = params.get("arguments") or params.get("args") or {}
            result = invoke(tool, arguments)
        elif isinstance(method, str) and method.startswith("notifications/"):
            return  # JSON-RPC notifications get no reply
        else:
            raise ValueError(f"unknown rpc: {method}")
        if rid is not None:
            _write({"jsonrpc": "2.0", "id": rid, "result": result})
    except Exception as e:  # noqa: BLE001
        if rid is not None:
            _write({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": str(e)}})


def main() -> None:
    log(f"Kesiel {VERSION} ready")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            env = json.loads(line)
        except json.JSONDecodeError:
            log("ignoring non-JSON line")
            continue
        _dispatch(env)


if __name__ == "__main__":
    main()
