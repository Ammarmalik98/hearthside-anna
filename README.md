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
executas/kesiel/          the backend tool (Go, standard library only → one static binary)
  main.go                 JSON-RPC over stdio; reflect / suggest_prompt / ping; reverse sampling
  manifest.json           what `describe` returns (embedded into the binary; the single source of truth)
  executa.json            local + binary distribution profiles, one archive per platform
  .anna/executa.json      the tool's identity on Anna (written by publish — keep it)
fixtures/llm.jsonl        canned AI replies for offline testing
scripts/                  build_binary.py (builds + packages every platform), test_protocol.py
ci/release-executa.yml    optional GitHub Actions workflow (place in .github/workflows/) that does the same on GitHub
```

## How the AI works

* **Reflections** (after each save, and "Another thought"): the app calls the bundled `kesiel` tool's
  `reflect` method (`anna.tools.invoke`). The tool asks Anna's LLM through reverse sampling, so no API key
  lives anywhere. If the tool isn't installed or allowed yet, the app falls back to `anna.llm.complete`
  with the same prompt. Keep the two prompts in step: `REFLECT_SYSTEM` in `bundle/app.js` and `reflectSystem` in `executas/kesiel/main.go`.
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
python scripts/test_protocol.py --archives     # backend tool protocol + archive test (needs Go)
```

## Publish

1. **Build the tool** (only when it changed): install Go 1.22+ from https://go.dev/dl/, then
   `python scripts/build_binary.py`. Go cross-compiles every platform from your own computer
   (Linux x64/ARM — Anna's Cloud Agent runs Linux — macOS ARM/Intel and Windows x64) into
   `executas/kesiel/dist/`, packaged like Anna's reference apps: `manifest.json` (with `runtime.binary`)
   plus `bin/hearthside-kesiel`. Check them with `python scripts/test_protocol.py --archives`.
   (Or let GitHub do it: put `ci/release-executa.yml` in `.github/workflows/`, run it, and download the
   release files into `executas/kesiel/dist/`.)
2. `anna-app login --host https://anna.partners`, then `anna-app apps publish`.
   This uploads the bundle, publishes the tool and its binaries, writes the real tool id into
   `bundle/anna-tool-ids.js`, and creates the version in `app.json`.
3. Install that version on Anna **on a Cloud Agent, from a fresh install**, and test it end to end.
   Settings → Kesiel → **Kesiel's helper tool** must say **✓ Connected** with the tool's version.
   Then **Submit for review** in the Developer Console.

**Versions.** A published version is frozen. When the tool changes, bump `version` in **both**
`executas/kesiel/manifest.json` and `executas/kesiel/executa.json` (the build script refuses a mismatch),
rebuild, and bump the app's `version` in `app.json` (or use `anna-app apps publish --bump patch`).

## Still to check on Anna's live platform

* **Storage value size**: photos are kept inside each entry (compressed to about 900px). If Anna rejects a
  large entry, the app says so and keeps retrying the rest. A future step could move photos to `anna.files`.
* **Notifications** inside an Anna window may be blocked by the browser. The reminder then shows as an
  in-app banner, and "Add to my calendar" covers the app-closed case.
* **Downloads** (backup, calendar file) use a normal download link. If Anna's window blocks downloads,
  "Copy instead" puts the file's contents on the clipboard.
