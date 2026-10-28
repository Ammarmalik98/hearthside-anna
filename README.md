# Hearthside — Anna Edition

A warm, distraction-free journal for the Anna AI OS. Kesiel, the companion, reflects on every entry you save,
suggests prompts shaped by your recent pages, and answers questions about anything you've written, all on
Anna's built-in AI. The journal is saved to the user's Anna account.

## What's in this folder

```
app.json                  store listing: name, description, logo, bundled backend tool
manifest.json             window, permissions, Host APIs (storage, llm, tools), CSP overrides
bundle/                   the app itself (what Anna shows in its window)
  index.html              markup only: no inline scripts or styles (Anna's CSP blocks them)
  style.css               all styling, fonts served from bundle/fonts
  app.js                  all behaviour (ES module; loads Anna's SDK at runtime)
  anna-tool-ids.js        placeholder; `anna-app dev` / `apps publish` overwrite it
  img/, fonts/            Kesiel art, app icon, self-hosted fonts (OFL, see fonts/LICENSE.txt)
assets/                   store artwork: hearthside-icon-512.png (logo_file), 1024px copy
executas/kesiel/          the backend tool (Python, stdlib only)
  hearthside_kesiel_plugin.py   JSON-RPC over stdio; reflect / suggest_prompt / ping
  manifest.json           what `describe` returns (kept identical, checked by the tests)
  executa.json            local + binary distribution profiles
fixtures/llm.jsonl        canned AI replies for offline testing
scripts/                  build_binary.py, test_protocol.py, fetch_binaries.py
ci/release-executa.yml    GitHub Actions workflow (move to .github/workflows/) that builds the tool for all four platforms
```

## How the AI works

* **Reflections** (after each save, and "Another thought"): the app calls the bundled `kesiel` tool's
  `reflect` method (`anna.tools.invoke`). The tool asks Anna's LLM through reverse sampling, so no API key
  lives anywhere. If the tool isn't installed or allowed yet, the app falls back to `anna.llm.complete`
  with the same prompt. Keep the two prompts in step: `REFLECT_SYSTEM` in `bundle/app.js` and in the plugin.
* **✦ prompt button**: `suggest_prompt` on the tool, with the same fallback.
* **Ask Kesiel chat**: `anna.llm.stream` (word-by-word), falling back to `anna.llm.complete`.

## How storage works

`anna.storage` keys, all under `hearthside/`:

| key | value |
| --- | --- |
| `settings` | theme, fonts, name, reminder, lock hash, reflect toggle |
| `index` | `{ v: 1, items: { <entryId>: updatedAt } }` |
| `e/<entryId>` | one entry (HTML, text, mood, tags, Kesiel's reflection) |

Entries are written one at a time with a retry queue. When the window comes back into view, entries
changed on another device are pulled in. Outside Anna (opening `bundle/index.html` from a plain web server)
the same code uses the browser's localStorage, so you can preview the UI without Anna.
Users of the earlier single-file Hearthside move their journal with **Download backup**, then **Restore** here.

## Test locally

```bash
npm i -g @anna-ai/cli          # needs Node 22+ and uv
anna-app validate --strict
anna-app dev --mock-llm fixtures/llm.jsonl     # offline, canned AI replies → http://localhost:5180/
anna-app login --host https://anna.partners    # then, for real AI:
anna-app dev --storage aps                     # real Anna storage + LLM on your account
python scripts/test_protocol.py                # backend tool protocol test
```

## Publish

1. Put this folder in a GitHub repository (the `.gitignore` keeps build output out), and move
   `ci/release-executa.yml` to `.github/workflows/release-executa.yml` so GitHub Actions picks it up.
2. Actions tab → **Release Kesiel Executa binaries** → Run workflow (tag `kesiel-v0.1.0`).
   It builds Linux x64 (Anna's cloud agent), macOS arm64/x64 and Windows x64, runs the protocol test on each,
   and attaches them to a GitHub Release.
3. `python scripts/fetch_binaries.py --repo <you>/<repo>` downloads them into `executas/kesiel/dist/`.
4. `anna-app login --host https://anna.partners`, then `anna-app apps publish`.
   This uploads the bundle, publishes the tool and its binaries, writes the real tool id into
   `bundle/anna-tool-ids.js`, and creates a version.
5. Install that version on Anna and test it, including the cloud agent (Linux). Then **Submit for review**
   in the Developer Console and **Release** once it's approved.

When you change the tool, bump `version` in `executas/kesiel/executa.json` **and** the plugin's `VERSION`.
Run `python -c "import json,sys; sys.path.insert(0,'executas/kesiel'); import hearthside_kesiel_plugin as k; json.dump(k.MANIFEST, open('executas/kesiel/manifest.json','w'), indent=2, ensure_ascii=False)"`
to regenerate its manifest, then release with a matching `kesiel-v<version>` tag.

## Still to check on Anna's live platform

* **Storage value size**: photos are kept inside each entry (compressed to about 900px). If Anna rejects a
  large entry, the app says so and keeps retrying the rest. A future step could move photos to `anna.files`.
* **Notifications** inside an Anna window may be blocked by the browser. The reminder then shows as an
  in-app banner, and "Add to my calendar" covers the app-closed case.
* **Downloads** (backup, calendar file) use a normal download link. If Anna's window blocks downloads,
  "Copy instead" puts the file's contents on the clipboard.
