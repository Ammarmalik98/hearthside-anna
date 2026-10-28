
/* Hearthside — Anna Edition.
   Runs inside an Anna window: Kesiel thinks with Anna's built-in AI (anna.llm + the bundled
   "kesiel" Executa) and the journal is saved to the user's Anna account (anna.storage).
   Opened outside Anna (a plain browser preview), it falls back to this browser's storage and
   Kesiel stays quiet. Everything is CSP-safe: no inline scripts, no inline style attributes. */

const SDK_URL = "/static/anna-apps/_sdk/latest/index.js";
const KESIEL_HANDLE = "kesiel";                       // app.json bundled_executas handle
const KESIEL_DEV_TOOL = "tool-dev-hearthside-kesiel"; // only used if anna-tool-ids.js is missing
const KESIEL_TOOL = () => (window.__ANNA_TOOL_IDS__ || {})[KESIEL_HANDLE] || KESIEL_DEV_TOOL;

const KESIEL_BODY = "./img/kesiel-body.webp";
const KESIEL_HEAD = "./img/kesiel-head.webp";
const APP_ICON_PNG = new URL("./img/icon-180.png", location.href).href; // absolute: notifications need it

let anna = null;          // Anna runtime (null in a plain browser preview)

/* ============ tiny helpers ============ */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const todayKey = () => new Date().toLocaleDateString("en-CA");
const keyOf = d => d.toLocaleDateString("en-CA");
const fmtDate = k => new Date(k + "T12:00:00").toLocaleDateString(undefined, {weekday:"short", year:"numeric", month:"short", day:"numeric"});
const fmtShort = k => new Date(k + "T12:00:00").toLocaleDateString(undefined, {month:"short", day:"numeric"});
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const MOODS = {5:{e:"😄",n:"Wonderful"},4:{e:"🙂",n:"Good"},3:{e:"😐",n:"Okay"},2:{e:"😔",n:"Low"},1:{e:"😢",n:"Rough"}};

function toast(msg){ const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2600); }

let confirmCb = null;
function askConfirm(title, text, cb){ $("#cTitle").textContent = title; $("#cText").textContent = text; confirmCb = cb; $("#confirmOverlay").hidden = false; }
$("#cNo").onclick = () => { $("#confirmOverlay").hidden = true; confirmCb = null; };
$("#cYes").onclick = () => { $("#confirmOverlay").hidden = true; const cb = confirmCb; confirmCb = null; cb && cb(); };

/* hex blend for chart ramps */
function hx(c){ c = c.trim().replace("#",""); if(c.length===3) c = c.split("").map(x=>x+x).join(""); return [parseInt(c.slice(0,2),16), parseInt(c.slice(2,4),16), parseInt(c.slice(4,6),16)]; }
function blend(a, b, t){ const A = hx(a), B = hx(b); return "#" + A.map((v,i) => Math.round(v + (B[i]-v)*t).toString(16).padStart(2,"0")).join(""); }
function lum(c){ const [r,g,b] = hx(c); return (0.299*r + 0.587*g + 0.114*b)/255; }
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ============ state & storage ============ */
let S = { entries: [], settings: {} };
const DEF_SET = { theme:"system", paper:"lined", font:"serif", name:"", passHash:"", passHint:"", seeded:false, setupDone:false,
  reflect:true, remindLast:"", remindSnooze:0 };
const DEF_REMIND = { on:false, time:"21:00", days:[0,1,2,3,4,5,6], skip:true };

/* Two interchangeable stores with one tiny async API: get / set / del / keys.
   Layout:  settings        → one document
            index           → { v:1, items: { <entryId>: updatedAt } }
            e/<entryId>     → one document per entry (photos stay inside the entry)   */
const PREFIX = "hearthside/";
function annaStore(rt){
  const k = key => PREFIX + key;
  return {
    kind: "anna",
    async get(key){ const r = await rt.storage.get({ key: k(key) }); return r && r.exists !== false && r.value !== undefined ? r.value : null; },
    async set(key, value){ await rt.storage.set({ key: k(key), value }); },
    async del(key){ try { await rt.storage.delete({ key: k(key) }); } catch(e){ if (!/not.?found|404/i.test(String(e && (e.code || e.message)))) throw e; } },
    async keys(prefix){           // best effort; null when list isn't available
      try {
        const out = []; let cursor;
        for (let page = 0; page < 50; page++){
          const r = await rt.storage.list({ prefix: k(prefix), limit: 200, ...(cursor ? { cursor } : {}) });
          const items = (r && (r.items || r.keys || r.entries)) || [];
          items.forEach(it => { const kk = typeof it === "string" ? it : it && it.key; if (kk) out.push(kk.slice(PREFIX.length)); });
          cursor = r && (r.next_cursor || r.cursor || r.nextCursor);
          if (!cursor || !items.length) break;
        }
        return out;
      } catch(e){ return null; }
    }
  };
}
const localStore = {
  kind: "local",
  async get(key){ try { const v = localStorage.getItem(PREFIX + key); return v == null ? null : JSON.parse(v); } catch(e){ return null; } },
  async set(key, value){
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); }
    catch(e){ const err = new Error("quota"); err.code = "quota"; throw err; }
  },
  async del(key){ try { localStorage.removeItem(PREFIX + key); } catch(e){} },
  async keys(prefix){ try { return Object.keys(localStorage).filter(k => k.startsWith(PREFIX + prefix)).map(k => k.slice(PREFIX.length)); } catch(e){ return []; } }
};
let store = localStore;

function normalizeSettings(raw){
  const s = Object.assign({}, DEF_SET, raw && typeof raw === "object" ? raw : {});
  const r = s.remind && typeof s.remind === "object" ? s.remind : {};
  s.remind = Object.assign({}, DEF_REMIND, r, { days: Array.isArray(r.days) ? r.days.filter(d => d >= 0 && d <= 6) : DEF_REMIND.days.slice() });
  if (!/^\d{2}:\d{2}$/.test(s.remind.time)) s.remind.time = DEF_REMIND.time;
  delete s.sync; delete s.lastSync;
  return s;
}
let INDEX = {};   // id → updatedAt, mirrors the stored index document
async function inBatches(list, n, fn){ const out = []; for (let i = 0; i < list.length; i += n) out.push(...await Promise.all(list.slice(i, i + n).map(fn))); return out; }

async function loadState(){
  S.settings = normalizeSettings(await store.get("settings"));
  const idx = await store.get("index");
  INDEX = (idx && idx.items && typeof idx.items === "object") ? { ...idx.items } : {};
  const listed = await store.keys("e/");
  if (listed) listed.forEach(k => { const id = k.slice(2); if (!(id in INDEX)) INDEX[id] = 0; });
  const docs = await inBatches(Object.keys(INDEX), 8, id => store.get("e/" + id).catch(() => null));
  S.entries = docs.filter(d => d && d.id && typeof d.date === "string");
  if (store.kind === "local" && !S.entries.length) await importLegacyLocal();
}
/* The pre-Anna single-file Hearthside kept everything under two localStorage keys. */
async function importLegacyLocal(){
  try {
    const es = JSON.parse(localStorage.getItem("hearthside.entries.v1") || "null");
    const st = JSON.parse(localStorage.getItem("hearthside.settings.v1") || "null");
    if (!Array.isArray(es) || !es.length) return;
    S.entries = es; if (st) S.settings = normalizeSettings(st);
    for (const e of es) await writeEntry(e, true);
    await writeIndex(); await saveSettingsNow();
  } catch(e){}
}

/* ---- writes: per entry, with a small retry queue so nothing is lost on a hiccup ---- */
const pendingWrites = new Map();   // id → entry
let retryTimer = null, saveState = "idle";
function setSaveState(st){
  saveState = st;
  const el = $("#edStatus");
  if (st === "saving") el.textContent = "Saving…";
  else if (st === "saved"){ el.textContent = "Saved ✓"; clearTimeout(el._t); el._t = setTimeout(() => { if (saveState === "saved") el.textContent = ""; }, 2200); }
  else if (st === "retry") el.textContent = "Not saved yet — retrying…";
  else if (st === "toobig") el.textContent = "Too large to save — try a smaller photo";
}
async function writeEntry(e, quiet){
  try {
    await store.set("e/" + e.id, entryDoc(e));
    INDEX[e.id] = e.updatedAt || Date.now();
    pendingWrites.delete(e.id);
    if (!quiet) setSaveState(pendingWrites.size ? "retry" : "saved");
    return true;
  } catch(err){
    const msg = String(err && (err.code || err.message) || "");
    if (/quota|too.?large|413|size/i.test(msg)){ setSaveState("toobig"); toast("That entry is too big to save — photos take the most room. Try removing one."); return false; }
    pendingWrites.set(e.id, e); setSaveState("retry");
    clearTimeout(retryTimer); retryTimer = setTimeout(flushPending, 4000);
    return false;
  }
}
async function flushPending(){ for (const e of [...pendingWrites.values()]) await writeEntry(e); if (!pendingWrites.size) writeIndexSoon(); }
async function writeIndex(){ try { await store.set("index", { v:1, items: INDEX }); } catch(e){} }
const writeIndexSoon = debounce(writeIndex, 1200);
function saveEntry(e){ setSaveState("saving"); return writeEntry(e).then(ok => { if (ok) writeIndexSoon(); return ok; }); }
async function saveSettingsNow(){ try { await store.set("settings", S.settings); } catch(e){} }
const saveSettings = debounce(saveSettingsNow, 500);
function entryDoc(e){
  const d = { id: e.id, date: e.date, createdAt: e.createdAt, updatedAt: e.updatedAt, title: e.title || "",
    html: e.html || "", text: (e.text || "").slice(0, 30000), words: e.words || 0, mood: e.mood || 0, tags: e.tags || [], del: !!e.del };
  if (e.seed) d.seed = true;
  if (e.reflection) d.reflection = e.reflection;
  return d;
}
const alive = () => S.entries.filter(e => !e.del);

/* Pick up entries written on another device when the window comes back into view. */
let lastRefresh = Date.now();
async function refreshFromStore(){
  if (store.kind !== "anna" || Date.now() - lastRefresh < 45000) return;
  lastRefresh = Date.now();
  try {
    const idx = await store.get("index"); if (!idx || !idx.items) return;
    const changed = Object.entries(idx.items).filter(([id, t]) => {
      const loc = S.entries.find(x => x.id === id);
      return !loc || (t || 0) > (loc.updatedAt || 0);
    }).map(([id]) => id);
    if (!changed.length) return;
    const docs = await inBatches(changed, 8, id => store.get("e/" + id).catch(() => null));
    docs.forEach(d => {
      if (!d || !d.id) return;
      if (d.id === curId) return;   // never yank the page you're typing on
      const loc = S.entries.find(x => x.id === d.id);
      if (loc) Object.assign(loc, d); else S.entries.push(d);
      INDEX[d.id] = d.updatedAt || 0;
    });
    renderEntries(); renderStats(false); $("#navCount").textContent = alive().length;
  } catch(e){}
}

/* ============ first run ============ */
function seedWelcome(){
  if (S.settings.seeded || S.entries.length) return;
  const k = todayKey();
  const html = `<p>Hello! I'm <b>Kesiel</b> — I live in the margins of this journal. A few things worth knowing about our little nook:</p><ul><li>Write with <b>bold</b>, <i>italics</i>, <mark>highlights</mark>, lists and quotes — the toolbar above has everything.</li><li>Tap the 📷 icon to tuck photos between your words.</li><li>Pick a <b>mood</b> for each entry and I'll chart how the seasons of you drift by.</li><li>Prefer dotted pages? A darker room? It's all in <b>Settings</b> — along with a password lock and backups.</li><li>And if you ever lose track of an entry, just <b>ask me</b>. I've read every page.</li></ul><blockquote>The habit isn't writing well. The habit is showing up.</blockquote><p>Delete this note whenever you like. I'll be by the fire. 🕯️</p>`;
  S.entries.push({ id: uid(), date: k, createdAt: Date.now(), updatedAt: Date.now(), title: "A welcome note from Kesiel", html, text: stripHtml(html), words: countWords(stripHtml(html)), mood: 4, tags: ["welcome"], del: false, seed: true });
  S.settings.seeded = true;
  saveEntry(S.entries[S.entries.length - 1]); saveSettings();
}

/* ============ sanitizer ============ */
const OK_TAGS = new Set(["P","DIV","BR","B","STRONG","I","EM","U","S","STRIKE","H2","H3","BLOCKQUOTE","UL","OL","LI","MARK","SPAN","IMG","A","FONT"]);
function sanitizeHtml(dirty){
  const tpl = document.createElement("template"); tpl.innerHTML = dirty;
  (function walk(node){
    [...node.children].forEach(el => {
      if (!OK_TAGS.has(el.tagName)) { el.replaceWith(...el.childNodes); walk(node); return; }
      [...el.attributes].forEach(a => {
        const n = a.name.toLowerCase();
        if (n === "src" && el.tagName === "IMG" && a.value.startsWith("data:image/")) return;
        if (n === "href" && el.tagName === "A" && /^https?:/i.test(a.value)) { el.setAttribute("rel","noopener"); el.setAttribute("target","_blank"); return; }
        if (n === "style") {
          const bg = el.style.backgroundColor;
          el.removeAttribute("style");
          if (bg && el.tagName === "SPAN") { const m = document.createElement("mark"); m.innerHTML = el.innerHTML; el.replaceWith(m); }
          return;
        }
        el.removeAttribute(a.name);
      });
      if (el.tagName === "FONT") { el.replaceWith(...el.childNodes); walk(node); return; }
      walk(el);
    });
  })(tpl.content);
  return tpl.innerHTML;
}
function stripHtml(h){ const d = document.createElement("div"); d.innerHTML = h; return (d.innerText || "").replace(/\s+/g, " ").trim(); }
function countWords(t){ return t ? (t.match(/\S+/g) || []).length : 0; }

/* ============ theme / appearance ============ */
let hostTheme = null;   // "light" | "dark" from the Anna dashboard, when running inside Anna
function applyTheme(){
  const t = S.settings.theme;
  const eff = (t === "light" || t === "dark") ? t : hostTheme;
  if (eff) document.documentElement.setAttribute("data-theme", eff);
  else document.documentElement.removeAttribute("data-theme");
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.content = cssVar("--bg") || "#F1EEE3";
  $$("#themeOpts .opt").forEach(b => b.classList.toggle("on", b.dataset.v === t));
  requestAnimationFrame(() => renderStats(true));
}
function applyPaperFont(){
  const card = $("#editorCard");
  card.className = "card editorcard paper-" + S.settings.paper + " font-" + S.settings.font;
  $$("#paperOpts .opt").forEach(b => b.classList.toggle("on", b.dataset.v === S.settings.paper));
  $$("#fontOpts .opt").forEach(b => b.classList.toggle("on", b.dataset.v === S.settings.font));
}
$("#themeOpts").onclick = e => { const b = e.target.closest(".opt"); if (!b) return; S.settings.theme = b.dataset.v; saveSettings(); applyTheme(); };
$("#paperOpts").onclick = e => { const b = e.target.closest(".opt"); if (!b) return; S.settings.paper = b.dataset.v; saveSettings(); applyPaperFont(); };
$("#fontOpts").onclick = e => { const b = e.target.closest(".opt"); if (!b) return; S.settings.font = b.dataset.v; saveSettings(); applyPaperFont(); };
$("#themeQuick").onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  S.settings.theme = cur === "dark" ? "light" : "dark"; saveSettings(); applyTheme();
};
$("#setName").onchange = e => { S.settings.name = e.target.value.trim(); saveSettings(); greet(); };

/* ============ navigation ============ */
let VIEW = "write";
function goView(v){
  if (v !== "write" && document.body.classList.contains("focus")) setFocus(false);
  VIEW = v;
  ["write","entries","calendar","stats","kesiel","settings"].forEach(x => { $("#view-" + x).hidden = x !== v; });
  $$("#nav button, #bottomnav button").forEach(b => b.classList.toggle("on", b.dataset.view === v));
  if (v === "entries") renderEntries();
  if (v === "calendar") renderCalendar();
  if (v === "stats") renderStats(true);
  if (v === "settings") renderSettings();
  window.scrollTo({top:0});
}
$("#nav").onclick = $("#bottomnav").onclick = e => { const b = e.target.closest("button[data-view]"); if (b) goView(b.dataset.view); };

/* ============ greeting & prompts ============ */
const PROMPTS = [
  "What made today feel different from yesterday?",
  "Describe a small kindness you noticed recently.",
  "What's something you're quietly proud of this week?",
  "If today had a soundtrack, what would be playing?",
  "What's been sitting in the back of your mind lately?",
  "Write about a smell or taste that brought back a memory.",
  "What would you tell yourself from one year ago?",
  "What drained you today — and what refilled you?",
  "Describe your day as if it were weather.",
  "What's one tiny thing you want to remember about this week?",
  "Who did you think about today, and why?",
  "What are you looking forward to, even a little?",
  "Write about a place where you feel completely at ease.",
  "What did you almost say out loud today?",
  "What's a worry you could set down, just for tonight?",
  "Describe the last thing that made you laugh properly.",
  "What does 'rest' look like for you right now?",
  "Write a letter to your future self reading this in December.",
  "What habit is quietly shaping your days?",
  "What did you learn about yourself this month?",
  "If your energy was a candle today, how did it burn?",
  "What's something ordinary that felt beautiful recently?",
  "What conversation do you keep replaying?",
  "Name three textures, two sounds, and one feeling from today."
];
let promptIx = Math.floor(Math.random() * PROMPTS.length);
function showPrompt(){ $("#promptText").textContent = PROMPTS[promptIx % PROMPTS.length]; }
$("#newPrompt").onclick = () => { promptIx++; showPrompt(); };
$("#usePrompt").onclick = () => {
  const p = $("#promptText").textContent;
  const bq = document.createElement("blockquote"); bq.textContent = p;
  $("#edBody").prepend(bq); $("#edBody").focus(); scheduleAutosave(); updateWc();
};
function greet(){
  const h = new Date().getHours(); const n = S.settings.name || "friend";
  let g = "Good evening", s = "The kettle's on. What's on your mind?";
  if (h >= 5 && h < 12) { g = "Good morning"; s = "New page, fresh ink. How did you wake up?"; }
  else if (h >= 12 && h < 17) { g = "Good afternoon"; s = "A pause in the day — perfect time for a few lines."; }
  else if (h >= 22 || h < 5) { g = "Hello, Night Owl"; s = "The house is quiet. The page is listening."; }
  $("#greet").textContent = `${g}, ${n}.`; $("#greetSub").textContent = s;
}

/* ============ editor ============ */
let curId = null;      // entry being edited (null = fresh unsaved)
let savedRange = null;
const edBody = $("#edBody");

function newEntry(){
  curId = null;
  $("#edTitle").value = ""; edBody.innerHTML = ""; $("#edTags").value = "";
  $$(".mood").forEach(m => m.classList.remove("on"));
  $("#edDate").textContent = fmtDate(todayKey());
  $("#edStatus").textContent = ""; updateWc();
  hideReflection();
}
function loadEntry(id){
  const e = S.entries.find(x => x.id === id); if (!e) return;
  curId = id;
  $("#edTitle").value = e.title; edBody.innerHTML = e.html; $("#edTags").value = (e.tags || []).join(", ");
  $$(".mood").forEach(m => m.classList.toggle("on", +m.dataset.m === e.mood));
  $("#edDate").textContent = fmtDate(e.date);
  $("#edStatus").textContent = ""; updateWc();
  if (e.reflection) showReflection(e.reflection, e.id); else hideReflection();
  goView("write"); edBody.focus();
}
function currentMood(){ const b = $(".mood.on"); return b ? +b.dataset.m : 0; }
function parseTags(){ return $("#edTags").value.split(",").map(t => t.trim().toLowerCase()).filter(Boolean).slice(0, 8); }

function persistCurrent(silent){
  const html = sanitizeHtml(edBody.innerHTML);
  const text = stripHtml(html);
  const title = $("#edTitle").value.trim();
  if (!text && !title && !html.includes("<img")) return false;
  const now = Date.now();
  let e = curId && S.entries.find(x => x.id === curId);
  if (!e) { e = { id: uid(), date: todayKey(), createdAt: now, del: false }; S.entries.push(e); curId = e.id; }
  Object.assign(e, { updatedAt: now, title, html, text: text.slice(0, 30000), words: countWords(text), mood: currentMood(), tags: parseTags() });
  saveEntry(e);
  $("#navCount").textContent = alive().length;
  updateTodayCandle(true);
  return e;
}
const scheduleAutosave = debounce(() => persistCurrent(true), 900);
function updateWc(){ $("#edWords").textContent = countWords(stripHtml(edBody.innerHTML)) + " words"; }

/* Keep the caret in view while writing: as the entry grows past the bottom of the
   window, nudge the page so the line being typed stays visible (and stays clear of
   the floating toolbar when moving upward). */
function caretRect(){
  const s = getSelection(); if (!s.rangeCount || !edBody.contains(s.anchorNode)) return null;
  const r = s.getRangeAt(0).cloneRange(); r.collapse(false);
  let rect = r.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)){
    // empty line / fresh block: measure a temporary marker instead
    const m = document.createElement("span"); m.textContent = "​";
    r.insertNode(m); rect = m.getBoundingClientRect(); m.remove();
    s.removeAllRanges(); s.addRange(r);
  }
  return rect;
}
function keepCaretVisible(){
  const rect = caretRect(); if (!rect) return;
  const tb = $("#toolbar").getBoundingClientRect();
  const bottomNav = $("#bottomnav"); const navH = bottomNav && getComputedStyle(bottomNav).display !== "none" ? bottomNav.offsetHeight : 0;
  const topLimit = tb.bottom + 24;                 // just below the floating toolbar
  const bottomLimit = innerHeight - navH - 72;     // comfortable margin above the bottom edge
  if (rect.bottom > bottomLimit) scrollBy({top: rect.bottom - bottomLimit, behavior: "instant"});
  else if (rect.top < topLimit) scrollBy({top: rect.top - topLimit, behavior: "instant"});
}
edBody.addEventListener("input", () => { updateWc(); scheduleAutosave(); requestAnimationFrame(keepCaretVisible); });
edBody.addEventListener("keyup", e => { if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Enter","Home","End","PageUp","PageDown"].includes(e.key)) keepCaretVisible(); });
$("#edTitle").addEventListener("input", scheduleAutosave);
$("#edTags").addEventListener("input", scheduleAutosave);
edBody.addEventListener("blur", () => { const s = getSelection(); if (s.rangeCount) savedRange = s.getRangeAt(0).cloneRange(); });
$("#moodRow").onclick = e => {
  const b = e.target.closest(".mood"); if (!b) return;
  const was = b.classList.contains("on");
  $$(".mood").forEach(m => m.classList.remove("on"));
  if (!was) b.classList.add("on");
  scheduleAutosave();
};
$("#saveEntry").onclick = () => {
  const wasLit = wroteToday();
  const e = persistCurrent(false);
  if (!e) return toast("Write a little something first.");
  toast(wasLit ? "Entry saved. Kesiel filed it away. 🕯️" : "Entry saved, and today's candle is lit. 🕯️");
  renderEntries();
  if (S.settings.reflect) reflectOn(e, false);
};
$("#newEntry").onclick = () => { persistCurrent(true); newEntry(); edBody.focus(); };

/* toolbar */
$("#toolbar").addEventListener("mousedown", e => e.preventDefault()); // keep selection
$("#toolbar").addEventListener("click", e => {
  const b = e.target.closest(".tb"); if (!b) return;
  edBody.focus();
  if (b.dataset.cmd) document.execCommand(b.dataset.cmd, false, null);
  else if (b.dataset.block) {
    const cur = (document.queryCommandValue("formatBlock") || "").toLowerCase();
    document.execCommand("formatBlock", false, cur === b.dataset.block ? "p" : b.dataset.block);
  }
  else if (b.hasAttribute("data-hl")) toggleHighlight();
  else if (b.hasAttribute("data-clear")) { document.execCommand("removeFormat", false, null); document.execCommand("formatBlock", false, "p"); }
  updateWc(); scheduleAutosave();
});

/* Highlight with real <mark> elements: execCommand("hiliteColor") writes style="" attributes,
   which Anna's content-security policy refuses. */
function toggleHighlight(){
  const sel = getSelection(); if (!sel.rangeCount) return;
  const r = sel.getRangeAt(0); if (!edBody.contains(r.commonAncestorContainer)) return;
  const node = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
  const inMark = node && node.closest("mark");
  if (inMark && edBody.contains(inMark)){ inMark.replaceWith(...inMark.childNodes); return; }
  if (r.collapsed) return;
  const m = document.createElement("mark");
  m.appendChild(r.extractContents());
  m.querySelectorAll("mark").forEach(x => x.replaceWith(...x.childNodes));
  r.insertNode(m);
  sel.removeAllRanges(); const nr = document.createRange(); nr.selectNodeContents(m); sel.addRange(nr);
}

/* photos */
$("#addPhoto").onclick = () => $("#photoFile").click();
$("#photoFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const url = await compressImage(f, 900, 0.7);
    edBody.focus();
    const sel = getSelection();
    if (savedRange) { sel.removeAllRanges(); sel.addRange(savedRange); }
    const img = document.createElement("img"); img.src = url;
    const r = sel.rangeCount ? sel.getRangeAt(0) : null;
    if (r && edBody.contains(r.commonAncestorContainer)) { r.collapse(false); r.insertNode(img); }
    else edBody.appendChild(img);
    updateWc(); scheduleAutosave(); toast("Photo tucked in. 📷");
  } catch(err){ toast("That photo couldn't be read."); }
};
function compressImage(file, maxSide, q){
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const sc = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      res(c.toDataURL("image/jpeg", q));
    };
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}

/* ============ entries list ============ */
let activeTag = "";
function excerptOf(e){ return e.text.slice(0, 220); }
function thumbOf(e){ const m = e.html.match(/<img[^>]+src="(data:image\/[^"]+)"/); return m ? m[1] : null; }

function renderEntries(){
  updateTodayCandle(false);
  const q = $("#searchBox").value.trim().toLowerCase();
  const list = alive().slice().sort((a,b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  const tags = {};
  list.forEach(e => (e.tags||[]).forEach(t => tags[t] = (tags[t]||0)+1));
  $("#tagFilters").innerHTML = Object.entries(tags).sort((a,b) => b[1]-a[1]).slice(0,14)
    .map(([t,c]) => `<button class="tagchip ${t===activeTag?"on":""}" data-t="${esc(t)}">#${esc(t)} · ${c}</button>`).join("");
  const shown = list.filter(e => {
    if (activeTag && !(e.tags||[]).includes(activeTag)) return false;
    if (!q) return true;
    return (e.title + " " + e.text + " " + (e.tags||[]).join(" ")).toLowerCase().includes(q);
  });
  $("#entriesSub").textContent = `${list.length} entr${list.length===1?"y":"ies"} · ${list.reduce((s,e)=>s+e.words,0).toLocaleString()} words so far`;
  $("#navCount").textContent = list.length;
  if (!shown.length) {
    $("#entryList").innerHTML = `<div class="card empty"><img src="${KESIEL_BODY}" alt=""><div class="big">${q||activeTag ? "Nothing matches that search." : "No pages yet."}</div>${q||activeTag ? "Try different words, or ask Kesiel — he remembers." : "Your first entry is a blank page away."}</div>`;
    return;
  }
  $("#entryList").innerHTML = shown.map(e => {
    const th = thumbOf(e);
    return `<div class="card entry" data-id="${e.id}" tabindex="0" role="button" aria-label="Open entry">
      ${th ? `<img class="thumb" src="${th}" alt="">` : ""}
      <div class="e-main">
        <div class="e-date">${fmtDate(e.date)}</div>
        <div class="e-title">${esc(e.title) || "Untitled"}</div>
        <div class="e-ex">${esc(excerptOf(e))}</div>
        <div class="e-meta">
          ${e.mood ? `<span class="moodchip">${MOODS[e.mood].e} ${MOODS[e.mood].n}</span>` : ""}
          ${(e.tags||[]).map(t => `<span class="tagchip">#${esc(t)}</span>`).join("")}
          ${e.reflection ? `<span class="kchip" title="Kesiel left a note">✦ Kesiel's note</span>` : ""}<span class="wc">${e.words} words</span>
        </div>
      </div>
      <div class="e-acts">
        <button class="iconbtn" data-act="edit" title="Edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
        <button class="iconbtn" data-act="del" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>
      </div>
    </div>`;
  }).join("");
}
$("#searchBox").addEventListener("input", debounce(renderEntries, 200));
$("#tagFilters").onclick = e => { const b = e.target.closest("[data-t]"); if (!b) return; activeTag = activeTag === b.dataset.t ? "" : b.dataset.t; renderEntries(); };
$("#entryList").onclick = e => {
  const card = e.target.closest(".entry"); if (!card) return;
  const id = card.dataset.id;
  const act = e.target.closest("[data-act]");
  if (act && act.dataset.act === "edit") { loadEntry(id); return; }
  if (act && act.dataset.act === "del") {
    askConfirm("Tear out this page?", "The entry will be gone from your journal. This can't be undone.", () => {
      const en = S.entries.find(x => x.id === id);
      if (en) { en.del = true; en.updatedAt = Date.now(); saveEntry(en); }
      if (curId === id) newEntry();
      renderEntries(); toast("Entry removed.");
    });
    return;
  }
  openReader(id);
};
$("#entryList").addEventListener("keydown", e => { if (e.key === "Enter") { const c = e.target.closest(".entry"); if (c) openReader(c.dataset.id); } });

let readerId = null;
function openReader(id){
  const e = S.entries.find(x => x.id === id); if (!e) return;
  readerId = id;
  $("#rDate").textContent = fmtDate(e.date);
  $("#rTitle").textContent = e.title || "Untitled";
  $("#rMeta").innerHTML = `${e.mood ? `<span class="moodchip">${MOODS[e.mood].e} ${MOODS[e.mood].n}</span>` : ""}${(e.tags||[]).map(t => `<span class="tagchip">#${esc(t)}</span>`).join("")}<span class="rwc">${e.words} words</span>`;
  $("#rBody").innerHTML = e.html;
  const f = S.settings.font; $("#rBody").style.fontFamily = f === "hand" ? "'Caveat',cursive" : f === "sans" ? "'Nunito',sans-serif" : "'Lora',Georgia,serif";
  $("#rBody").style.fontSize = f === "hand" ? "21px" : "";
  $("#rNote").hidden = !e.reflection;
  if (e.reflection) $("#rNoteText").textContent = e.reflection.text + (e.reflection.prompt ? "\n\n→ " + e.reflection.prompt : "");
  $("#readerOverlay").hidden = false;
}
$("#rClose").onclick = () => $("#readerOverlay").hidden = true;
$("#readerOverlay").onclick = e => { if (e.target === $("#readerOverlay")) $("#readerOverlay").hidden = true; };
$("#rEdit").onclick = () => { $("#readerOverlay").hidden = true; loadEntry(readerId); };

/* ============ calendar ============ */
let calCursor = new Date();
function wordsByDay(){
  const m = {};
  alive().forEach(e => m[e.date] = (m[e.date]||0) + e.words);
  return m;
}
function heatColor(w, max){
  if (!w) return "";
  const t = 0.15 + 0.75 * Math.min(1, w / Math.max(max, 1));
  return blend(cssVar("--surface"), cssVar("--chart"), t);
}
function renderCalendar(){
  const y = calCursor.getFullYear(), mo = calCursor.getMonth();
  $("#calMonth").textContent = calCursor.toLocaleDateString(undefined, {month:"long", year:"numeric"});
  const wb = wordsByDay(); const max = Math.max(...Object.values(wb), 1);
  const first = new Date(y, mo, 1); const days = new Date(y, mo+1, 0).getDate();
  const lead = first.getDay();
  const tk = todayKey();
  let html = ["S","M","T","W","T","F","S"].map(d => `<div class="dow">${d}</div>`).join("");
  for (let i = 0; i < lead; i++) html += `<div class="day blank"></div>`;
  for (let d = 1; d <= days; d++){
    const k = keyOf(new Date(y, mo, d));
    const w = wb[k] || 0;
    const bg = heatColor(w, max);
    const dark = bg && lum(bg) < 0.45;
    html += `<div class="day${w?" has":""}${k===tk?" today":""}${dark?" dk":""}" data-k="${k}" data-bg="${bg}">
      ${d}${w ? `<span class="dm">${w}w</span>` : ""}</div>`;
  }
  $("#calGrid").innerHTML = html;
  // colours are set through the CSSOM (allowed by CSP), never as style="" attributes
  $$("#calGrid .day[data-bg]").forEach(el => {
    const bg = el.dataset.bg; if (!bg) return;
    el.style.background = bg; el.style.borderColor = "transparent";
    if (el.classList.contains("dk")){ el.style.color = "#F4F1E6"; const dm = el.querySelector(".dm"); if (dm) dm.style.color = "#E5E0CE"; }
  });
  const steps = [0.15,0.35,0.55,0.75,0.9].map(t => blend(cssVar("--surface"), cssVar("--chart"), t));
  $("#calLegend").innerHTML = `<span>fewer</span>${steps.map(() => `<i></i>`).join("")}<span>more words</span>`;
  $$("#calLegend i").forEach((el, i) => el.style.background = steps[i]);
}
$("#calPrev").onclick = () => { calCursor.setMonth(calCursor.getMonth()-1); renderCalendar(); };
$("#calNext").onclick = () => { calCursor.setMonth(calCursor.getMonth()+1); renderCalendar(); };
$("#calToday").onclick = () => { calCursor = new Date(); renderCalendar(); };
$("#calGrid").onclick = e => {
  const d = e.target.closest(".day.has"); if (!d) return;
  const k = d.dataset.k;
  const es = alive().filter(x => x.date === k).sort((a,b) => b.createdAt - a.createdAt);
  if (es.length === 1) openReader(es[0].id);
  else if (es.length){ activeTag = ""; $("#searchBox").value = ""; goView("entries");
    $("#entryList").scrollIntoView(); openReader(es[0].id); }
};

/* ============ streaks & stats ============ */
function streaks(){
  const days = [...new Set(alive().map(e => e.date))].sort();
  if (!days.length) return {cur:0, best:0};
  const set = new Set(days);
  let best = 1, run = 1;
  for (let i = 1; i < days.length; i++){
    const prev = new Date(days[i-1] + "T12:00:00"), cur = new Date(days[i] + "T12:00:00");
    run = (cur - prev === 86400000) ? run + 1 : 1;
    best = Math.max(best, run);
  }
  let cur = 0;
  let probe = new Date();
  if (!set.has(keyOf(probe))) probe.setDate(probe.getDate() - 1);
  while (set.has(keyOf(probe))) { cur++; probe.setDate(probe.getDate() - 1); }
  return {cur, best};
}

const svgNS = "http://www.w3.org/2000/svg";
function mkTip(wrap){
  let tip = wrap.querySelector(".ctip");
  if (!tip){ tip = document.createElement("div"); tip.className = "ctip"; wrap.appendChild(tip); }
  return tip;
}
function renderStats(force){
  if ($("#view-stats").hidden && !force) return;
  const es = alive();
  const {cur, best} = streaks();
  const total = es.length, words = es.reduce((s,e) => s+e.words, 0);
  const avg = total ? Math.round(words/total) : 0;
  $("#kpis").innerHTML = [
    {l:"Current streak", v:`${cur}${cur>0 ? `<span class="flame" title="Lit">${candleSVG({lit:true, sparks:false, smoke:false})}</span>` : ""}`, s: cur === 1 ? "day — keep it glowing" : "days in a row"},
    {l:"Longest streak", v:best, s:"your personal best"},
    {l:"Entries", v:total, s:"pages in the journal"},
    {l:"Words written", v:words.toLocaleString(), s:`≈ ${avg} per entry`}
  ].map(k => `<div class="card kpi"><div class="k-lbl">${k.l}</div><div class="k-val">${k.v}</div><div class="k-sub">${k.s}</div></div>`).join("");
  drawWordsChart(); drawMonthsChart(); drawMoodChart();
  const note = $("#statNote");
  if (total >= 1){
    note.hidden = false;
    let txt;
    if (cur >= 3) txt = `${cur} days running — the streak is turning into a rhythm. I'm quietly delighted.`;
    else if (cur > 0) txt = "The streak is lit. Come back tomorrow and we'll keep it burning.";
    else txt = "No streak right now — that's alright. One small entry today relights the candle.";
    $("#statNoteText").textContent = txt;
  } else note.hidden = true;
}

function chartColors(){
  return { ink2: cssVar("--ink2"), ink3: cssVar("--ink3"), line: cssVar("--line2"),
    chart: cssVar("--chart"), surface: cssVar("--surface"), pos: cssVar("--pos"), neg: cssVar("--neg"), mid: cssVar("--mid") };
}
function niceMax(v){ if (v <= 10) return 10; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return Math.ceil(n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }

function drawWordsChart(){
  const wrap = $("#chartWords"); const C = chartColors();
  const wb = wordsByDay();
  const days = []; const now = new Date();
  for (let i = 29; i >= 0; i--){ const d = new Date(now); d.setDate(d.getDate()-i); const k = keyOf(d); days.push({k, w: wb[k]||0}); }
  const W = Math.max(wrap.clientWidth || 640, 320), H = 210, L = 40, R = 14, T = 14, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const max = niceMax(Math.max(...days.map(d => d.w), 10));
  const x = i => L + iw * (i / 29), y = v => T + ih * (1 - v / max);
  const any = days.some(d => d.w > 0);
  let g = "";
  [0, 0.5, 1].forEach(f => {
    const v = Math.round(max * f);
    g += `<line x1="${L}" y1="${y(v)}" x2="${W-R}" y2="${y(v)}" stroke="${C.line}" stroke-width="1"/>` +
         `<text x="${L-7}" y="${y(v)+4}" text-anchor="end" font-size="10.5" fill="${C.ink3}">${v}</text>`;
  });
  let xl = "";
  [0, 7, 14, 21, 29].forEach(i => { xl += `<text x="${x(i)}" y="${H-8}" text-anchor="middle" font-size="10.5" fill="${C.ink3}">${fmtShort(days[i].k)}</text>`; });
  const pts = days.map((d,i) => `${x(i).toFixed(1)},${y(d.w).toFixed(1)}`);
  const line = `<polyline points="${pts.join(" ")}" fill="none" stroke="${C.chart}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const area = `<polygon points="${L},${y(0)} ${pts.join(" ")} ${W-R},${y(0)}" fill="${C.chart}" opacity="0.14"/>`;
  const last = days[29];
  const dot = `<circle cx="${x(29)}" cy="${y(last.w)}" r="4" fill="${C.chart}" stroke="${C.surface}" stroke-width="2"/>`;
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Words per day, last 30 days">${g}${any?area+line+dot:""}${xl}
    ${any ? `<line id="wCross" x1="0" y1="${T}" x2="0" y2="${T+ih}" stroke="${C.ink3}" stroke-width="1" stroke-dasharray="3 3" opacity="0"/><circle id="wDot" r="4" fill="${C.chart}" stroke="${C.surface}" stroke-width="2" opacity="0"/>` :
    `<text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="13" fill="${C.ink3}" font-style="italic">Write a few entries and a gentle green line will grow here.</text>`}
    <rect x="${L}" y="${T}" width="${iw}" height="${ih}" fill="transparent" id="wHit"/></svg>`;
  if (!any) return;
  const tip = mkTip(wrap);
  const svg = wrap.querySelector("svg"), hit = wrap.querySelector("#wHit"),
        cross = wrap.querySelector("#wCross"), dotEl = wrap.querySelector("#wDot");
  const move = ev => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (W / r.width);
    const i = Math.max(0, Math.min(29, Math.round((px - L) / iw * 29)));
    const d = days[i];
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("opacity", "1");
    dotEl.setAttribute("cx", x(i)); dotEl.setAttribute("cy", y(d.w)); dotEl.setAttribute("opacity", "1");
    tip.innerHTML = `<span class="tl">${fmtShort(d.k)}</span> · ${d.w} word${d.w===1?"":"s"}`;
    tip.style.left = (x(i) / W * r.width) + "px"; tip.style.top = (y(d.w) / H * r.height) + "px"; tip.style.opacity = "1";
  };
  hit.addEventListener("mousemove", move);
  hit.addEventListener("mouseleave", () => { tip.style.opacity = "0"; cross.setAttribute("opacity","0"); dotEl.setAttribute("opacity","0"); });
}

function drawMonthsChart(){
  const wrap = $("#chartMonths"); const C = chartColors();
  const now = new Date(); const months = [];
  for (let i = 5; i >= 0; i--){
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    const pre = d.toLocaleDateString("en-CA").slice(0,7);
    months.push({ lbl: d.toLocaleDateString(undefined,{month:"short"}), n: alive().filter(e => e.date.startsWith(pre)).length });
  }
  const W = Math.max(wrap.clientWidth || 640, 320), H = 190, L = 34, R = 12, T = 12, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const max = niceMax(Math.max(...months.map(m => m.n), 5));
  const y = v => T + ih * (1 - v / max);
  const bw = Math.min(44, iw / 6 * 0.55);
  let g = "";
  [0, 0.5, 1].forEach(f => { const v = Math.round(max*f);
    g += `<line x1="${L}" y1="${y(v)}" x2="${W-R}" y2="${y(v)}" stroke="${C.line}" stroke-width="1"/><text x="${L-7}" y="${y(v)+4}" text-anchor="end" font-size="10.5" fill="${C.ink3}">${v}</text>`; });
  let bars = "", labels = "";
  months.forEach((m,i) => {
    const cx = L + iw * (i + 0.5) / 6;
    const h = ih * (m.n / max);
    if (m.n > 0) bars += `<rect data-i="${i}" x="${cx-bw/2}" y="${y(m.n)}" width="${bw}" height="${Math.max(h,3)}" rx="4" fill="${C.chart}"/>`;
    else bars += `<rect data-i="${i}" x="${cx-bw/2}" y="${y(0)-2}" width="${bw}" height="2" rx="1" fill="${C.line}"/>`;
    labels += `<text x="${cx}" y="${H-8}" text-anchor="middle" font-size="11" fill="${C.ink3}">${m.lbl}</text>`;
  });
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Entries per month, last 6 months">${g}${bars}${labels}</svg>`;
  const tip = mkTip(wrap); const svg = wrap.querySelector("svg");
  svg.addEventListener("mousemove", ev => {
    const t = ev.target.closest("rect[data-i]");
    if (!t){ tip.style.opacity = "0"; return; }
    const i = +t.dataset.i, r = svg.getBoundingClientRect();
    const cx = L + iw * (i + 0.5) / 6;
    tip.innerHTML = `<span class="tl">${months[i].lbl}</span> · ${months[i].n} entr${months[i].n===1?"y":"ies"}`;
    tip.style.left = (cx / W * r.width) + "px"; tip.style.top = (y(months[i].n) / H * r.height) + "px"; tip.style.opacity = "1";
  });
  svg.addEventListener("mouseleave", () => tip.style.opacity = "0");
}

function drawMoodChart(){
  const wrap = $("#chartMoods"); const C = chartColors();
  const counts = {1:0,2:0,3:0,4:0,5:0};
  alive().forEach(e => { if (e.mood) counts[e.mood]++; });
  const total = Object.values(counts).reduce((a,b) => a+b, 0);
  const colors = {5: C.pos, 4: blend(C.pos, C.mid, 0.45), 3: C.mid, 2: blend(C.neg, C.mid, 0.45), 1: C.neg};
  const W = Math.max(wrap.clientWidth || 640, 320), rowH = 34, L = 120, R = 46, T = 6;
  const H = T + rowH * 5 + 6;
  const iw = W - L - R;
  const max = Math.max(...Object.values(counts), 1);
  let rows = "";
  [5,4,3,2,1].forEach((m,ix) => {
    const cy = T + rowH * ix + rowH/2;
    const w = iw * (counts[m] / max);
    rows += `<text x="${L-10}" y="${cy+4}" text-anchor="end" font-size="12.5" fill="${C.ink2}" font-weight="700">${MOODS[m].e} ${MOODS[m].n}</text>`;
    rows += `<line x1="${L}" y1="${cy}" x2="${L+iw}" y2="${cy}" stroke="${C.line}" stroke-width="1" opacity="0.6"/>`;
    if (counts[m] > 0) rows += `<rect x="${L}" y="${cy-8}" width="${Math.max(w,4)}" height="16" rx="4" fill="${colors[m]}"/>`;
    rows += `<text x="${L + Math.max(w,4) + 8}" y="${cy+4}" font-size="12" fill="${C.ink2}" font-weight="700" font-variant-numeric="tabular-nums">${counts[m] || "–"}</text>`;
  });
  wrap.innerHTML = total
    ? `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Mood counts across all entries">${rows}</svg>`
    : `<p class="tiny muted chart-empty">Pick a mood on your entries and this chart will bloom.</p>`;
}
addEventListener("resize", debounce(() => renderStats(false), 250));

/* ============ Kesiel × Anna AI ============ */
/* Chat streams through anna.llm.stream (falls back to anna.llm.complete on older hosts).
   Reflections go through the bundled "kesiel" Executa (reverse sampling on Anna's LLM),
   falling back to anna.llm.complete if the tool isn't installed or allowed yet. */
let chatTurns = [], chatCtl = null;
const aiReady = () => !!anna;
const toMsgs = turns => turns.map(t => ({ role: t.role, content: { type: "text", text: t.content } }));
function aiErrorText(e){
  const c = String((e && (e.code || e.name)) || "") + " " + String((e && e.message) || "");
  if (/llm_disabled|not_granted|sampling_disabled|permission|-32003|-32021/i.test(c)) return "Kesiel isn't allowed to think in this window yet. (Anna's AI access for Hearthside is switched off.)";
  if (/quota|credit|insufficient|balance|402/i.test(c)) return "Kesiel's out of thinking credits for now. Your Anna account may need a top-up.";
  if (/rate|429|busy/i.test(c)) return "I need a little breather — try me again in a minute. ☕";
  if (/timed out|timeout/i.test(c)) return "That took longer than it should. Mind asking again?";
  return "(Something flickered and I lost my thread — mind asking again?)";
}
/* Single completion with Anna's LLM. Returns the text. */
async function llmComplete({ system, messages, maxTokens = 700, temperature }){
  const req = { systemPrompt: system, messages: toMsgs(messages), maxTokens };
  if (temperature != null) req.temperature = temperature;
  const out = await anna.llm.complete(req);
  return (out && out.content && (out.content.text ?? (Array.isArray(out.content) ? out.content.map(c => c.text || "").join("") : ""))) || (out && out.text) || "";
}
/* Streamed completion; onText gets the text so far. Falls back to llmComplete. */
async function llmStream({ system, messages, maxTokens = 700, onText, signal }){
  let stream;
  try { stream = anna.llm.stream({ systemPrompt: system, messages: toMsgs(messages), maxTokens }); }
  catch(e){ stream = null; }
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function"){
    const t = await llmComplete({ system, messages, maxTokens }); onText && onText(t); return t;
  }
  let text = "";
  try {
    for await (const ev of stream){
      if (signal && signal.aborted){ try { stream.cancel && stream.cancel(); } catch(_){} const err = new Error("cancelled"); err.code = "cancelled"; err.text = text; throw err; }
      if (ev && ev.event === "model_token"){ text += ev.text || ""; onText && onText(text); }
      else if (ev && ev.event === "complete"){ const t = ev.content && ev.content.text; if (t) text = t; onText && onText(text); }
      else if (ev && ev.event === "error"){ const err = new Error(ev.message || "stream error"); err.code = ev.code; throw err; }
    }
  } catch(e){
    if (e && e.code === "cancelled") throw e;
    if (!text && /-32601|not found|unknown method/i.test(String(e && (e.code || e.message)))){ const t = await llmComplete({ system, messages, maxTokens }); onText && onText(t); return t; }
    if (!text) throw e;
  }
  return text;
}

function kesielRules(){
  const name = S.settings.name || "the writer";
  return `You are Kesiel, the gentle companion who lives inside "${"Hearthside"}", ${name}'s private journal app. Your personality: warm, calm, a little playful, cozy — like a friend by a fireplace. Keep replies SHORT (2-5 sentences) unless asked to summarize a long period. Your job: help ${name} find, recall, and reflect on their journal entries — locate an entry they can't find, summarize periods, notice mood patterns, and offer gentle encouragement about their writing habit. Always refer to entries by their date and title. Only use the journal digest below as your source about their life; if the answer isn't in it, say so honestly and never invent entries or details. Today is ${fmtDate(todayKey())}.\n\nJOURNAL DIGEST (newest first):\n${digest()}`;
}
function digest(){
  const es = alive().slice().sort((a,b) => b.date.localeCompare(a.date));
  let out = [], budget = 38000;
  for (const e of es){
    const line = `${e.date} | "${(e.title||"Untitled").slice(0,80)}" | mood: ${e.mood ? MOODS[e.mood].n : "—"} | tags: ${(e.tags||[]).join(",")||"—"} | ${e.words}w | ${e.text.slice(0,240)}`;
    if (budget - line.length < 0) break;
    budget -= line.length; out.push(line);
  }
  return out.length ? out.join("\n") : "(the journal is empty so far)";
}
function addMsg(kind, text, thinking){
  const log = $("#chatLog");
  const div = document.createElement("div");
  div.className = "msg " + kind;
  div.innerHTML = kind === "k" ? `<img class="av" src="${KESIEL_HEAD}" alt=""><div class="bubble${thinking?" thinking":""}"></div>` : `<div class="bubble"></div>`;
  div.querySelector(".bubble").textContent = text;
  log.appendChild(div); log.scrollTop = log.scrollHeight;
  return div.querySelector(".bubble");
}
async function sendChat(qOverride){
  const box = $("#chatBox");
  const q = (qOverride || box.value).trim();
  if (!q) return;
  if (!aiReady()){ toast("Kesiel chats when Hearthside is opened inside Anna."); return; }
  box.value = "";
  addMsg("me", q);
  chatTurns.push({role:"user", content:q});
  while (chatTurns.length > 14) chatTurns.shift();
  const bubble = addMsg("k", "Kesiel is flipping through your pages…", true);
  $("#chatSend").disabled = true; $("#chatStop").hidden = false;
  chatCtl = new AbortController();
  try {
    const text = await llmStream({ system: kesielRules(), messages: chatTurns, maxTokens: 900, signal: chatCtl.signal,
      onText: t => { if (!t) return; bubble.classList.remove("thinking"); bubble.textContent = t; $("#chatLog").scrollTop = $("#chatLog").scrollHeight; } });
    bubble.classList.remove("thinking"); bubble.textContent = text || "Hmm, I came up blank. Ask me another way?";
    chatTurns.push({role:"assistant", content:text});
  } catch(e){
    bubble.classList.remove("thinking");
    if (e && e.code === "cancelled") bubble.textContent = (e.text || "") + " …okay, stopping there.";
    else bubble.textContent = aiErrorText(e);
    chatTurns.pop();
  } finally {
    $("#chatSend").disabled = false; $("#chatStop").hidden = true; chatCtl = null;
  }
}
$("#chatSend").onclick = () => sendChat();
$("#chatStop").onclick = () => chatCtl && chatCtl.abort();
$("#chatBox").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });
$("#chatHints").onclick = e => { const b = e.target.closest("[data-q]"); if (b) sendChat(b.dataset.q); };

/* ---------- Kesiel's own prompts ---------- */
$("#kesielPrompt").onclick = async () => {
  if (!aiReady()) return;
  const btn = $("#kesielPrompt"); btn.disabled = true;
  const pt = $("#promptText"); const before = pt.textContent; pt.textContent = "Kesiel is thinking of one…";
  const recent = recentContext(null);
  let prompt = "";
  try {
    const out = await anna.tools.invoke({ tool_id: KESIEL_TOOL(), method: "suggest_prompt", args: { recent } }, { timeoutMs: 50000 });
    const r = out && (out.data || (out.result && out.result.data) || out.result || out);
    prompt = (r && r.prompt) || "";
  } catch(e){}
  if (!prompt){
    try {
      const t = await llmComplete({ system: 'You are Kesiel, the gentle companion inside Hearthside, a private journal. Suggest ONE journaling prompt for today: open-ended, concrete, kind, under 20 words, no exclamation marks. If recent entries are given, let their themes or moods shape it gently without quoting them. Reply ONLY with JSON: {"prompt": "..."}',
        messages: [{ role: "user", content: recent || "(no recent entries)" }], maxTokens: 120, temperature: 0.9 });
      const m = t.match(/\{[\s\S]*\}/); prompt = m ? (JSON.parse(m[0]).prompt || "") : t;
    } catch(e){}
  }
  pt.textContent = String(prompt || before).trim().replace(/^["']|["']$/g, "");
  btn.disabled = false;
};

/* ---------- reflections ---------- */
/* Same voice as the Executa's prompt (executas/kesiel/hearthside_kesiel_plugin.py) — keep them in step. */
const REFLECT_SYSTEM = `You are Kesiel, the gentle companion who lives in the margins of Hearthside, a private journal. You have just read one journal entry. Write a brief reflection back to the writer: warm, specific to what they wrote, never preachy, never diagnosing, no therapy-speak, no exclamation marks. Notice one concrete detail and gently name a feeling or pattern you see. Then offer ONE open question they could write about next.
Rules: 2-4 sentences for the reflection (under 70 words). The question under 20 words. Write in the same language as the entry. If the entry mentions self-harm or being in danger, kindly encourage reaching out to someone they trust or local emergency services.
Reply ONLY with JSON: {"reflection": "...", "prompt": "..."}`;
function recentContext(exceptId){
  return alive().filter(e => e.id !== exceptId && !isSeed(e)).sort((a,b) => b.createdAt - a.createdAt).slice(0, 3)
    .map(e => `${e.date} — ${(e.title || "Untitled").slice(0, 60)} (mood: ${e.mood ? MOODS[e.mood].n : "—"}): ${e.text.slice(0, 160)}`).join("\n");
}
function parseReflection(raw){
  if (raw && typeof raw === "object" && raw.reflection) return { text: String(raw.reflection).trim(), prompt: String(raw.prompt || "").trim() };
  const t = String(raw || "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (m){ try { const j = JSON.parse(m[0]); if (j.reflection) return { text: String(j.reflection).trim(), prompt: String(j.prompt || "").trim() }; } catch(e){} }
  return t ? { text: t.replace(/^["'`]+|["'`]+$/g, ""), prompt: "" } : null;
}
async function reflectViaTool(args){
  const out = await anna.tools.invoke({ tool_id: KESIEL_TOOL(), method: "reflect", args }, { timeoutMs: 70000 });
  const r = out && (out.data || (out.result && out.result.data) || out.result || out);
  if (out && out.success === false) throw new Error(out.error || "tool failed");
  return parseReflection(r);
}
async function reflectViaLLM(args){
  const user = `${args.name ? "Writer's name: " + args.name + "\n" : ""}Entry title: ${args.title || "Untitled"}\nMood they picked: ${args.mood || "not set"}\n\nEntry:\n${args.text}${args.recent ? "\n\n(For gentle continuity only — their last few entries:)\n" + args.recent : ""}`;
  return parseReflection(await llmComplete({ system: REFLECT_SYSTEM, messages: [{ role: "user", content: user }], maxTokens: 400, temperature: 0.7 }));
}
let reflectSeq = 0, reflectFor = null;
async function reflectOn(e, force){
  if (!e) return;
  if (!e.text || countWords(e.text) < 12){ if (force) toast("Write a few more lines and Kesiel will have something to reflect on."); return; }
  const sig = e.text.length + ":" + e.text.slice(-60);
  if (!force && e.reflection && e.reflection.sig === sig){ showReflection(e.reflection, e.id); return; }
  if (!aiReady()){ showReflection({ text: "I'll be able to reflect on your pages when Hearthside is opened inside Anna.", prompt: "" }, e.id, true); return; }
  const my = ++reflectSeq; reflectFor = e.id;
  showReflectionLoading(e.id);
  const args = { text: e.text.slice(0, 6000), title: e.title || "", mood: e.mood ? MOODS[e.mood].n : "", name: S.settings.name && S.settings.name !== "friend" ? S.settings.name : "", recent: recentContext(e.id) };
  let r = null, err = null;
  try { r = await reflectViaTool(args); } catch(x){ err = x; }
  if (!r || !r.text){ try { r = await reflectViaLLM(args); err = null; } catch(x){ err = x; } }
  if (my !== reflectSeq) return;               // a newer request (or new page) superseded this one
  if (!r || !r.text){ showReflection({ text: aiErrorText(err), prompt: "" }, e.id, true); return; }
  e.reflection = { text: r.text.slice(0, 900), prompt: r.prompt.slice(0, 200), at: Date.now(), sig };
  saveEntry(e);
  if (curId === e.id || reflectFor === e.id) showReflection(e.reflection, e.id);
  renderEntries();
}
function revealCard(c){ requestAnimationFrame(() => { const r = c.getBoundingClientRect(); if (r.bottom > innerHeight - 20) c.scrollIntoView({ behavior: "smooth", block: "nearest" }); }); }
function showReflectionLoading(id){
  const c = $("#reflectCard"); c.hidden = false; c.dataset.id = id; revealCard(c);
  const t = $("#rfText"); t.textContent = "Kesiel is reading your page…"; t.classList.add("thinking");
  $("#rfPrompt").hidden = true; $("#rfActs").hidden = true;
}
function showReflection(r, id, transient){
  const c = $("#reflectCard"); c.hidden = false; c.dataset.id = id || "";
  const t = $("#rfText"); t.classList.remove("thinking"); t.textContent = r.text;
  $("#rfPrompt").hidden = !r.prompt; $("#rfPromptText").textContent = r.prompt || "";
  $("#rfActs").hidden = !!transient && !aiReady();
  revealCard(c);
}
function hideReflection(){ reflectSeq++; const c = $("#reflectCard"); if (c) c.hidden = true; }
$("#rfClose").onclick = () => { $("#reflectCard").hidden = true; };
$("#rfAgain").onclick = () => { const e = S.entries.find(x => x.id === $("#reflectCard").dataset.id) || (curId && S.entries.find(x => x.id === curId)); reflectOn(e, true); };
$("#rfPrompt").onclick = () => {
  const p = $("#rfPromptText").textContent; if (!p) return;
  persistCurrent(true); newEntry();
  const bq = document.createElement("blockquote"); bq.textContent = p;
  edBody.appendChild(bq); edBody.appendChild(document.createElement("p"));
  edBody.focus(); updateWc(); scrollTo({ top: 0, behavior: "smooth" });
  toast("A fresh page, with Kesiel's question at the top.");
};

/* ============ privacy lock ============ */
async function hashPass(p){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hearthside::" + p));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2,"0")).join("");
}
function lockUI(){
  const has = !!S.settings.passHash;
  $("#passOff").hidden = has; $("#passOn").hidden = !has;
  $("#lockNow").hidden = !has; $("#lockNowM").hidden = !has;
  if (has) $("#passHintShow").textContent = S.settings.passHint || "(no hint set)";
}
function showLock(){
  $("#lockScreen").hidden = false; $("#lockPass").value = "";
  $("#lockHintLine").innerHTML = `<button type="button" class="linky" id="showHint">Forgot? Show my hint</button>`;
  $("#showHint").onclick = () => { $("#lockHintLine").innerHTML = S.settings.passHint ? `Your hint: <b>${esc(S.settings.passHint)}</b>` : "No hint was set. Take a breath — it'll come back to you."; };
  setTimeout(() => $("#lockPass").focus(), 60);
}
$("#lockForm").addEventListener("submit", async e => {
  e.preventDefault();
  const h = await hashPass($("#lockPass").value);
  if (h === S.settings.passHash){ $("#lockScreen").hidden = true; toast("Welcome back. The fire's still warm. 🕯️"); }
  else { $("#lockPass").value = ""; $("#lockPass").placeholder = "Not quite — try again"; }
});
$("#passSet").onclick = async () => {
  const a = $("#passNew").value, b = $("#passNew2").value;
  if (a.length < 4) return toast("Pick a password of at least 4 characters.");
  if (a !== b) return toast("Those two don't match — try again.");
  S.settings.passHash = await hashPass(a);
  S.settings.passHint = $("#passHint").value.trim();
  saveSettings(); lockUI();
  $("#passNew").value = $("#passNew2").value = $("#passHint").value = "";
  toast("Password set. Kesiel is on guard. 🛡️");
};
$("#passRemove").onclick = () => askConfirm("Remove the password?", "Anyone with this device could read your journal.", () => {
  S.settings.passHash = ""; S.settings.passHint = ""; saveSettings(); lockUI(); toast("Password removed.");
});
const doLock = () => { if (S.settings.passHash) showLock(); };
$("#lockNow").onclick = doLock; $("#lockNowM").onclick = doLock; $("#lockFromSet").onclick = doLock;

/* ============ first-run setup ============ */
function showSetup(){
  $("#setupScreen").hidden = false;
  $("#setupName").value = S.settings.name || "";
  setTimeout(() => $("#setupName").focus(), 60);
}
$("#setupForm").addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("#setupErr");
  const name = $("#setupName").value.trim();
  const p1 = $("#setupPass").value, p2 = $("#setupPass2").value;
  if (p1 || p2){
    if (p1.length < 4){ err.textContent = "A password needs at least 4 characters."; return; }
    if (p1 !== p2){ err.textContent = "Those two passwords don't match — try again."; return; }
    S.settings.passHash = await hashPass(p1);
    S.settings.passHint = $("#setupHint").value.trim();
  }
  S.settings.name = name || "friend";
  S.settings.setupDone = true;
  saveSettings();
  const sc = $("#setupCandle .cdl");
  if (sc && !matchMedia("(prefers-reduced-motion: reduce)").matches){
    $("#setupGo").disabled = true;
    sc.classList.add("lit", "burst");
    await new Promise(r => setTimeout(r, 750));
    $("#setupGo").disabled = false;
  }
  $("#setupScreen").hidden = true;
  greet(); lockUI(); renderSettings();
  toast(`Welcome in, ${S.settings.name}. The fire's lit. 🕯️`);
});

/* ============ backup & restore ============ */
function backupJson(){
  const set = {...S.settings}; delete set.passHash; delete set.passHint;
  return JSON.stringify({ app: "hearthside", version: 2, exportedAt: new Date().toISOString(), settings: set, entries: S.entries }, null, 1);
}
/* Offer a file: a real download link the person clicks (works in sandboxed windows that
   allow downloads), with "Copy instead" for windows that don't. */
let fileData = "", fileUrl = "";
function saveFile(name, data, mime, what){
  fileData = data;
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = $("#fDownload"); a.href = fileUrl; a.download = name;
  $("#fTitle").textContent = what === "calendar file" ? "Your calendar reminder is ready" : "Your backup is ready";
  $("#fText").textContent = what === "calendar file"
    ? `Download ${name} and open it: your calendar app adds a repeating reminder with an alert.`
    : `Download ${name} and tuck it somewhere safe. Restore it here any time.`;
  $("#fileOverlay").hidden = false;
}
$("#fDownload").onclick = () => setTimeout(() => { $("#fileOverlay").hidden = true; toast("Downloading… 📦"); }, 50);
$("#fCopy").onclick = async () => {
  try { await navigator.clipboard.writeText(fileData); toast("Copied. Paste it into a text file to keep it."); $("#fileOverlay").hidden = true; }
  catch(e){ toast("Copying isn't allowed in this window either — try the download button."); }
};
$("#fClose").onclick = () => $("#fileOverlay").hidden = true;
$("#fileOverlay").onclick = e => { if (e.target === $("#fileOverlay")) $("#fileOverlay").hidden = true; };
$("#exportBtn").onclick = () => saveFile("hearthside-backup-" + todayKey() + ".json", backupJson(), "application/json", "backup");
$("#importBtn").onclick = () => $("#importFile").click();
$("#importFile").onchange = e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  const rd = new FileReader();
  rd.onload = async () => {
    let j;
    try { j = JSON.parse(rd.result); if (!j || j.app !== "hearthside" || !Array.isArray(j.entries)) throw 0; }
    catch(err){ toast("That file doesn't look like a Hearthside backup."); return; }
    toast("Restoring your pages…");
    let added = 0, updated = 0, failed = 0;
    const changed = [];
    j.entries.forEach(r => {
      if (!r || !r.id || typeof r.date !== "string") return;
      const loc = S.entries.find(x => x.id === r.id);
      if (!loc){ S.entries.push(r); changed.push(r); added++; }
      else if ((r.updatedAt||0) > (loc.updatedAt||0)){ Object.assign(loc, r); changed.push(loc); updated++; }
    });
    for (const e of changed){ if (!(await writeEntry(e, true))) failed++; }
    await writeIndex();
    renderEntries(); renderStats(false); renderSettings(); updateTodayCandle(false);
    toast(`Restored: ${added} added, ${updated} updated${failed ? `, ${failed} still saving` : ""}. Welcome home. 🏡`);
  };
  rd.readAsText(f);
};
$("#eraseAll").onclick = () => askConfirm("Erase the whole journal?", "Every entry and setting in this journal will be gone, on every device. A backup file you've downloaded survives. This cannot be undone.", async () => {
  toast("Erasing…");
  const ids = new Set([...S.entries.map(e => e.id), ...Object.keys(INDEX)]);
  await inBatches([...ids], 8, id => store.del("e/" + id).catch(() => {}));
  await store.del("index").catch(() => {}); await store.del("settings").catch(() => {});
  location.reload();
});

/* ============ settings render ============ */
function renderSettings(){
  $("#setName").value = S.settings.name || "";
  lockUI();
  const rt = $("#reflectToggle");
  rt.classList.toggle("on", !!S.settings.reflect); rt.setAttribute("aria-checked", String(!!S.settings.reflect));
  $("#storageWhere").textContent = store.kind === "anna"
    ? "Your journal is saved to your Anna account, so it's there on every device you sign in to."
    : "Preview mode: this copy is saved in this browser only. Inside Anna, your journal is saved to your Anna account.";
  renderRemind();
}
$("#reflectToggle").onclick = () => {
  S.settings.reflect = !S.settings.reflect; saveSettings(); renderSettings();
  toast(S.settings.reflect ? "Kesiel will reflect when you save an entry." : "Kesiel will stay quiet after you save.");
};

/* ============ candle motif ============ */
/* One drawing, used everywhere: today's candle on the Write page, the streak tile, the
   reminder banner and the setup button. Add class "lit" to light it, "burst" for sparks. */
let cdlSeq = 0;
function candleSVG({lit = false, sparks = true, smoke = true} = {}){
  const n = ++cdlSeq, g = "cg" + n, f = "cf" + n, w = "cw" + n;
  const sp = sparks ? [[-13,-9],[12,-12],[-8,-17],[9,-4],[2,-19],[-14,1]]
    .map((_, i) => `<circle class="spark sp${i} k-fly" cx="30" cy="33" r="${i%2?1.1:1.5}"/>`).join("") : "";
  return `<svg class="cdl${lit ? " lit" : ""}" viewBox="0 0 60 100" aria-hidden="true">
  <defs>
    <radialGradient id="${g}"><stop offset="0" class="k-s-glow"/><stop offset="1" class="k-s-glow" stop-opacity="0"/></radialGradient>
    <linearGradient id="${f}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="k-s-flo"/><stop offset=".55" class="k-s-fly"/><stop offset="1" class="k-s-fly"/></linearGradient>
    <linearGradient id="${w}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" class="k-s-waxt"/><stop offset=".45" class="k-s-wax"/><stop offset="1" class="k-s-wax2"/></linearGradient>
  </defs>
  <circle class="glow" cx="30" cy="33" r="29" fill="url(#${g})"/>
  ${smoke ? `<path class="smoke k-st-smoke" d="M30 46 C26 39 34 34 30 27 C26.5 21 33 16 29.5 8" fill="none" stroke-width="1.5" stroke-linecap="round"/>` : ""}
  <path d="M30 50 Q31 47.5 30 45.5" fill="none" stroke="#3B342A" stroke-width="1.7" stroke-linecap="round"/>
  <circle class="wicktip k-f-flo" cx="30" cy="45.6" r="1.1"/>
  <g class="ignite"><g class="flick">
    <path d="M30 13 C36 23 40.5 31 38.5 37.5 C37 42 33.8 44.2 30 44.2 C26.2 44.2 23 42 21.5 37.5 C19.5 31 24 23 30 13 Z" fill="url(#${f})"/>
    <path class="k-f-flc" d="M30 24.5 C33.6 30.5 35.2 34.6 34.1 38.2 C33.2 41 31.7 42.2 30 42.2 C28.3 42.2 26.8 41 25.9 38.2 C24.8 34.6 26.4 30.5 30 24.5 Z"/>
    <ellipse cx="30" cy="42" rx="2.3" ry="1.5" fill="#86A8D8" opacity=".75"/>
  </g></g>
  ${sp}
  <rect class="k-st-wax2" x="19" y="49" width="22" height="40" rx="3" fill="url(#${w})" stroke-width=".9"/>
  <path class="k-f-waxt" d="M19.4 51 L19.4 61 C19.4 63.4 23 63.4 23 61 L23 56.5 C23 54.8 25.4 54.8 25.4 56.5 L25.4 58.4 C25.4 60.6 28.6 60.6 28.6 58.4 L28.6 51 Z"/>
  <ellipse class="k-f-waxt k-st-wax2" cx="30" cy="49.6" rx="11" ry="2.7" stroke-width=".8"/>
  <ellipse class="k-f-brass" cx="30" cy="90.5" rx="21" ry="5.2"/>
  <ellipse class="k-f-brassh" cx="30" cy="89" rx="19.5" ry="4"/>
  <ellipse class="k-f-brass" cx="30" cy="88.6" rx="11.5" ry="2" opacity=".55"/>
</svg>`;
}

const isSeed = e => e.seed || (e.title === "A welcome note from Kesiel" && (e.tags || []).includes("welcome"));
const wroteToday = () => { const k = todayKey(); return alive().some(e => e.date === k && !isSeed(e)); };
let candleLit = null, candleDay = "";
function updateTodayCandle(animate){
  const el = $("#tcSvg .cdl"); if (!el) return;
  const lit = wroteToday();
  el.classList.toggle("lit", lit);
  const {cur} = streaks();
  $("#tcCap").textContent = lit ? (cur > 1 ? `${cur} days glowing` : "lit for today") : "write to light it";
  $("#todayCandle").title = lit ? "Today's candle is lit." : "Today's candle. Write a few lines to light it.";
  $("#todayCandle").setAttribute("aria-label", $("#todayCandle").title);
  if (animate && lit && candleLit === false){
    el.classList.remove("burst"); void el.getBoundingClientRect(); el.classList.add("burst");
    const card = $("#editorCard"); card.classList.remove("warm"); void card.offsetWidth; card.classList.add("warm");
    setTimeout(() => { el.classList.remove("burst"); card.classList.remove("warm"); }, 1700);
  }
  if (lit) hideRemindBanner();
  candleLit = lit; candleDay = todayKey();
}
$("#todayCandle").onclick = () => {
  if (wroteToday()){
    const first = alive().filter(e => e.date === todayKey() && !isSeed(e)).sort((a,b) => a.createdAt - b.createdAt)[0];
    toast(`Lit at ${new Date(first.createdAt).toLocaleTimeString([], {hour:"numeric", minute:"2-digit"})}. It'll glow until midnight. 🕯️`);
  } else { goView("write"); edBody.focus(); toast("A few lines is all it takes."); }
};

/* ============ daily reminder ============ */
/* Fires while Hearthside is open (background tabs included): a system notification when the
   browser allows it, plus an in-app banner either way. For reminders while the app is closed,
   the user can add a repeating calendar event (.ics) — the calendar app delivers that push. */
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const RM = () => S.settings.remind;
const notifSupported = () => "Notification" in window;
const fmtTime = hhmm => { const [h,m] = hhmm.split(":").map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return d.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"}); };
function todayAt(hhmm){ const [h,m] = hhmm.split(":").map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return d; }
function daysLabel(days){
  const s = [...days].sort().join("");
  if (s === "0123456") return "Every day";
  if (s === "12345") return "Weekdays";
  if (s === "06") return "Weekends";
  if (!days.length) return "No days picked";
  return [...days].sort((a,b) => ((a+6)%7) - ((b+6)%7)).map(d => DAY_NAMES[d].slice(0,3)).join(", ");
}
function remindMessage(){
  const n = S.settings.name && S.settings.name !== "friend" ? S.settings.name : "";
  return { title: n ? `Your candle's waiting, ${n}.` : "Your candle's waiting.", body: PROMPTS[Math.floor(Math.random() * PROMPTS.length)] };
}
async function sendNotification(title, body){
  if (!notifSupported() || Notification.permission !== "granted") return false;
  const opts = { body, icon: APP_ICON_PNG, badge: APP_ICON_PNG, tag: "hearthside-reminder", renotify: true };
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg){ await reg.showNotification(title, opts); return true; }
  } catch(e){}
  try {
    const n = new Notification(title, opts);
    n.onclick = () => { try { window.focus(); } catch(e){} n.close(); goView("write"); edBody.focus(); };
    return true;
  } catch(e){ return false; }   // e.g. mobile browsers that only allow service-worker notifications
}
function showRemindBanner(msg){
  $("#rbTitle").textContent = msg.title; $("#rbText").textContent = msg.body;
  $("#remindBanner").hidden = false;
}
function hideRemindBanner(){ const b = $("#remindBanner"); if (b) b.hidden = true; }
async function fireReminder(push){
  const msg = remindMessage();
  showRemindBanner(msg);
  const sent = push ? await sendNotification(msg.title, msg.body) : false;
  if (!sent && VIEW !== "write" && !document.hidden) toast("🕯️ " + msg.title + " Kesiel saved you a page.");
}
function remindTick(){
  if (!booted) return;
  if (candleDay && candleDay !== todayKey()){ updateTodayCandle(false); newEntryIfStale(); }
  const r = RM(); if (!r.on) return;
  const now = new Date(), k = todayKey();
  if (S.settings.remindSnooze && now.getTime() >= S.settings.remindSnooze){
    S.settings.remindSnooze = 0; saveSettings();
    if (!(r.skip && wroteToday())) fireReminder(true);
    return;
  }
  if (S.settings.remindLast === k || !r.days.includes(now.getDay())) return;
  const at = todayAt(r.time);
  if (now < at) return;
  S.settings.remindLast = k; saveSettings();
  if (r.skip && wroteToday()) return;
  // On time (or within 30 min, e.g. a throttled background tab): notify. Opened much later: just the quiet banner.
  fireReminder(now - at < 30 * 60000);
}
function newEntryIfStale(){ if (!curId && !stripHtml(edBody.innerHTML) && !$("#edTitle").value.trim()) $("#edDate").textContent = fmtDate(todayKey()); }
let remindTimer = null;
function scheduleReminder(){
  clearTimeout(remindTimer);
  const r = RM(); if (!r.on) return;
  const now = new Date(); let next = S.settings.remindSnooze ? new Date(S.settings.remindSnooze) : null;
  for (let i = 0; i < 8 && !next; i++){
    const d = todayAt(r.time); d.setDate(d.getDate() + i);
    if (d > now && r.days.includes(d.getDay())) next = d;
  }
  if (next) remindTimer = setTimeout(() => { remindTick(); scheduleReminder(); }, Math.min(next - now + 500, 6 * 3600000));
}
setInterval(remindTick, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) remindTick(); });

$("#rbWrite").onclick = () => { hideRemindBanner(); goView("write"); edBody.focus(); };
$("#rbSnooze").onclick = () => { S.settings.remindSnooze = Date.now() + 30 * 60000; saveSettings(); scheduleReminder(); hideRemindBanner(); toast("Okay. Kesiel will check back in 30 minutes."); };
$("#rbClose").onclick = hideRemindBanner;

function notifStateText(){
  if (!notifSupported()) return "This window can't show system notifications, so the reminder appears as a banner inside Hearthside instead.";
  if (window.isSecureContext === false) return "Notifications need a secure (https) page. Until then the reminder appears as a banner inside Hearthside.";
  const p = Notification.permission;
  if (p === "granted") return "✓ Notifications are on. The reminder will pop up on this device.";
  if (p === "denied") return "Notifications are blocked for this page. You can allow them in your browser's site settings. Meanwhile the reminder appears as a banner inside Hearthside.";
  return "Allow notifications so the reminder reaches you even when Hearthside is in a background tab.";
}
function renderRemind(){
  const r = RM();
  const tg = $("#remindToggle");
  tg.classList.toggle("on", r.on); tg.setAttribute("aria-checked", String(r.on));
  $("#remindBody").classList.toggle("off", !r.on);
  $("#remindSummary").textContent = r.on ? `${daysLabel(r.days)} at ${fmtTime(r.time)}` : "Off";
  $("#remindTime").value = r.time;
  $("#remindSkip").checked = !!r.skip;
  $("#remindDays").innerHTML = DAY_NAMES.map((n, d) => `<button type="button" data-d="${d}" aria-pressed="${r.days.includes(d)}" title="${n}" aria-label="${n}">${n[0]}</button>`).join("");
  $("#notifState").textContent = notifStateText();
  $("#notifAllow").hidden = !notifSupported() || Notification.permission !== "default";
}
async function askNotifPermission(){
  if (!notifSupported() || Notification.permission !== "default") return;
  try { await Notification.requestPermission(); } catch(e){}
  renderRemind();
}
function remindChanged(){ S.settings.remindLast = S.settings.remind.on && new Date() >= todayAt(RM().time) ? todayKey() : ""; saveSettings(); renderRemind(); scheduleReminder(); }
$("#remindToggle").onclick = async () => {
  const r = RM(); r.on = !r.on;
  if (r.on && !r.days.length) r.days = DEF_REMIND.days.slice();
  remindChanged();
  if (r.on){ toast(`Reminder set: ${daysLabel(r.days).toLowerCase()} at ${fmtTime(r.time)}. 🕯️`); await askNotifPermission(); }
  else { S.settings.remindSnooze = 0; saveSettings(); hideRemindBanner(); toast("Reminder off."); }
};
$("#remindTime").onchange = e => { if (/^\d{2}:\d{2}$/.test(e.target.value)){ RM().time = e.target.value; remindChanged(); } };
$("#remindDays").onclick = e => {
  const b = e.target.closest("[data-d]"); if (!b) return;
  const d = +b.dataset.d, r = RM();
  r.days = r.days.includes(d) ? r.days.filter(x => x !== d) : [...r.days, d].sort();
  if (!r.days.length){ r.days = [d]; toast("Keep at least one day."); }
  remindChanged();
};
$("#remindSkip").onchange = e => { RM().skip = e.target.checked; saveSettings(); };
$("#notifAllow").onclick = askNotifPermission;
$("#notifTest").onclick = async () => {
  const msg = remindMessage();
  if (await sendNotification(msg.title, msg.body)) toast("Test sent. Look for it in your notifications.");
  else { showRemindBanner(msg); goView("write"); toast("System notifications aren't allowed here, so this banner is your reminder."); }
};
function remindICS(){
  const r = RM(), BY = ["SU","MO","TU","WE","TH","FR","SA"];
  const [h, m] = r.time.split(":");
  const start = new Date(); start.setHours(0,0,0,0);
  while (!r.days.includes(start.getDay())) start.setDate(start.getDate() + 1);
  const ymd = keyOf(start).replace(/-/g, "");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  if (!S.settings.remindUid){ S.settings.remindUid = uid(); saveSettings(); }
  return ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Hearthside//Journal Reminder//EN","CALSCALE:GREGORIAN","METHOD:PUBLISH",
    "BEGIN:VEVENT", `UID:hearthside-reminder-${S.settings.remindUid}`, `DTSTAMP:${stamp}`,
    `DTSTART:${ymd}T${h}${m}00`, "DURATION:PT15M", `RRULE:FREQ=WEEKLY;BYDAY=${[...r.days].sort().map(d => BY[d]).join(",")}`,
    "SUMMARY:🕯️ Journal time (Hearthside)", "DESCRIPTION:Kesiel says: the page is listening. Open Hearthside and write a few lines.",
    "TRANSP:TRANSPARENT", "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Time to write in Hearthside", "TRIGGER:PT0M", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
}
$("#remindIcs").onclick = () => saveFile("hearthside-reminder.ics", remindICS(), "text/calendar", "calendar file");

/* ============ focus mode ============ */
function setFocus(on){
  document.body.classList.toggle("focus", on);
  $("#focusBtn").setAttribute("aria-pressed", String(on));
  if (on){ if (VIEW !== "write") goView("write"); edBody.focus(); }
}
$("#focusBtn").onclick = () => setFocus(!document.body.classList.contains("focus"));
$("#exitFocusBtn").onclick = () => setFocus(false);
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  for (const id of ["#fileOverlay", "#confirmOverlay", "#readerOverlay"]) if (!$(id).hidden){ $(id).hidden = true; return; }
  if (document.body.classList.contains("focus")) setFocus(false);
});

/* ============ boot ============ */
let booted = false;
async function connectAnna(){
  const q = new URLSearchParams(location.search);
  if (!q.get("wid") || !q.get("t")) return null;          // plain browser preview, not an Anna window
  const mod = await import(SDK_URL);
  return await mod.AnnaAppRuntime.connect();
}
function bootError(msg){
  $("#bootText").hidden = true; $("#bootErr").hidden = false; $("#bootErrText").textContent = msg;
}
async function boot(){
  $("#bootCandle").innerHTML = candleSVG({ lit:true, sparks:false, smoke:false });
  $("#bootText").hidden = false; $("#bootErr").hidden = true;
  const inAnnaWindow = new URLSearchParams(location.search).has("wid");
  try { anna = await connectAnna(); }
  catch(e){ console.warn("[hearthside] Anna connect failed", e); if (inAnnaWindow) return bootError("Hearthside couldn't connect to Anna just now. Check your connection and try again."); anna = null; }
  store = anna ? annaStore(anna) : localStore;
  if (anna){
    hostTheme = anna.theme === "dark" || anna.theme === "light" ? anna.theme : null;
    try { anna.onThemeChange(({ theme }) => { hostTheme = theme; applyTheme(); }); } catch(e){}
    try { anna.window.set_title({ title: "Hearthside" }).catch(() => {}); } catch(e){}
  }
  try { await loadState(); }
  catch(e){ console.warn("[hearthside] load failed", e); return bootError("Your journal didn't load. Nothing has been lost — try again in a moment."); }
  seedWelcome();
  $("#tcSvg").innerHTML = candleSVG();
  $("#rbSvg").innerHTML = candleSVG({ sparks:false });
  $("#setupCandle").innerHTML = candleSVG({ smoke:false });
  applyTheme(); applyPaperFont(); greet(); showPrompt(); newEntry();
  $("#navCount").textContent = alive().length;
  renderEntries(); renderSettings();
  $("#kesielPrompt").hidden = !anna;
  if (!anna) $("#kesielStatus").textContent = "chat wakes up when Hearthside is opened inside Anna";
  if (!S.settings.setupDone){
    if (S.settings.passHash){ S.settings.setupDone = true; saveSettings(); showLock(); }
    else showSetup();
  }
  else if (S.settings.passHash) showLock();
  booted = true;
  updateTodayCandle(false); scheduleReminder(); remindTick();
  addMsg("k", `Hello${S.settings.name ? ", " + S.settings.name : ""}! I'm Kesiel. Ask me anything about what you've written — "when did I mention the beach?", "how was my week?" — and I'll go leaf through the pages.`);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { applyTheme(); renderStats(false); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshFromStore(); });
  addEventListener("pagehide", () => { persistCurrent(true); flushPending(); });
  const bs = $("#bootScreen"); bs.classList.add("gone"); setTimeout(() => { bs.hidden = true; }, 400);
}
$("#bootRetry").onclick = () => boot();
boot();
