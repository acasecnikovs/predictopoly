// predictopoly - calibration training on Polymarket questions, past and live
// vanilla JS, no build step, localStorage for state

window.__ppMarker = "loaded";
window.__ppErrs = [];
window.addEventListener("error", (e) => window.__ppErrs.push(`${e.message} at ${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener("unhandledrejection", (e) => window.__ppErrs.push("promise: " + (e.reason && e.reason.stack || e.reason)));

(() => {
  const LS_HISTORY = "predictopoly.history.v1";
  const LS_PREFS   = "predictopoly.prefs.v1";
  const LS_ONBOARD = "predictopoly.onboarded.v1";
  // Active-mode predictions live in their own list. Each entry captures the
  // user's prob, the market price at the time of submit, and the market id /
  // event id / endDate. The Open tray (Phase B) reads this list and a
  // resolution-checker upgrades entries to scored history records once the
  // market closes. Until then they're "pending" and carry no points.
  const LS_PENDING = "predictopoly.pending.v1";
  // Set of prediction-record keys the user has explicitly marked "revisited"
  // in the Stats > Where the market knew better section. Filtered out before
  // the top-5 cut so the next-biggest miss surfaces in its place. Persistent
  // forever - once you've consumed the educational value of a row, it stays
  // hidden even if a later prediction with a smaller gap would have displaced
  // it. Cleared by both resetAll and resetEverything.
  const LS_REVISITED = "predictopoly.revisited.v1";
  // Anonymous device id, generated once and stashed in localStorage. Sent
  // with every prediction so we can answer "is the same device coming back"
  // and "how many predictions per user" server-side. No PII, never leaves
  // the device until attached to an outgoing prediction, clearable via the
  // browser's site-data settings or our own "Reset everything" button.
  const LS_SID     = "predictopoly.sid.v1";
  function getSessionId() {
    let sid = localStorage.getItem(LS_SID);
    if (!sid) {
      // crypto.randomUUID is supported everywhere we ship to; fall back to
      // a manually-rolled hex if the environment is hostile (very old WebViews).
      sid = (window.crypto && typeof crypto.randomUUID === "function")
        ? crypto.randomUUID()
        : Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10)).join("-");
      localStorage.setItem(LS_SID, sid);
    }
    return sid;
  }

  const VOL_STEPS  = [0, 100, 1000, 10000, 100000, 1000000];

  // Canonical display order for categories. Both modes use this so toggling
  // between Resolved and Active doesn't shuffle the deck modal cards. Any
  // category that exists in the live taxonomy but isn't listed here gets
  // appended at the end (defensive for future taxonomy additions).
  const CANON_ORDER = [
    "US Politics",
    "World Politics",
    "Economy & Finance",
    "AI & Tech",
    "Crypto",
    "Sports",
    "Culture & Media",
    "Science",
    "Miscellaneous",
  ];

  function orderedTaxKeys() {
    const present = new Set(Object.keys(taxonomy));
    const out = [];
    for (const c of CANON_ORDER) if (present.has(c)) { out.push(c); present.delete(c); }
    for (const c of present) out.push(c);
    return out;
  }

  // Deck presets - map preset id to a function that returns a {cat: [sub,...]}
  // shape using the live taxonomy. Display order is the visual order in the
  // deck modal; the fresh-user default is set independently via prefs init
  // (mode = "hot"), so reordering here is purely a UX call. "All" leads
  // because it's the most common power-user starting point - users who want
  // a narrower deck reach for News/Tech/Sports next.
  const PRESETS = [
    {
      id: "all",
      label: "All",
      hint: "every category",
      build: (tax) => pickCats(tax, Object.keys(tax)),
    },
    {
      id: "hot",
      label: "Edition picks",
      hint: "~85 hand-picked questions, the good first impression",
      // Hot picks is special: instead of selecting whole categories/subs, it
      // matches a curated `hot:true` flag on individual markets (set in
      // scripts/04_normalize_taxonomy.py from scripts/hot_picks.txt). The
      // build function returns `null` to signal "use the hot flag, ignore
      // category selection entirely". filteredPool() handles that branch.
      build: () => null,
      hotFlag: true,
    },
    {
      id: "news",
      label: "News",
      hint: "politics + economy",
      build: (tax) => pickCats(tax, ["US Politics", "World Politics", "Economy & Finance"]),
    },
    {
      id: "tech",
      label: "Tech",
      hint: "AI + crypto",
      build: (tax) => pickCats(tax, ["AI & Tech", "Crypto"]),
    },
    {
      id: "sports",
      label: "Sports",
      hint: "if you really want game outcomes",
      build: (tax) => pickCats(tax, ["Sports"]),
    },
  ];

  function pickCats(tax, cats) {
    const out = {};
    for (const cat of cats) {
      if (!tax[cat]) continue;
      out[cat] = tax[cat].map((x) => x.sub);
    }
    return out;
  }

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ------- state -------
  // Resolved-mode datasets (default).
  let marketsResolved = [];
  let taxonomyResolved = {};
  let slugsResolved = {};

  // Active-mode datasets (lazy-loaded when user switches to Active mode).
  let marketsActive = [];
  let taxonomyActive = {};
  let slugsActive = {};
  let activeLoaded = false;
  let activeLoadPromise = null;
  // Active descriptions land in the shared `descs` map (keyed by market id),
  // so the existing renderDescription path Just Works regardless of mode.
  // Lazy-loaded once after the active dataset to avoid blocking first paint.
  let activeDescsLoaded = false;
  let activeDescsPromise = null;

  // The four globals below are aliases that point at one of the dataset pairs
  // above. Mode switch swaps them. Most of the existing code reads from these
  // by reference so swapping is transparent.
  let markets   = [];
  let taxonomy  = {};
  let slugs     = {};

  let descs     = {};       // id -> description text (resolved-mode only). Lazy-loaded after first paint.
  let descsReady = false;
  let history   = loadHistory();
  let pending   = loadPending();
  let revisited = loadRevisited();
  let prefs     = loadPrefs();
  let current   = null;     // currently displayed market
  let chart     = null;     // chart.js instance
  // Stats scope: which slice of history the Stats view shows. Session-only
  // (resets on reload) - stats are a glanceable snapshot, no need to persist.
  let statsScope = "all";   // "all" | "resolved" | "active"
  // Per-session ledger of markets actually shown (predict + skip). Drives:
  //   - Ordered modes (end-asc/desc) need this to advance past skipped items.
  //   - Random mode multiplies an event's pick weight by 0.2^k where k = how
  //     many times its event has been shown this session, so tight decks
  //     dominated by one event-with-N-slices feel varied without hiding.
  const shownIds = new Set();
  const eventShowCounts = new Map();
  let chartJsPromise = null;
  function loadChartJs() {
    if (typeof Chart !== "undefined") return Promise.resolve(true);
    if (chartJsPromise) return chartJsPromise;
    chartJsPromise = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js";
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
    return chartJsPromise;
  }
  let currentView = "play"; // play | stats

  // ------- storage -------
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(LS_HISTORY) || "[]"); }
    catch { return []; }
  }
  function saveHistory() { localStorage.setItem(LS_HISTORY, JSON.stringify(history)); }

  function loadPending() {
    try { return JSON.parse(localStorage.getItem(LS_PENDING) || "[]"); }
    catch { return []; }
  }
  function savePending() { localStorage.setItem(LS_PENDING, JSON.stringify(pending)); }

  function loadRevisited() {
    try { return new Set(JSON.parse(localStorage.getItem(LS_REVISITED) || "[]")); }
    catch { return new Set(); }
  }
  function saveRevisited() {
    localStorage.setItem(LS_REVISITED, JSON.stringify(Array.from(revisited)));
  }
  // Stable per-record key. A user can predict on the same market id more than
  // once across active->resolved rollups; pairing id with submit timestamp
  // keeps each record individually addressable.
  function revisitedKeyFor(rec) {
    return `${rec.id || ""}::${rec.t || ""}`;
  }

  // Resolved and active have different taxonomies (and active doesn't support
  // hot/edition picks), so each dataMode owns its own deck state. We keep the
  // CURRENT mode's deck on `prefs.mode`/`prefs.subs` (touched all over the
  // codebase) and stash the inactive mode's deck under `prefs._decks` on every
  // mode switch. Migration: legacy prefs without `_decks` keep their `mode`/
  // `subs` as the current dataMode's deck; the other mode falls back to its
  // sensible default the first time the user switches.
  function deckDefaults(dataMode) {
    return dataMode === "active"
      ? { mode: "custom", subs: null }   // active has no hot pack; null subs = "All"
      : { mode: "hot",    subs: null };  // resolved first-visit = curated edition picks
  }
  const VALID_SORTS = ["random", "end-asc", "end-desc"];
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(LS_PREFS) || "{}");
      const vi = p.volIdx ?? 4;
      const dm = p.dataMode === "active" ? "active" : "resolved";
      const decks = (p._decks && typeof p._decks === "object") ? p._decks : {};
      const sort = VALID_SORTS.includes(p.sort) ? p.sort : "random";
      return {
        mode: p.mode || "hot",       // "hot" = curated allowlist, "custom" = subs-based
        subs: p.subs || null,
        volIdx: Math.max(0, Math.min(VOL_STEPS.length - 1, vi)),
        dataMode: dm,                // "resolved" | "active"
        sort,                        // "random" | "end-asc" | "end-desc"
        _decks: decks,               // { resolved?: {mode, subs}, active?: {mode, subs} }
      };
    } catch { return { mode: "hot", subs: null, volIdx: 4, dataMode: "resolved", sort: "random", _decks: {} }; }
  }
  function savePrefs() { localStorage.setItem(LS_PREFS, JSON.stringify(prefs)); }

  // ------- data -------
  // Cache-bust by app version so taxonomy revisions actually reach the browser.
  const DATA_V = "b080993";

  // First paint only needs the 87-question hot pack (~7 KB brotli). The full
  // markets.json (1.3 MB brotli) loads in the background and swaps in when
  // the user actually needs more (deck modal, stats view, hot deck exhausted).
  let marketsAreFastPack = true;
  let fullMarketsPromise = null;

  async function loadFastData() {
    // descriptions-hot is small (~14 KB brotli) and ships on the same parallel
    // burst so the first question's description shows up with the question.
    const [mRes, tRes, dRes] = await Promise.all([
      fetch(`data/markets-hot.json?v=${DATA_V}`),
      fetch(`data/taxonomy.json?v=${DATA_V}`),
      fetch(`data/descriptions-hot.json?v=${DATA_V}`),
    ]);
    if (!mRes.ok || !tRes.ok) throw new Error("data fetch failed");
    marketsResolved = await mRes.json();
    taxonomyResolved = await tRes.json();
    if (dRes.ok) {
      descs = await dRes.json();
      descsReady = true;
    }
    if (prefs.dataMode === "resolved") applyDataMode("resolved", { silent: true });
  }

  function loadFullMarkets() {
    if (fullMarketsPromise) return fullMarketsPromise;
    fullMarketsPromise = (async () => {
      try {
        const res = await fetch(`data/markets.json?v=${DATA_V}`);
        if (!res.ok) throw new Error(`markets.json ${res.status}`);
        const full = await res.json();
        // Preserve any session-only state by replacing wholesale; ids are stable.
        marketsResolved = full;
        marketsAreFastPack = false;
        if (prefs.dataMode === "resolved") markets = marketsResolved;
        return true;
      } catch (e) {
        // Crucially: clear the cached promise on failure so the next caller
        // (deck modal reopen, nextQuestion empty-fallback, Stats visit) gets
        // a fresh fetch instead of the stuck false. Without this, one flaky
        // network blip on the initial 1.3 MB load wedges the user in fast-pack
        // mode forever - empty-deck after exhausting hot picks even when they
        // switch to "All".
        fullMarketsPromise = null;
        return false;
      }
    })();
    return fullMarketsPromise;
  }

  // Active dataset is a single 1.4 MB file - no fast pack needed since the
  // resolved-side hot pack only exists because the full resolved set is 25 MB.
  // 1.4 MB brotli-compresses to ~250 KB, fine to load in one shot.
  function loadActiveData() {
    if (activeLoadPromise) return activeLoadPromise;
    activeLoadPromise = (async () => {
      try {
        const [mRes, tRes, sRes] = await Promise.all([
          fetch(`data/markets-active.json?v=${DATA_V}`),
          fetch(`data/taxonomy-active.json?v=${DATA_V}`),
          fetch(`data/slugs-active.json?v=${DATA_V}`),
        ]);
        if (!mRes.ok || !tRes.ok) return false;
        marketsActive = await mRes.json();
        taxonomyActive = await tRes.json();
        if (sRes.ok) slugsActive = await sRes.json();
        activeLoaded = true;
        // Kick off descriptions in the background. Don't await - the first
        // active question can render without its description; we patch in
        // the text when the bundle lands (renderDescription handles both).
        loadActiveDescriptions();
        return true;
      } catch {
        return false;
      }
    })();
    return activeLoadPromise;
  }

  // Active descriptions arrive as one ~7.6 MB file (brotli ~1.5 MB). Worth
  // keeping out of the critical path: the active dataset is enough to play,
  // and "show description ↓" is opt-in. Falls through silently on 404.
  function loadActiveDescriptions() {
    if (activeDescsPromise) return activeDescsPromise;
    activeDescsPromise = (async () => {
      try {
        const res = await fetch(`data/descriptions-active.json?v=${DATA_V}`);
        if (!res.ok) return false;
        const map = await res.json();
        Object.assign(descs, map);
        activeDescsLoaded = true;
        // If the user is currently on an active question, patch its
        // description in - same dance as the resolved-shard loader.
        if (current && prefs.dataMode === "active" && descs[current.id]) {
          renderDescription(descs[current.id]);
        }
        return true;
      } catch {
        return false;
      }
    })();
    return activeDescsPromise;
  }

  // Swap the global aliases to point at whichever dataset matches `mode`.
  // Also stash/restore per-mode deck state so picking a deck in active doesn't
  // wipe the resolved deck and vice versa. `silent` skips re-rendering (used
  // during init when callers will render).
  function sanitizeSubs(subs, tax) {
    if (!subs || !tax) return subs;
    const cleaned = {};
    for (const cat of Object.keys(tax)) {
      const valid = new Set((tax[cat] || []).map((x) => x.sub));
      const prev = subs[cat];
      if (prev) cleaned[cat] = prev.filter((s) => valid.has(s));
    }
    return cleaned;
  }

  function applyDataMode(mode, { silent = false } = {}) {
    if (prefs.dataMode !== mode) {
      if (!prefs._decks) prefs._decks = {};
      prefs._decks[prefs.dataMode] = { mode: prefs.mode, subs: prefs.subs };
      const next = prefs._decks[mode] || deckDefaults(mode);
      prefs.mode = next.mode;
      prefs.subs = next.subs;
    }
    if (mode === "active") {
      markets = marketsActive;
      taxonomy = taxonomyActive;
      slugs = slugsActive;
    } else {
      markets = marketsResolved;
      taxonomy = taxonomyResolved;
      slugs = slugsResolved;
    }
    // Drop stale cats/subs once the destination taxonomy is in scope.
    if (prefs.mode === "custom" && prefs.subs && taxonomy) {
      prefs.subs = sanitizeSubs(prefs.subs, taxonomy);
    }
    // First active-mode visit lands here with subs:null (deckDefaults). The
    // filteredPool fallback treats that as "show all", but the deck modal's
    // preset matcher and category grid both read it as "nothing selected" -
    // so the modal opens with Clear highlighted and every category off, even
    // though the deck is showing every market. Bootstrap subs to fully-on
    // here so what the user sees in the modal matches what they're playing.
    if (prefs.mode === "custom" && !prefs.subs && taxonomy && Object.keys(taxonomy).length) {
      prefs.subs = pickCats(taxonomy, Object.keys(taxonomy));
    }
    prefs.dataMode = mode;
    savePrefs();
    // Different mode = different deck universe; reset session-shown ledgers
    // so the soft event penalty and ordered-mode advancement start fresh.
    shownIds.clear();
    eventShowCounts.clear();
    if (!silent) {
      renderModeToggle();
      renderDeckStrip();
    }
  }

  // Sort row: label semantics flip with dataMode. In resolved mode "end" =
  // resolution date, so end-asc = oldest first, end-desc = newest first.
  // In active mode "end" = close date, so end-asc = closing soonest,
  // end-desc = closing latest. The button always submits the same `data-sort`
  // value; only the visible text changes.
  function renderSortRow() {
    const asc = $("btn-sort-end-asc");
    const desc = $("btn-sort-end-desc");
    if (asc && desc) {
      if (prefs.dataMode === "active") {
        asc.textContent = "Closing soonest";
        desc.textContent = "Closing latest";
      } else {
        asc.textContent = "Oldest first";
        desc.textContent = "Newest first";
      }
    }
    ["random", "end-asc", "end-desc"].forEach((s) => {
      const btn = document.querySelector(`.sort-row [data-sort="${s}"]`);
      if (!btn) return;
      const cur = prefs.sort === s;
      btn.classList.toggle("current", cur);
      btn.setAttribute("aria-checked", cur ? "true" : "false");
    });
  }

  function renderModeToggle() {
    const dm = prefs.dataMode;
    const r = $("btn-mode-resolved");
    const a = $("btn-mode-active");
    if (r && a) {
      r.classList.toggle("current", dm === "resolved");
      a.classList.toggle("current", dm === "active");
      r.setAttribute("aria-selected", dm === "resolved");
      a.setAttribute("aria-selected", dm === "active");
    }
    // Mirror the active mode onto the play-screen tag (passive label, not
    // a control - switching happens inside the deck modal).
    const tag = $("deck-mode-tag");
    if (tag) {
      tag.dataset.mode = dm;
      tag.textContent = dm === "active" ? "Live markets" : "Past markets";
    }
    // Help line under the modal toggle reflects which mode is active.
    const help = $("modal-mode-help");
    if (help) {
      help.textContent = dm === "active"
        ? "Currently-open questions. Your call lands in Open and gets scored when the market resolves."
        : "~37k resolved questions, instant scoring against the outcome and the closing market price.";
    }
  }

  // Descriptions are sharded into 4 files (Cloudflare Pages caps individual
  // files at 25 MiB and the full blob is ~25.1). Fetched in parallel after
  // first paint, merged into one map. If the user is on a question when its
  // shard lands we patch the rendered text in.
  // Slugs (~2MB raw / ~400KB brotli) ride alongside descriptions in the
  // background. Single file because well under the 25 MiB Pages cap.
  async function loadSlugs() {
    try {
      const res = await fetch(`data/slugs.json?v=${DATA_V}`);
      if (!res.ok) return;
      slugsResolved = await res.json();
      if (prefs.dataMode === "resolved") slugs = slugsResolved;
      // Patch the reveal link if reveal panel is currently visible.
      if (current && slugs[current.id]) {
        const link = $("r-link");
        if (link) {
          link.href = `https://polymarket.com/market/${slugs[current.id]}`;
          link.classList.remove("hidden");
        }
      }
    } catch { /* offline / 404 - reveal screen hides the link */ }
  }

  const DESC_SHARDS = 4;
  async function loadDescriptions() {
    let landed = 0;
    await Promise.all(
      Array.from({ length: DESC_SHARDS }, (_, i) =>
        fetch(`data/descriptions-${i}.json?v=${DATA_V}`)
          .then(r => r.ok ? r.json() : {})
          .then(shard => {
            Object.assign(descs, shard);
            landed += 1;
            if (current && descs[current.id]) renderDescription(descs[current.id]);
          })
          .catch(() => { /* offline / 404 - skip this shard */ })
      )
    );
    descsReady = landed > 0;
  }

  // ------- formatters -------
  function fmtVol(v) {
    if (!v) return "low vol";
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(1) + "B vol";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M vol";
    if (v >= 1e3) return "$" + (v / 1e3).toFixed(0) + "k vol";
    return "$" + Math.round(v) + " vol";
  }
  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }
  function fmtVolTick(v) {
    return "$" + v.toLocaleString();
  }
  function fmtPts(n) {
    if (n > 0) return "+" + n;
    return String(n);
  }
  function fmtNum(n) {
    return n.toLocaleString();
  }

  // ------- scoring -------
  function brierOf(p, o) { return (p - o) ** 2; }
  function logScore(p, o) {
    const q = o === 1 ? p : 1 - p;
    return -Math.log(Math.max(1e-6, Math.min(1 - 1e-6, q)));
  }
  // Earliest available market price (30d > 7d > 1d) - the more meaningful "alpha" benchmark
  function earliestMarketPrice(m) {
    if (m.p30 != null) return { p: m.p30, label: "30d before close" };
    if (m.p7  != null) return { p: m.p7,  label: "7d before close" };
    if (m.p1  != null) return { p: m.p1,  label: "1d before close" };
    return null;
  }
  // Cap on the market-beat term. We want it bounded so it doesn't dwarf the
  // calibration component in tail cases (predict 99% on a 1% market and
  // happen to be right, that's still mostly a calibration win, not "you
  // get +800 for disagreeing with everyone"). But the previous ±50 was
  // too tight on the downside: a user who said 36% on a NO that the
  // market had pinned at 1% had a Brier 1296x worse than the market's,
  // and only lost 50 points for it (capped from -130). At ±100 the cap
  // matches calibration's max upside, so "I lost to the market" hurts
  // about as much as "I was uncalibrated" can reward.
  const MARKET_BEAT_CAP = 100;
  function pointsFor(p, o, mktP) {
    const yourBrier = brierOf(p, o);
    const calibration = Math.round(100 - 400 * yourBrier);
    let marketBeat = 0;
    let mktBrier = null;
    if (mktP != null) {
      mktBrier = brierOf(mktP, o);
      const delta = mktBrier - yourBrier;  // positive = you beat market
      marketBeat = Math.max(-MARKET_BEAT_CAP, Math.min(MARKET_BEAT_CAP, Math.round(1000 * delta)));
    }
    return {
      yourBrier, mktBrier,
      calibration, marketBeat,
      total: calibration + marketBeat,
    };
  }

  // ------- view switching -------
  // Hash routing: each top-level view owns a #fragment so browser back/forward
  // works, deep links work (predictopoly.com/#stats), and Cloudflare Web
  // Analytics records each view as a distinct pageview (useful for funnel:
  // visit -> first prediction -> Stats). The welcome overlay and the deck
  // modal are intentionally NOT routes - they're transient UI, not destinations.
  const VIEW_NAMES = ["play", "open", "history", "stats"];
  function parseHash() {
    const h = (window.location.hash || "").replace(/^#/, "");
    return VIEW_NAMES.includes(h) ? h : null;
  }
  function showView(name, { fromHistory = false } = {}) {
    if (!VIEW_NAMES.includes(name)) name = "play";
    VIEW_NAMES.forEach((v) => {
      const el = $("view-" + v);
      if (el) el.classList.toggle("hidden", v !== name);
    });
    // Deck-strip is a sibling of the view sections, not a child of view-play.
    // It's only meaningful while predicting, so hide it on Open/History/Stats.
    const deckStrip = $("deck-strip");
    if (deckStrip) deckStrip.classList.toggle("hidden", name !== "play");
    $$(".navlink").forEach((b) => b.classList.toggle("current", b.dataset.view === name));
    currentView = name;
    // Sync URL only on user-initiated transitions; popstate-driven calls
    // already reflect the bar, calling pushState here would double up.
    // NB: must be window.history, not bare `history` - the IIFE has a local
    // `let history = loadHistory()` (user's prediction array) that shadows
    // window.history. Plain `history.pushState` throws and showView aborts
    // before the renderArchive/renderOpenTray/renderStats branches below.
    if (!fromHistory) {
      const wantHash = `#${name}`;
      if (window.location.hash !== wantHash) {
        window.history.pushState({ view: name }, "", wantHash);
      }
    }
    if (name === "stats") {
      loadChartJs(); // start fetching the chart lib in parallel with data
      renderStats();
      if (marketsAreFastPack) {
        loadFullMarkets().then((ok) => {
          if (ok && currentView === "stats") renderStats();
        });
      }
    } else if (name === "open") {
      renderOpenTray();
      // Re-sweep on tab visit so a user who keeps the tab open across a
      // market closing still sees their resolutions land. The 30s cooldown
      // inside checkPendingResolutions guards against view-toggle spam,
      // and the function no-ops if there are no past-due pendings.
      if (pending.length) checkPendingResolutions().catch(() => {});
    } else if (name === "history") {
      // History is always full-history, newest first - no scope toggle.
      // The "active" origin badge inside each row tells you which mode it
      // came from, which was the user-perceptible distinction anyway.
      renderArchive(history);
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  // ------- pool / pick -------
  function isSelected(cat, sub) {
    // UI-only: which sub-chips light up in the deck modal. In hot mode no
    // sub is "selected" in the cat/sub sense (selection is per-market).
    if (prefs.mode === "hot") return false;
    const arr = prefs.subs && prefs.subs[cat];
    if (!arr) return false;
    return arr.indexOf(sub) >= 0;
  }
  // Markets resolved within this window are too fresh to be reliably forgotten -
  // the user might just remember the news outcome instead of reasoning from priors.
  // 60 days catches "this month's headlines" without being overaggressive.
  const HINDSIGHT_DAYS = 60;
  function isHindsightSpoiler(m) {
    if (!m.t) return false;
    const days = (Date.now() - new Date(m.t).getTime()) / 86400000;
    return days >= 0 && days < HINDSIGHT_DAYS;
  }
  function marketPasses(m) {
    // Source of truth for "is this market in the active deck right now?"
    // Edition picks bypass the volume filter - they're hand-curated, the
    // filter is meant for taming the long tail of low-volume custom decks.
    if (prefs.dataMode === "active") {
      // Active markets have no `t` (close already happened) so the
      // hindsight-spoiler check never fires. Hot picks don't apply
      // (curation is resolved-only). Volume + sub selection same as resolved.
      const minVol = VOL_STEPS[prefs.volIdx];
      if ((m.v || 0) < minVol) return false;
      // In active mode, an empty selection means "show everything" instead
      // of nothing - fresh users haven't picked subs and shouldn't hit a
      // dead deck. The deck modal is the way to narrow down.
      if (!prefs.subs || Object.keys(prefs.subs).every(k => !(prefs.subs[k] || []).length)) {
        return true;
      }
      return isSelected(m.c, m.s);
    }
    if (isHindsightSpoiler(m)) return false;
    if (prefs.mode === "hot") return !!m.hot;
    const minVol = VOL_STEPS[prefs.volIdx];
    if ((m.v || 0) < minVol) return false;
    return isSelected(m.c, m.s);
  }
  function catState(cat) {
    // returns "on" | "partial" | "off". Only meaningful in custom mode -
    // hot mode reports "off" so deck cards don't get falsely highlighted.
    if (prefs.mode === "hot") return "off";
    const subs = (taxonomy[cat] || []).map((x) => x.sub);
    if (!subs.length) return "off";
    const selected = (prefs.subs && prefs.subs[cat]) || [];
    if (selected.length === 0) return "off";
    if (selected.length >= subs.length) return "on";
    return "partial";
  }
  function selectedCatCount() {
    return Object.keys(taxonomy).filter((c) => catState(c) !== "off").length;
  }
  function filteredPool() {
    if (prefs.dataMode === "active") {
      // Active mode: only dedup against the pending tray (already predicted).
      // Multi-outcome event slices ("Who wins 2028 Dem nom?" candidates) all
      // stay in the pool - the picker's weighted-random under-samples them
      // anyway because most slices sit near 0/1 and clamp to weight 0.1.
      const pendingIds = new Set(pending.map((p) => p.id));
      return markets.filter((m) => !pendingIds.has(m.id) && marketPasses(m));
    }
    const seen = new Set(history.map((h) => h.id));
    return markets.filter((m) => !seen.has(m.id) && marketPasses(m));
  }
  // Total deck size, ignoring seen history. For display, not for picking.
  function deckSize() {
    return markets.filter(marketPasses).length;
  }
  function pickQuestion() {
    const pool = filteredPool();
    if (!pool.length) return null;

    // Ordered modes: skip markets already shown this session, then pick the
    // earliest/latest end date. When the session set covers the whole pool,
    // the deck is exhausted (showEmptyDeck handles that upstream).
    if (prefs.sort === "end-asc" || prefs.sort === "end-desc") {
      const remaining = pool.filter((m) => !shownIds.has(m.id) && m.end);
      if (!remaining.length) {
        // All matching markets either lack end dates or were shown - fall
        // back to anything not shown so we don't dead-end on no-end-date data.
        const anyRemaining = pool.filter((m) => !shownIds.has(m.id));
        if (!anyRemaining.length) return null;
        return anyRemaining[0];
      }
      remaining.sort((a, b) => {
        const da = new Date(a.end).getTime();
        const db = new Date(b.end).getTime();
        return prefs.sort === "end-asc" ? da - db : db - da;
      });
      return remaining[0];
    }

    // Random (default): weighted by uncertainty, with a soft penalty for
    // events already shown this session. 0.2^k means once you've seen one
    // slice of "Who wins 2028 Dem nom?", the other 29 candidates aren't
    // hidden but they're 5x rarer; after two slices, 25x rarer. Slices are
    // still reachable on tight decks where they're all you've got.
    let total = 0;
    const weights = pool.map((m) => {
      const ref = (prefs.dataMode === "active") ? m.p_now : m.p7;
      const baseW = (ref != null) ? Math.max(0.1, 1 - 2 * Math.abs(ref - 0.5)) : 0.5;
      const k = m.ev ? (eventShowCounts.get(m.ev) || 0) : 0;
      const w = baseW * Math.pow(0.2, k);
      total += w;
      return w;
    });
    let r = Math.random() * total;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  // ------- top bar / score -------
  // Cumulative lifetime score across all predictions (Past + Live origins).
  // Sage-style persistent score pill; the daily-points framing was a
  // habit-nudge that doesn't match the calibration-trainer audience.
  function lifetimePoints() {
    return history.reduce((s, r) => s + (r.pts || 0), 0);
  }
  function renderSession() {
    const v = lifetimePoints();
    const el = $("session-val");
    el.textContent = fmtPts(v);
    el.classList.toggle("pos", v > 0);
    el.classList.toggle("neg", v < 0);
  }

  // ------- deck strip -------
  function renderDeckStrip() {
    const total = deckSize();
    const pool = filteredPool();
    if (prefs.dataMode === "active") {
      // Active mode has no "edition picks" - hot:true is curated against
      // resolved outcomes only. Show plain count or category-narrowed count.
      const cats = Object.keys(prefs.subs || {}).filter((c) => (prefs.subs[c] || []).length > 0);
      if (!cats.length) {
        $("deck-label").textContent = `all categories · ${fmtNum(total)} active`;
      } else if (cats.length === 1) {
        $("deck-label").textContent = `${cats[0]} · ${fmtNum(total)} active`;
      } else {
        $("deck-label").textContent = `${cats.length} categories · ${fmtNum(total)} active`;
      }
      return;
    }
    if (prefs.mode === "hot") {
      $("deck-label").textContent = `edition picks · ${fmtNum(total)} questions`;
      return;
    }
    const allCats = orderedTaxKeys();
    const activeCats = allCats.filter((c) => catState(c) !== "off");
    const allOn = allCats.every((c) => catState(c) === "on");
    let label;
    if (activeCats.length === 0) {
      label = "nothing selected";
    } else if (allOn) {
      label = `all categories · ${fmtNum(total)} questions`;
    } else if (activeCats.length === 1) {
      const cat = activeCats[0];
      const subs = (taxonomy[cat] || []).map((x) => x.sub);
      const sel  = (prefs.subs && prefs.subs[cat]) || [];
      let catLabel;
      if (sel.length >= subs.length) catLabel = cat;
      else if (sel.length === 1)     catLabel = `${cat} · ${sel[0]}`;
      else                           catLabel = `${cat} · ${sel.length} of ${subs.length}`;
      label = `${catLabel} · ${fmtNum(total)} questions`;
    } else {
      label = `${activeCats.length} categories · ${fmtNum(total)} questions`;
    }
    $("deck-label").textContent = label;
  }

  // ------- onboarding -------
  // Welcome card lives inside a fixed-position overlay so it floats above
  // the play screen instead of pushing the slider below the fold. Open
  // state is tracked on the overlay element; the inner card never carries
  // .hidden directly.
  function isOnboardingOpen() {
    const ov = $("welcome-overlay");
    return ov && !ov.classList.contains("hidden");
  }
  function setOnboardingOpen(open) {
    const ov = $("welcome-overlay");
    if (!ov) return;
    ov.classList.toggle("hidden", !open);
    // Lock background scroll while the overlay is up - same pattern as
    // the deck modal. Restore previous overflow on close.
    document.body.style.overflow = open ? "hidden" : "";
  }
  function renderOnboarding() {
    if (localStorage.getItem(LS_ONBOARD) === "1") return;
    // Don't show the welcome card to returning users (we treat any prior
    // resolved history OR pending active prediction as "they've used this").
    if (history.length > 0 || pending.length > 0) return;
    setOnboardingOpen(true);
  }
  function dismissOnboarding() {
    localStorage.setItem(LS_ONBOARD, "1");
    setOnboardingOpen(false);
  }
  // Topbar "?" re-opens the card on demand. Doesn't unset LS_ONBOARD - so
  // dismissing again is silent (no re-tutorial loop). Toggle behavior:
  // pressing "?" while open closes it without marking dismissed.
  function showOnboardingNow() {
    setOnboardingOpen(true);
  }
  function toggleOnboarding() {
    setOnboardingOpen(!isOnboardingOpen());
  }

  // ------- play view rendering -------
  function showQuestion(m) {
    current = m;
    shownIds.add(m.id);
    if (m.ev) eventShowCounts.set(m.ev, (eventShowCounts.get(m.ev) || 0) + 1);
    $("m-cat").textContent  = m.c || "";
    $("m-sub").textContent  = m.s || "";
    const dateEl = $("m-date");
    if (prefs.dataMode === "active") {
      // Active markets show "resolves in N days" instead of close date.
      // The endDate (m.end) goes into the tooltip so the precise calendar
      // date is one tap away.
      const days = m.days != null ? Math.max(0, Math.round(m.days)) : null;
      const txt = days != null
        ? (days === 0 ? "resolves today" : `resolves in ${days}d`)
        : "open";
      dateEl.textContent = txt;
      if (m.end) {
        dateEl.dataset.tip = `closes ${fmtDate(m.end)}`;
        dateEl.classList.add("has-tip");
      } else {
        delete dateEl.dataset.tip;
        dateEl.classList.remove("has-tip");
      }
    } else if (m.ts) {
      // Resolved with both open + close dates.
      dateEl.textContent = `${fmtDate(m.ts)} → ${fmtDate(m.t)}`;
      dateEl.dataset.tip = `opened ${fmtDate(m.ts)}, resolved ${fmtDate(m.t)}`;
      dateEl.classList.add("has-tip");
    } else {
      dateEl.textContent = `resolved ${fmtDate(m.t)}`;
      delete dateEl.dataset.tip;
      dateEl.classList.remove("has-tip");
    }
    $("m-vol").textContent  = fmtVol(m.v);
    const qEl = $("m-question");
    qEl.textContent = m.q || "";
    qEl.classList.remove("is-loading");
    $("m-yn").textContent = m.yn ? `(YES = ${m.yn})` : "";

    // description (may be empty if descriptions.json / descriptions-active.json
    // hasn't loaded yet - we patch it in when its loader lands the data)
    renderDescription(descs[m.id] || "");

    // reset slider
    const slider = $("p-slider");
    slider.value = "50";
    setBubble(50);

    // show predict, hide both reveals
    $("predict-block").classList.remove("hidden");
    $("reveal-block").classList.add("hidden");
    $("reveal-block-active").classList.add("hidden");

    // focus the slider so arrow keys work immediately and Enter submits
    requestAnimationFrame(() => slider.focus({ preventScroll: true }));
  }

  // Mobile-first viewport check, mirrored in style.css's @media block. On
  // phones the description is hidden so the question hugs the slider; on
  // desktop we surface a 3-line collapsed preview so the page doesn't feel
  // half-empty between the predict block and the footer.
  const MOBILE_MQ = "(max-width: 600px)";

  function renderDescription(text) {
    const descEl = $("m-desc");
    const toggleBtn = $("btn-desc-toggle");
    const t = (text || "").trim();

    if (!t.length) {
      descEl.classList.add("hidden");
      toggleBtn.classList.add("hidden");
      return;
    }

    descEl.textContent = t;
    toggleBtn.classList.remove("hidden");
    toggleBtn.textContent = "show description ↓";

    if (window.matchMedia(MOBILE_MQ).matches) {
      descEl.classList.add("hidden");
      descEl.classList.remove("collapsed");
    } else {
      descEl.classList.remove("hidden");
      descEl.classList.add("collapsed");
      // Short descriptions fit without scroll - drop the fade and the toggle
      // entirely so the toggle row doesn't lie about there being more text.
      requestAnimationFrame(() => {
        if (descEl.scrollHeight <= descEl.clientHeight + 2) {
          descEl.classList.remove("collapsed");
          toggleBtn.classList.add("hidden");
        }
      });
    }
  }

  function setBubble(v) {
    const b = $("p-bubble");
    // --p is a unitless 0..1 used inside calc() to position over the thumb's
    // actual travel range. See .bubble in style.css for the math.
    b.style.setProperty("--p", v / 100);
    b.textContent = v + "%";
  }

  // ------- submit / reveal -------
  function submit() {
    if (!current) return;
    const p = +$("p-slider").value / 100;

    if (prefs.dataMode === "active") {
      submitActive(p);
      return;
    }

    const o = current.o;
    const mp = earliestMarketPrice(current);
    const score = pointsFor(p, o, mp ? mp.p : null);

    const rec = {
      id: current.id, q: current.q,
      p, o,
      brier: score.yourBrier,
      log: logScore(p, o),
      pts: score.total,
      ptsCal: score.calibration,
      ptsMkt: score.marketBeat,
      c: current.c, s: current.s,
      mkt30: current.p30, mkt7: current.p7, mkt1: current.p1,
      origin: "resolved",   // Stats scope filter; legacy entries default to resolved.
      t: Date.now(),
    };
    history.push(rec);
    saveHistory();
    renderReveal(rec, current, score, mp);
    renderSession();
    fetchPercentile(current.id, p, score.yourBrier);
  }

  function submitActive(p) {
    const m = current;

    const rec = {
      id: m.id,
      q: m.q,
      p,
      // Snapshot of the market price at submit time. Phase B's resolver
      // upgrades this entry to a scored history record using p_at_submit
      // as the "market said" benchmark, so it stays honest even if the
      // market moves before resolution.
      p_at_submit: m.p_now,
      c: m.c, s: m.s,
      ev: m.ev || null,
      end: m.end || "",
      v: m.v || 0,
      // Carry the YES-side label so we can render the disambiguated
      // outcome ("YES (Weibo)") when the resolver scores this entry.
      // Without this the upgraded history record would lose the alias
      // because the source market is gone from the active deck by then.
      yn: m.yn || "",
      status: "pending",
      t: Date.now(),
    };
    pending.push(rec);
    savePending();
    renderNavCount();
    renderRevealActive(rec, m);
    logActivePrediction(m.id, p);
  }

  function renderRevealActive(rec, m) {
    $("predict-block").classList.add("hidden");
    $("reveal-block").classList.add("hidden");
    $("reveal-block-active").classList.remove("hidden");

    const youPct = Math.round(rec.p * 100);
    const mktPct = Math.round(rec.p_at_submit * 100);
    const delta = youPct - mktPct;

    $("ra-you").textContent = youPct + "%";
    $("ra-mkt").textContent = mktPct + "%";
    const dEl = $("ra-delta");
    dEl.textContent = (delta > 0 ? "+" : "") + delta + "pp";
    dEl.classList.remove("pos", "neg", "zero");
    if (delta > 0) dEl.classList.add("pos");
    else if (delta < 0) dEl.classList.add("neg");
    else dEl.classList.add("zero");

    const endEl = $("ra-end");
    if (m.end) {
      const days = m.days != null ? Math.max(0, Math.round(m.days)) : null;
      endEl.textContent = days != null
        ? `closes ${fmtDate(m.end)} (in ${days}d)`
        : `closes ${fmtDate(m.end)}`;
    } else {
      endEl.textContent = "";
    }

    const link = $("ra-link");
    const slug = slugs[m.id];
    if (slug) {
      link.href = `https://polymarket.com/market/${slug}`;
      link.classList.remove("hidden");
    } else {
      link.removeAttribute("href");
      link.classList.add("hidden");
    }
  }

  // ------- open tray -------
  // Pending records are always active-market predictions, so slugs come from
  // slugsActive specifically (the global `slugs` alias might be pointing at
  // resolved slugs if the user is in resolved mode). If active data hasn't
  // been loaded yet this session we kick it off so links light up shortly
  // after the tray paints.
  function renderNavCount() {
    const el = $("nav-open-count");
    if (!el) return;
    const n = pending.length;
    if (n > 0) {
      el.textContent = String(n);
      el.classList.remove("hidden");
    } else {
      el.textContent = "";
      el.classList.add("hidden");
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
    ));
  }

  function renderOpenTray() {
    const list = $("open-list");
    const empty = $("open-empty");
    if (!list || !empty) return;

    if (!pending.length) {
      list.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    // Make sure active slugs are in flight even if user is in resolved mode -
    // pending links resolve once the file lands.
    if (!activeLoaded) loadActiveData();

    // Sort by closing date ascending; rows with no `end` sink to the bottom.
    const rows = pending.slice().sort((a, b) => {
      const ea = a.end ? new Date(a.end).getTime() : Infinity;
      const eb = b.end ? new Date(b.end).getTime() : Infinity;
      if (ea !== eb) return ea - eb;
      return (b.t || 0) - (a.t || 0);
    });

    const now = Date.now();
    const html = rows.map((r) => {
      const youPct = Math.round(r.p * 100);
      const mktPct = Math.round((r.p_at_submit ?? 0) * 100);
      const delta = youPct - mktPct;
      const deltaCls = delta > 0 ? "pos" : (delta < 0 ? "neg" : "zero");
      const deltaTxt = (delta > 0 ? "+" : "") + delta + "pp";

      let endTxt = "";
      let endCls = "muted";
      if (r.end) {
        const endMs = new Date(r.end).getTime();
        const days = Math.round((endMs - now) / 86400000);
        if (isNaN(endMs)) {
          endTxt = "";
        } else if (days < 0) {
          endTxt = `closed ${fmtDate(r.end)} - awaiting resolution`;
          endCls = "muted warn";
        } else if (days === 0) {
          endTxt = `closes today (${fmtDate(r.end)})`;
        } else if (days === 1) {
          endTxt = `closes tomorrow (${fmtDate(r.end)})`;
        } else {
          endTxt = `closes in ${days}d (${fmtDate(r.end)})`;
        }
      }

      const slug = slugsActive[r.id];
      const linkHtml = slug
        ? `<a class="open-link" href="https://polymarket.com/market/${escapeHtml(slug)}" target="_blank" rel="noopener">view on Polymarket ↗</a>`
        : "";

      const tag = (r.c && r.s) ? `${escapeHtml(r.c)} · ${escapeHtml(r.s)}` : (r.c ? escapeHtml(r.c) : "");

      return `
        <article class="open-row" data-id="${escapeHtml(r.id)}">
          <header class="open-row-head">
            <span class="open-tag">${tag}</span>
            <span class="open-end ${endCls}">${escapeHtml(endTxt)}</span>
          </header>
          <h3 class="open-q">${escapeHtml(r.q)}</h3>
          <div class="open-bars">
            <div class="open-bar">
              <span class="open-bar-lbl">you</span>
              <span class="open-bar-val">${youPct}%</span>
            </div>
            <div class="open-bar">
              <span class="open-bar-lbl">market at submit</span>
              <span class="open-bar-val">${mktPct}%</span>
            </div>
            <div class="open-bar open-delta">
              <span class="open-bar-lbl">delta</span>
              <span class="open-bar-val ${deltaCls}">${deltaTxt}</span>
            </div>
          </div>
          ${linkHtml ? `<div class="open-row-foot">${linkHtml}</div>` : ""}
        </article>
      `;
    }).join("");

    list.innerHTML = html;
  }

  function renderReveal(rec, m, score, mp) {
    $("predict-block").classList.add("hidden");
    $("reveal-block").classList.remove("hidden");

    // outcome
    const outEl = $("r-outcome");
    if (rec.o === 1) {
      outEl.textContent = m.yn ? `YES (${m.yn})` : "YES";
      outEl.className = "callout-outcome yes";
    } else {
      const noLabel = m.yn ? `NO (not ${m.yn})` : "NO";
      outEl.textContent = noLabel;
      outEl.className = "callout-outcome no";
    }

    // points
    const pts = score.total;
    const ptsEl = $("r-points");
    ptsEl.textContent = fmtPts(pts);
    ptsEl.classList.remove("pos", "neg", "zero");
    if (pts > 0) ptsEl.classList.add("pos");
    else if (pts < 0) ptsEl.classList.add("neg");
    else ptsEl.classList.add("zero");

    // breakdown
    const parts = [];
    parts.push(`${fmtPts(score.calibration)} calibration`);
    if (mp) {
      parts.push(`${fmtPts(score.marketBeat)} beat market`);
    }
    $("r-breakdown").textContent = "(" + parts.join(" · ") + ")";

    // callout color
    const callout = $("r-callout");
    callout.classList.remove("win", "loss");
    if (pts > 0) callout.classList.add("win");
    else if (pts < 0) callout.classList.add("loss");

    // bars
    const bars = $("bars");
    bars.innerHTML = "";
    const rows = [
      { lbl: "You",        val: rec.p,  cls: "you" },
      { lbl: "Market 30d", val: m.p30,  cls: "mkt" },
      { lbl: "Market 7d",  val: m.p7,   cls: "mkt" },
      { lbl: "Market 1d",  val: m.p1,   cls: "mkt" },
    ];
    for (const r of rows) {
      if (r.val == null) continue;
      const div = document.createElement("div");
      div.className = "bar-row";
      div.innerHTML = `<span class="lbl">${r.lbl}</span><div class="bar-track"><div class="bar ${r.cls}" style="width:${(r.val * 100).toFixed(1)}%"></div></div><span class="val">${(r.val * 100).toFixed(1)}%</span>`;
      bars.appendChild(div);
    }

    // Show the percentile line immediately with a placeholder so it
    // doesn't slide in late after the points/bars have settled. The
    // backend fills the real number in within ~100-300ms; on failure or
    // n<3 we hide the line again (one-time layout shift, but only on the
    // sad path).
    const pctEl = $("r-percentile");
    const pctVal = $("r-percentile-val");
    pctEl.classList.remove("hidden");
    pctVal.textContent = "···";
    pctVal.classList.add("loading-pulse");

    // link + meta - slug is lazy-loaded, hide link until it lands
    const link = $("r-link");
    const slug = slugs[m.id];
    if (slug) {
      link.href = `https://polymarket.com/market/${slug}`;
      link.classList.remove("hidden");
    } else {
      link.removeAttribute("href");
      link.classList.add("hidden");
    }
    const mpTxt = mp ? `· market said ${(mp.p * 100).toFixed(0)}% (${mp.label})` : "";
    $("r-meta-foot").textContent = `resolved ${fmtDate(m.t)} ${mpTxt}`.trim();
  }

  // ------- resolved-sweep banner (Phase B.3 surface) -------
  // Tiny session-only state so we don't double-prompt within the same load.
  // We deliberately don't persist dismissal: if the user reloads tomorrow
  // and another sweep resolves more entries, they should see the new count.
  function showResolvedBanner(n) {
    const el = $("resolved-banner");
    const txt = $("resolved-banner-text");
    if (!el || !txt) return;
    txt.innerHTML = `<b>${n}</b> live-market prediction${n === 1 ? "" : "s"} just resolved.`;
    el.classList.remove("hidden");
  }
  function hideResolvedBanner() {
    const el = $("resolved-banner");
    if (el) el.classList.add("hidden");
  }

  // ------- resolution upgrade (Phase B.3) -------
  // Pending entries past their endDate are candidates for resolution.
  // We POST batches of ids to /api/check-resolution; for each market that
  // gamma reports as definitively resolved (closed=true + outcome >=0.99),
  // we score with pointsFor(rec.p, outcome, p_at_submit), build a history
  // record marked origin:"active", remove from pending, and push to history.
  // Markets whose endDate has passed but haven't resolved yet stay pending
  // and get re-checked on the next boot / button press.
  let checkingResolutions = false;
  let lastResolutionCheck = 0;
  const RESOLUTION_CHECK_COOLDOWN_MS = 30_000;

  async function checkPendingResolutions() {
    if (checkingResolutions) return { checked: 0, resolved: 0 };
    // Cheap rate limit. Sweep fires on boot AND every time the user
    // navigates to the Open tray, so without a cooldown a quick toggle
    // between views would hammer gamma. Edge cache absorbs most of this
    // anyway, but no reason to be rude.
    const now = Date.now();
    if (now - lastResolutionCheck < RESOLUTION_CHECK_COOLDOWN_MS) {
      return { checked: 0, resolved: 0 };
    }

    // Anything whose endDate is in the past is fair game. We don't filter
    // by some grace period because gamma already gates closed=true; if it
    // hasn't flipped yet we'll just get resolved:false and try again next time.
    const due = pending.filter((r) => {
      if (!r.end) return false;
      const t = new Date(r.end).getTime();
      return Number.isFinite(t) && t < now;
    });
    if (!due.length) return { checked: 0, resolved: 0 };

    checkingResolutions = true;
    lastResolutionCheck = now;

    const resolvedIds = new Set();
    try {
      // Pages Function caps at 50 ids per call; chunk accordingly. Most
      // users will have <10 pending so this loop runs once.
      for (let i = 0; i < due.length; i += 50) {
        const chunk = due.slice(i, i + 50);
        const ids = chunk.map((r) => r.id);
        let data;
        try {
          const res = await fetch("/api/check-resolution", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids }),
          });
          if (!res.ok) continue;
          data = await res.json();
        } catch {
          // Network blip - leave the chunk pending, try again next boot.
          continue;
        }

        const resolutions = (data && data.resolutions) || {};
        for (const rec of chunk) {
          const r = resolutions[rec.id];
          if (!r || !r.resolved) continue;

          // r.o is the YES indicator: 1 if YES happened, 0 if NO. Old
          // contract was r.outcome (winning index, 0 or 1) and assumed
          // index 0 = NO, which was inverted - see check-resolution.js.
          // During the brief window where edge cache might still hold an
          // old-shape response (s-maxage=60), r.o is undefined and we skip.
          if (r.o !== 0 && r.o !== 1) continue;
          const o = r.o;
          const mktP = (typeof rec.p_at_submit === "number") ? rec.p_at_submit : null;
          const score = pointsFor(rec.p, o, mktP);

          const hist = {
            id: rec.id,
            q: rec.q,
            p: rec.p,
            o,
            brier: score.yourBrier,
            log: logScore(rec.p, o),
            pts: score.total,
            ptsCal: score.calibration,
            ptsMkt: score.marketBeat,
            c: rec.c, s: rec.s,
            // Active-mode entries don't have lookback prices - the only
            // benchmark we have is the price at submit time. Stash it as
            // mkt1 so the reveal/stats code that already understands those
            // fields keeps working without a special case.
            mkt30: null, mkt7: null, mkt1: mktP,
            yn: rec.yn || "",
            origin: "active",
            t: Date.now(),
            // Snapshot of when the market actually resolved (best effort -
            // gamma doesn't always tell us the exact timestamp, so we use
            // the check time as a proxy). Useful for stats slicing later.
            t_resolved: Date.now(),
            // Keep the "you predicted at" timestamp so calibration over
            // time still attributes to when the user actually thought.
            t_predicted: rec.t || null,
            // Marker that this record was resolved with the corrected
            // YES-index mapping. Older entries lack this and get repaired
            // by the boot migration in repairFlippedActiveHistory().
            resolution_v: 2,
          };
          history.push(hist);
          resolvedIds.add(rec.id);
        }
      }

      if (resolvedIds.size > 0) {
        pending = pending.filter((r) => !resolvedIds.has(r.id));
        savePending();
        saveHistory();
        renderNavCount();
        renderSession();
        if (currentView === "open") renderOpenTray();
        else if (currentView === "stats") renderStats();
        // Surface the result on the Play view so the user notices the
        // resolution sweep happened. Without this the only signal is the
        // nav badge ticking down, which is too quiet for "your prediction
        // got scored - here are your points".
        showResolvedBanner(resolvedIds.size);
      }
    } finally {
      checkingResolutions = false;
    }

    return { checked: due.length, resolved: resolvedIds.size };
  }

  // One-shot repair: re-resolve any active-mode history entries scored with
  // the inverted YES-index mapping (resolution_v missing or < 2). Hits the
  // same /api/check-resolution endpoint - now fixed - and rewrites o, brier,
  // log, pts, ptsCal, ptsMkt in place. Setting resolution_v=2 prevents
  // re-running on subsequent boots. Silent on failure: the entry stays
  // wrong but we'll retry next session. We don't show the resolved banner -
  // this is a quiet correction, not a new resolution.
  async function repairFlippedActiveHistory() {
    const broken = history.filter(
      (h) => h && h.origin === "active" && (h.resolution_v == null || h.resolution_v < 2),
    );
    if (!broken.length) return;

    const ids = broken.map((h) => h.id).filter((x) => typeof x === "string" && x.length);
    if (!ids.length) return;

    let data;
    try {
      const res = await fetch("/api/check-resolution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ids.slice(0, 50) }),
      });
      if (!res.ok) return;
      data = await res.json();
    } catch {
      return;
    }

    const resolutions = (data && data.resolutions) || {};
    let changed = 0;
    for (const h of broken) {
      const r = resolutions[h.id];
      if (!r || !r.resolved) continue;
      if (r.o !== 0 && r.o !== 1) continue;
      const mktP = (typeof h.mkt1 === "number") ? h.mkt1 : null;
      const score = pointsFor(h.p, r.o, mktP);
      h.o = r.o;
      h.brier = score.yourBrier;
      h.log = logScore(h.p, r.o);
      h.pts = score.total;
      h.ptsCal = score.calibration;
      h.ptsMkt = score.marketBeat;
      h.resolution_v = 2;
      changed++;
    }
    if (changed > 0) {
      saveHistory();
      renderSession();
      if (currentView === "history") renderArchive(history);
      else if (currentView === "stats") renderStats();
    }
  }

  // ------- percentile (backend) -------
  // Resolved-mode submit: send {qid, p, brier, mode:"resolved", session_id},
  // get back {percentile, n}. The server logs the row for population stats
  // and ranks the user's brier against everyone else's on this question.
  async function fetchPercentile(qid, p, brier) {
    try {
      const res = await fetch("/api/percentile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qid,
          p,
          brier,
          mode: "resolved",
          session_id: getSessionId(),
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const pctVal = $("r-percentile-val");
      pctVal.classList.remove("loading-pulse");
      if (data && typeof data.percentile === "number" && data.n >= 3) {
        pctVal.textContent = `${Math.round(data.percentile)}%`;
        $("r-percentile").classList.remove("hidden");
      } else {
        // Not enough plays yet to show a meaningful percentile.
        $("r-percentile").classList.add("hidden");
      }
    } catch {
      // Offline or no backend. Hide the placeholder rather than leave it pulsing.
      $("r-percentile-val").classList.remove("loading-pulse");
      $("r-percentile").classList.add("hidden");
    }
  }

  // Active-mode submit: same endpoint but no brier (the question hasn't
  // resolved yet). Pure logging - we don't care about the response, just
  // that the row lands so we can compute population calibration / mode
  // splits / per-session engagement later.
  function logActivePrediction(qid, p) {
    fetch("/api/percentile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        qid,
        p,
        mode: "active",
        session_id: getSessionId(),
      }),
      keepalive: true,
    }).catch(() => {});
  }

  // ------- next / skip -------
  function showEmptyDeck(show) {
    const empty = $("empty-deck");
    if (!empty) return;
    empty.classList.toggle("hidden", !show);
    // When the empty state is shown we hide the question/predict/reveal so
    // the layout doesn't carry leftover content from a previous question.
    const toToggle = ["m-question", "m-desc", "btn-desc-toggle", "predict-block",
                      "reveal-block", "reveal-block-active"];
    for (const id of toToggle) {
      const el = $(id);
      if (el) el.classList.toggle("hidden", show);
    }
    const meta = document.querySelector(".meta-line");
    if (meta) meta.classList.toggle("hidden", show);
  }

  async function nextQuestion() {
    let q = pickQuestion();
    // Custom decks won't be satisfied by the hot-only fast pack. Block briefly
    // for the full set if it's still in flight, then retry. (Resolved-mode
    // only - active loads its full file in one shot, no fast pack.)
    if (!q && prefs.dataMode === "resolved" && marketsAreFastPack) {
      await loadFullMarkets();
      q = pickQuestion();
    }
    if (!q) {
      // Inline empty state - much better than a native alert + auto-opening
      // the deck modal, which made the app feel broken on every empty pool.
      showEmptyDeck(true);
      current = null;
      return;
    }
    showEmptyDeck(false);
    showQuestion(q);
  }
  function skipQuestion() { nextQuestion(); }

  // ------- deck modal -------
  function openDeckModal() {
    renderPresets();
    renderDeckGrid();
    renderSortRow();
    updateDeckPoolInfo();
    $("deck-modal").classList.remove("hidden");
    document.body.style.overflow = "hidden";
    // Counts in the deck grid come from the markets array. Hot-only fast pack
    // shows tiny numbers; pull the full set and re-render when it lands.
    if (marketsAreFastPack) {
      loadFullMarkets().then((ok) => {
        if (!ok) return;
        if ($("deck-modal").classList.contains("hidden")) return;
        renderPresets();
        renderDeckGrid();
        updateDeckPoolInfo();
      });
    }
  }

  function applyPreset(presetId) {
    const p = PRESETS.find((x) => x.id === presetId);
    if (!p) return;
    if (p.hotFlag) {
      prefs.mode = "hot";
    } else {
      prefs.mode = "custom";
      prefs.subs = p.build(taxonomy);
    }
    savePrefs();
    renderPresets();
    renderDeckGrid();
    updateDeckPoolInfo();
  }

  // When the user starts toggling cats/subs while in hot mode, leave them with
  // an empty selection so their first click reads as the explicit choice
  // ("show me only AI & Tech") rather than getting added on top of a broad
  // baseline.
  function bootstrapCustomFromHot() {
    if (prefs.mode !== "hot") return;
    prefs.subs = {};
    prefs.mode = "custom";
  }

  // A preset matches if it produces the same effective deck as the current state.
  function presetMatches(preset) {
    if (preset.hotFlag) return prefs.mode === "hot";
    if (prefs.mode === "hot") return false;
    const target = preset.build(taxonomy);
    const cur = prefs.subs || {};
    const tCats = Object.keys(target);
    const cCats = Object.keys(cur).filter((c) => (cur[c] || []).length > 0);
    if (tCats.length !== cCats.length) return false;
    for (const c of tCats) {
      const a = (target[c] || []).slice().sort();
      const b = (cur[c] || []).slice().sort();
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function renderPresets() {
    const wrap = $("deck-presets");
    wrap.innerHTML = "";
    for (const p of PRESETS) {
      // "Edition picks" is a curated allowlist against resolved outcomes -
      // doesn't apply to active markets. Hide it in active mode.
      if (p.hotFlag && prefs.dataMode === "active") continue;
      const btn = document.createElement("button");
      btn.className = "preset" + (presetMatches(p) ? " on" : "");
      btn.title = p.hint;
      btn.textContent = p.label;
      btn.addEventListener("click", () => applyPreset(p.id));
      wrap.appendChild(btn);
    }
  }
  function closeDeckModal() {
    $("deck-modal").classList.add("hidden");
    document.body.style.overflow = "";
    renderDeckStrip();
    // Re-pick if current is gone (we were in empty state) or if the
    // current question no longer matches the new filters. Either path
    // also clears the empty-deck panel via nextQuestion's normal flow.
    if (!current || !marketPasses(current)) {
      nextQuestion();
    }
  }

  // expanded category cards (UI state, not persisted)
  const expandedCats = new Set();

  function setCatAll(cat, on) {
    bootstrapCustomFromHot();
    if (!prefs.subs) prefs.subs = {};
    if (on) {
      prefs.subs[cat] = (taxonomy[cat] || []).map((x) => x.sub);
    } else {
      prefs.subs[cat] = [];
    }
    savePrefs();
  }
  function toggleSub(cat, sub) {
    bootstrapCustomFromHot();
    if (!prefs.subs) prefs.subs = {};
    const list = prefs.subs[cat] ? prefs.subs[cat].slice() : [];
    const idx = list.indexOf(sub);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(sub);
    prefs.subs[cat] = list;
    savePrefs();
  }

  function renderDeckGrid() {
    const grid = $("deck-grid");
    grid.innerHTML = "";
    const cats = orderedTaxKeys();
    const playedByCat = {};
    for (const r of history) {
      if (!playedByCat[r.c]) playedByCat[r.c] = { n: 0, pts: 0 };
      playedByCat[r.c].n++;
      playedByCat[r.c].pts += (r.pts || 0);
    }
    for (const cat of cats) {
      const subs = taxonomy[cat] || [];
      const total = subs.reduce((s, x) => s + x.n, 0);
      const played = playedByCat[cat];
      const state = catState(cat);
      const expanded = expandedCats.has(cat);
      const card = document.createElement("div");
      card.className = "deck-card";
      if (state === "on") card.classList.add("on");
      if (state === "partial") card.classList.add("partial");
      if (expanded) card.classList.add("expanded");

      let playedHtml = "";
      if (played) {
        const avg = Math.round(played.pts / played.n);
        playedHtml = `<div class="deck-played">${played.n} played · avg ${fmtPts(avg)}</div>`;
      }

      let summary = `${fmtNum(total)} questions`;
      if (state === "partial") {
        const sel = (prefs.subs && prefs.subs[cat]) || [];
        summary = `${sel.length} of ${subs.length} subs · ${fmtNum(total)} qs`;
      }

      const onlySub = subs.length <= 1;
      // The previous standalone ▸ chevron was small enough to read as a
      // dot. Pair it with an explicit "subs" label and rotate the glyph on
      // expand so the affordance is unmissable.
      const expBtn = onlySub ? "" : `<button class="deck-exp${expanded ? " open" : ""}" type="button" title="${expanded ? "collapse subcategories" : "show subcategories"}" aria-expanded="${expanded}"><span class="deck-exp-label">subs</span><span class="deck-exp-caret" aria-hidden="true">▾</span></button>`;

      card.innerHTML = `
        <div class="deck-head">
          <div class="deck-head-text">
            <div class="deck-name">${cat}</div>
            <div class="deck-count">${summary}</div>
            ${playedHtml}
          </div>
          ${expBtn}
        </div>
      `;

      // expand/collapse
      const expEl = card.querySelector(".deck-exp");
      if (expEl) {
        expEl.addEventListener("click", (e) => {
          e.stopPropagation();
          if (expandedCats.has(cat)) expandedCats.delete(cat);
          else expandedCats.add(cat);
          renderDeckGrid();
        });
      }

      // Toggle whole category by clicking anywhere on the card (mobile users
      // were missing the small text region and tapping padding produced nothing).
      // The expand chevron and sub-chips already stopPropagation, so their
      // own actions don't double-fire here.
      card.addEventListener("click", (e) => {
        // Defensive: if a click landed on something inside the card that we
        // don't expect to toggle (links, etc), bail. Today everything inside
        // either is the head-text or has its own stopPropagation.
        if (e.target.closest(".deck-exp, .sub-chip")) return;
        setCatAll(cat, state !== "on");
        renderPresets();
        renderDeckGrid();
        updateDeckPoolInfo();
      });

      // expanded sub chips
      if (expanded && subs.length > 1) {
        const chipWrap = document.createElement("div");
        chipWrap.className = "deck-subs";
        for (const sObj of subs) {
          const chip = document.createElement("button");
          chip.className = "sub-chip" + (isSelected(cat, sObj.sub) ? " on" : "");
          chip.innerHTML = `<span class="sub-name">${sObj.sub}</span><span class="sub-n">${fmtNum(sObj.n)}</span>`;
          chip.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleSub(cat, sObj.sub);
            renderPresets();
            renderDeckGrid();
            updateDeckPoolInfo();
          });
          chipWrap.appendChild(chip);
        }
        card.appendChild(chipWrap);
      }

      grid.appendChild(card);
    }
    // "clear" link disables when nothing's selected - feedback that the
    // action is a no-op rather than letting the user click into nothing.
    const anySelected = Object.values(prefs.subs || {}).some(
      (arr) => Array.isArray(arr) && arr.length > 0
    );
    const clearBtn = $("btn-clear-cats");
    if (clearBtn) clearBtn.disabled = !anySelected && prefs.mode !== "hot";
  }
  function updateDeckPoolInfo() {
    const v = VOL_STEPS[prefs.volIdx];
    $("vol-label").textContent = fmtVolTick(v);
    const total = deckSize();
    const unseen = filteredPool().length;
    if (total === 0) {
      $("deck-pool-info").textContent = "no questions match";
    } else if (unseen === total) {
      $("deck-pool-info").textContent = `${fmtNum(total)} questions match`;
    } else {
      $("deck-pool-info").textContent = `${fmtNum(total)} questions match · ${fmtNum(unseen)} unseen`;
    }
  }

  // ------- stats -------
  // Records get tagged with `origin: "resolved"` on submit; phase B.3 will
  // tag auto-resolved active picks with `origin: "active"`. Legacy entries
  // have no origin and are treated as resolved (only resolved mode could
  // produce history before this field existed).
  function statsHistory() {
    if (statsScope === "all") return history;
    if (statsScope === "active") return history.filter((r) => r.origin === "active");
    return history.filter((r) => (r.origin || "resolved") === "resolved");
  }

  function renderStatsScopeUI() {
    ["all", "resolved", "active"].forEach((s) => {
      const btn = $("btn-stats-" + s);
      if (!btn) return;
      const cur = statsScope === s;
      btn.classList.toggle("current", cur);
      btn.setAttribute("aria-selected", cur ? "true" : "false");
    });
    const note = $("stats-scope-note");
    if (!note) return;
    if (statsScope === "active") {
      const resolved = history.filter((r) => r.origin === "active").length;
      const open = pending.length;
      const bits = [];
      if (open > 0) bits.push(`${open} open prediction${open === 1 ? "" : "s"} awaiting resolution`);
      if (resolved === 0 && open === 0) {
        bits.push("No live-market predictions yet - switch to Live markets and make one.");
      } else if (resolved === 0 && open > 0) {
        bits.push("Stats fill in once your open predictions resolve.");
      }
      note.textContent = bits.join(" · ");
      note.classList.toggle("hidden", !bits.length);
    } else {
      note.textContent = "";
      note.classList.add("hidden");
    }
  }

  function renderStats() {
    renderStatsScopeUI();
    const hist = statsHistory();
    const n = hist.length;
    $("s-count").textContent = n;
    if (n === 0) {
      $("s-points").textContent = "0";
      $("s-ppq").textContent = "-";
      $("s-brier").textContent = "-";
      $("s-log").textContent = "-";
      $("s-vs-mkt").textContent = "-";
      const emptyMsg = statsScope === "active"
        ? 'Live-market scores show up here when your <b>Open</b> predictions resolve on Polymarket.'
        : 'Predict a few questions to see your calibration breakdown.';
      $("s-by-cat").innerHTML = `<div class="muted small">${emptyMsg}</div>`;
      renderPatternVerdict(hist);
      renderReliability(hist);
      const missesSection = $("biggest-misses-section");
      if (missesSection) missesSection.classList.add("hidden");
      return;
    }
    const totalPts = hist.reduce((s, r) => s + (r.pts || 0), 0);
    const ppq = totalPts / n;
    const meanBrier = hist.reduce((s, r) => s + r.brier, 0) / n;
    const meanLog = hist.reduce((s, r) => s + r.log, 0) / n;

    const pEl = $("s-points");
    pEl.textContent = fmtPts(totalPts);
    pEl.classList.toggle("pos", totalPts > 0);
    pEl.classList.toggle("neg", totalPts < 0);

    const ppqEl = $("s-ppq");
    ppqEl.textContent = fmtPts(Math.round(ppq));
    ppqEl.classList.toggle("pos", ppq > 0);
    ppqEl.classList.toggle("neg", ppq < 0);

    $("s-brier").textContent = meanBrier.toFixed(3);
    $("s-log").textContent = meanLog.toFixed(3);

    const withMkt = hist.filter((r) => r.mkt30 != null || r.mkt7 != null || r.mkt1 != null);
    if (withMkt.length >= 3) {
      let yourB = 0, mktB = 0;
      for (const r of withMkt) {
        const mp = r.mkt30 ?? r.mkt7 ?? r.mkt1;
        yourB += r.brier;
        mktB += brierOf(mp, r.o);
      }
      yourB /= withMkt.length; mktB /= withMkt.length;
      const diff = mktB - yourB;
      const sign = diff > 0 ? "+" : "";
      $("s-vs-mkt").innerHTML = `<span title="positive = you beat the market">${yourB.toFixed(3)} vs ${mktB.toFixed(3)} <span class="${diff > 0 ? 'pos' : (diff < 0 ? 'neg' : '')}">(${sign}${diff.toFixed(3)})</span></span>`;
    } else {
      $("s-vs-mkt").innerHTML = `<span class="muted small">need ${3 - withMkt.length} more</span>`;
    }

    renderPatternVerdict(hist);
    renderReliability(hist);
    renderBiggestMisses(hist);
    renderByCategory(hist);
  }

  // ------- pattern verdict -------
  // One-line, sample-size-honest read of where the user's calibration is
  // off. Uses 5 wide buckets (20pp each) instead of the chart's 10 narrow
  // ones - we're after a robust signal, not chart fidelity. Below 20
  // scored predictions we don't make claims about bias, we just say the
  // sample is too small. Sample-size honesty matters more than bravado:
  // an early "you're overconfident at 80%" off 4 data points is teaching
  // the user to chase noise.
  function renderPatternVerdict(hist) {
    const el = $("pattern-verdict");
    if (!el) return;
    const n = hist.length;
    if (n === 0) { el.innerHTML = ""; el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    if (n < 20) {
      const need = 20 - n;
      el.innerHTML = `<b>${n} scored ${n === 1 ? "prediction" : "predictions"} so far.</b> Need ${need} more before we can read patterns from your data - small samples lie.`;
      return;
    }
    const buckets = Array.from({ length: 5 }, () => ({ pred: 0, actual: 0, n: 0 }));
    for (const r of hist) {
      const idx = Math.min(4, Math.floor(r.p * 5));
      buckets[idx].pred += r.p;
      buckets[idx].actual += r.o;
      buckets[idx].n += 1;
    }
    let worst = null;
    for (let i = 0; i < 5; i++) {
      if (buckets[i].n < 3) continue;
      const avgPred = buckets[i].pred / buckets[i].n;
      const avgActual = buckets[i].actual / buckets[i].n;
      const dev = avgPred - avgActual;
      if (!worst || Math.abs(dev) > Math.abs(worst.dev)) {
        worst = { bucket: i, avgPred, avgActual, dev, n: buckets[i].n };
      }
    }
    let conf = "";
    if (n < 50) conf = " Small sample though - watch for the pattern as you keep going.";
    else if (n < 100) conf = ` Need ~${100 - n} more for a confident read.`;
    if (!worst || Math.abs(worst.dev) < 0.07) {
      el.innerHTML = `<b>${n} scored predictions.</b> You're roughly on the line - no big calibration bias jumps out.${conf}`;
      return;
    }
    const bandLabels = ["0-20%", "20-40%", "40-60%", "60-80%", "80-100%"];
    const overOrUnder = worst.dev > 0 ? "overconfident" : "underconfident";
    const actualPct = Math.round(worst.avgActual * 100);
    const predPct = Math.round(worst.avgPred * 100);
    el.innerHTML = `<b>${n} scored predictions.</b> Biggest pattern: <b>${overOrUnder}</b> in the ${bandLabels[worst.bucket]} band - your calls there averaged ${predPct}% but actually happened ${actualPct}% of the time (n=${worst.n}).${conf}`;
  }

  // ------- where the market knew better -------
  // Surfaces predictions where the user was further from the truth than
  // the market consensus by a meaningful margin (>=30pp). Filters out
  // tail-event coinflips where both the user and the market got blindsided
  // by the same low-probability outcome - those teach nothing. What's
  // left: actual calibration errors where the crowd priced in something
  // the user missed, which is exactly what's worth re-reading.
  //
  // Sorted by `youErr - marketErr` descending, so the entry where the
  // gap was largest goes first. Capped at 5. Section hidden entirely if
  // < 10 scored predictions with market data (small-sample gate) or if
  // nothing clears the 30pp threshold (well-calibrated user vs market).
  const MARKET_GAP_THRESHOLD = 0.3;
  const MARKET_GAP_MIN_N = 10;

  function renderBiggestMisses(hist) {
    const section = $("biggest-misses-section");
    const list = $("biggest-misses");
    const counter = $("biggest-misses-counter");
    if (!section || !list) return;

    const withMkt = hist.filter((r) => {
      const mp = r.mkt30 ?? r.mkt7 ?? r.mkt1;
      return typeof mp === "number" && Number.isFinite(mp);
    });
    if (withMkt.length < MARKET_GAP_MIN_N) {
      section.classList.add("hidden");
      list.innerHTML = "";
      if (counter) counter.textContent = "";
      return;
    }

    const annotated = withMkt.map((r) => {
      const mp = r.mkt30 ?? r.mkt7 ?? r.mkt1;
      const youErr = Math.abs(r.p - r.o);
      const mktErr = Math.abs(mp - r.o);
      return { rec: r, gap: youErr - mktErr };
    }).filter((x) => x.gap >= MARKET_GAP_THRESHOLD);

    if (annotated.length === 0) {
      section.classList.add("hidden");
      list.innerHTML = "";
      if (counter) counter.textContent = "";
      return;
    }

    // Drop entries the user has already marked revisited so the next
    // biggest gap surfaces in its place. If the queue is exhausted (every
    // candidate consumed), hide the section - "good for you, you've read
    // them all" is the right outcome, not an empty header.
    const remaining = annotated.filter((x) => !revisited.has(revisitedKeyFor(x.rec)));
    if (remaining.length === 0) {
      section.classList.add("hidden");
      list.innerHTML = "";
      if (counter) counter.textContent = "";
      return;
    }

    remaining.sort((a, b) => b.gap - a.gap);
    section.classList.remove("hidden");
    const TOP = 5;
    const shownRows = remaining.slice(0, TOP);
    const more = remaining.length - shownRows.length;
    list.innerHTML = shownRows.map((x) => archiveRowHtml(x.rec, { revisitable: true })).join("");
    if (counter) {
      counter.textContent = more > 0
        ? `${shownRows.length} shown · ${more} more queued`
        : "";
    }
  }

  // ------- archive (recent predictions list) -------
  // The user wanted concrete past predictions, not just aggregate stats -
  // dopamine source for "I beat the market on this one". Mirrors the open-tray
  // row pattern. Paginated 30-at-a-time so a user with 500 entries doesn't
  // blow up the DOM on every stats view paint.
  const ARCHIVE_PAGE_SIZE = 30;
  let archiveLimit = ARCHIVE_PAGE_SIZE;

  function archiveSlugFor(rec) {
    // Active-origin entries point at active-deck markets (gone from the
    // resolved deck), so try active slugs first. Falls back to whichever
    // map has it - same id namespace.
    const origin = rec.origin || "resolved";
    if (origin === "active") return slugsActive[rec.id] || slugs[rec.id] || null;
    return slugs[rec.id] || slugsActive[rec.id] || null;
  }

  function archiveRowHtml(rec, opts) {
    const showRevisit = !!(opts && opts.revisitable);
    const o = rec.o;
    const youPct = Math.round(rec.p * 100);
    // "Right" if the side they leaned >50% toward matched the outcome. A
    // 50% pick is neither right nor wrong - we color it neutral.
    let leanCls = "neutral";
    if (rec.p > 0.5) leanCls = (o === 1) ? "right" : "wrong";
    else if (rec.p < 0.5) leanCls = (o === 0) ? "right" : "wrong";

    const yn = rec.yn || "";
    const outcomeTxt = o === 1
      ? (yn ? `YES (${yn})` : "YES")
      : (yn ? `NO (not ${yn})` : "NO");
    const outcomeCls = o === 1 ? "yes" : "no";

    const pts = rec.pts || 0;
    const ptsCls = pts > 0 ? "pos" : (pts < 0 ? "neg" : "zero");

    // Earliest available market price as the "what the market said" anchor.
    // Active-origin entries store p_at_submit in mkt1.
    const mp = rec.mkt30 ?? rec.mkt7 ?? rec.mkt1 ?? null;
    const mpTxt = (mp != null) ? `${Math.round(mp * 100)}%` : null;

    const tag = (rec.c && rec.s) ? `${escapeHtml(rec.c)} · ${escapeHtml(rec.s)}` : (rec.c ? escapeHtml(rec.c) : "");
    const dateTxt = rec.t ? fmtDate(rec.t) : "";
    const originBadge = (rec.origin === "active")
      ? `<span class="archive-origin" title="Predicted on a then-open market that has since resolved">active</span>`
      : "";

    const slug = archiveSlugFor(rec);
    const linkHtml = slug
      ? `<a class="archive-link" href="https://polymarket.com/market/${escapeHtml(slug)}" target="_blank" rel="noopener">view on Polymarket ↗</a>`
      : "";

    const mktLine = (mpTxt != null)
      ? `<span class="archive-mkt">market said ${mpTxt}</span>`
      : "";

    const revisitBtn = showRevisit
      ? `<button type="button" class="archive-revisit" data-revisit-key="${escapeHtml(revisitedKeyFor(rec))}" title="Mark as revisited - hides this row and surfaces the next biggest miss in its place">mark revisited</button>`
      : "";
    const footHtml = (linkHtml || revisitBtn)
      ? `<div class="archive-foot">${linkHtml}${revisitBtn}</div>`
      : "";

    return `
      <article class="archive-row archive-${leanCls}">
        <header class="archive-row-head">
          <span class="archive-tag">${tag}${originBadge}</span>
          <span class="archive-date muted">${escapeHtml(dateTxt)}</span>
        </header>
        <h4 class="archive-q">${escapeHtml(rec.q || "")}</h4>
        <div class="archive-line">
          <span class="archive-you">you said <b>${youPct}%</b></span>
          ${mktLine}
          <span class="archive-outcome ${outcomeCls}">${escapeHtml(outcomeTxt)}</span>
          <span class="archive-pts ${ptsCls}">${fmtPts(pts)} pts</span>
        </div>
        ${footHtml}
      </article>
    `;
  }

  function renderArchive(hist) {
    const list = $("archive-list");
    const empty = $("archive-empty");
    const more = $("btn-archive-more");
    if (!list) return;
    // History view is unscoped: full track record, newest first. The Stats
    // page no longer renders this list, so we no longer derive from
    // statsHistory() here.
    if (!hist) hist = history;

    if (!hist.length) {
      list.innerHTML = "";
      if (empty) empty.classList.remove("hidden");
      if (more) more.classList.add("hidden");
      return;
    }
    if (empty) empty.classList.add("hidden");

    // Newest first. Stable sort - identical timestamps keep insertion order.
    const sorted = hist.slice().sort((a, b) => (b.t || 0) - (a.t || 0));
    const visible = sorted.slice(0, archiveLimit);
    list.innerHTML = visible.map(archiveRowHtml).join("");

    if (more) {
      const remaining = sorted.length - visible.length;
      if (remaining > 0) {
        more.textContent = `Show ${Math.min(ARCHIVE_PAGE_SIZE, remaining)} more (${remaining} remaining)`;
        more.classList.remove("hidden");
      } else {
        more.classList.add("hidden");
      }
    }

    // Slugs may not be loaded for active-origin entries when the user
    // first opens Stats from resolved mode. Kick the active fetch and
    // re-paint when it lands so links light up shortly after.
    if (!activeLoaded && hist.some((r) => r.origin === "active")) {
      loadActiveData().then(() => {
        if (currentView === "history") renderArchive();
      });
    }
  }

  function renderReliability(hist) {
    if (!hist) hist = statsHistory();
    const buckets = Array.from({ length: 10 }, () => ({ preds: [], outcomes: [] }));
    for (const r of hist) {
      const idx = Math.min(9, Math.floor(r.p * 10));
      buckets[idx].preds.push(r.p);
      buckets[idx].outcomes.push(r.o);
    }
    const points = buckets.map((b, i) => {
      if (!b.preds.length) return null;
      const x = b.preds.reduce((s, p) => s + p, 0) / b.preds.length;
      const y = b.outcomes.reduce((s, o) => s + o, 0) / b.outcomes.length;
      return { x, y, n: b.preds.length };
    }).filter(Boolean);

    if (typeof Chart === "undefined") {
      loadChartJs().then((ok) => { if (ok && currentView === "stats") renderReliability(); });
      return;
    }
    const ctx = $("reliability").getContext("2d");
    if (chart) chart.destroy();
    chart = new Chart(ctx, {
      type: "line",
      data: {
        datasets: [
          {
            label: "Perfect",
            data: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
            borderColor: "#bbb", borderDash: [3, 3],
            pointRadius: 0, borderWidth: 1, showLine: true, fill: false,
          },
          {
            label: "You",
            data: points,
            borderColor: "#4A90E2", backgroundColor: "#4A90E2",
            pointRadius: (c) => Math.min(12, 3 + Math.sqrt(c.raw?.n || 0)),
            pointHoverRadius: 14, showLine: true, fill: false, tension: 0.1,
          },
        ],
      },
      options: {
        responsive: true, aspectRatio: 1.0,
        scales: {
          x: { type: "linear", min: 0, max: 1,
               title: { display: true, text: "Predicted probability", color: "#666", font: { size: 11 } },
               grid: { color: "#f0f0f0" },
               ticks: { color: "#666", callback: (v) => (v * 100).toFixed(0) + "%" } },
          y: { min: 0, max: 1,
               title: { display: true, text: "Actual rate YES", color: "#666", font: { size: 11 } },
               grid: { color: "#f0f0f0" },
               ticks: { color: "#666", callback: (v) => (v * 100).toFixed(0) + "%" } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (c) => {
                if (c.dataset.label === "Perfect") return "perfect calibration";
                const { x, y, n } = c.raw;
                const dev = x - y;
                const tag = Math.abs(dev) < 0.05
                  ? "on the line"
                  : (dev > 0 ? "overconfident" : "underconfident");
                return `n=${n}, said ${(x * 100).toFixed(0)}%, actual ${(y * 100).toFixed(0)}% - ${tag}`;
              },
            },
          },
        },
      },
    });
  }

  function renderByCategory(hist) {
    if (!hist) hist = statsHistory();
    const byCat = {};
    for (const r of hist) {
      if (!byCat[r.c]) byCat[r.c] = { n: 0, brier: 0, pts: 0 };
      byCat[r.c].n++;
      byCat[r.c].brier += r.brier;
      byCat[r.c].pts += (r.pts || 0);
    }
    const rows = Object.entries(byCat).sort((a, b) => b[1].pts - a[1].pts);
    const el = $("s-by-cat");
    if (!rows.length) {
      el.innerHTML = '<div class="muted small">Predict a few questions to see your calibration breakdown.</div>';
      return;
    }
    el.innerHTML = rows.map(([cat, d]) => {
      const ppq = d.pts / d.n;
      const cls = ppq > 0 ? "pos" : (ppq < 0 ? "neg" : "");
      return `<div class="row"><span class="name">${cat}</span><span class="pts ${cls}">${fmtPts(d.pts)}</span><span class="brier">${(d.brier / d.n).toFixed(3)} brier</span><span class="n">${d.n}</span></div>`;
    }).join("");
  }

  // ------- reset -------
  function resetAll() {
    if (!confirm("Clear all your predictions? This cannot be undone.")) return;
    history = [];
    saveHistory();
    // Revisited keys point at history records that no longer exist; wipe so
    // the section starts fresh once enough new predictions accumulate.
    revisited = new Set();
    saveRevisited();
    renderSession();
    renderDeckStrip();
    renderStats();
    showView("play");
    nextQuestion();
  }

  // Wipes every predictopoly key in localStorage (history, pending tray, deck
  // prefs, onboarding flag) plus sessionStorage, then hard-reloads. Designed
  // to land the user on the fresh first-visit state - same as opening the
  // site in a clean browser. Useful for QA, demos, and "give me back the
  // welcome card" without DevTools gymnastics.
  function resetEverything() {
    if (!confirm("This wipes ALL your predictions, deck filters, Open tray, and dismisses the welcome guide. You'll see exactly what a brand-new visitor sees. Continue?")) return;
    try {
      localStorage.removeItem(LS_HISTORY);
      localStorage.removeItem(LS_PENDING);
      localStorage.removeItem(LS_PREFS);
      localStorage.removeItem(LS_ONBOARD);
      localStorage.removeItem(LS_SID);
      localStorage.removeItem(LS_REVISITED);
      sessionStorage.clear();
    } catch { /* ignore - private mode etc., reload still helps */ }
    location.reload();
  }

  // ------- init -------
  (async () => {
    // Fire ALL background fetches in parallel from the start. The hot pack
    // wins for fresh visits (mode="hot"); custom-deck users wait for the full
    // markets fetch but it runs concurrently with descriptions and slugs, so
    // by the time first render happens descriptions for non-hot questions
    // are already in flight or done.
    const fullMarketsKick = loadFullMarkets();
    loadDescriptions();
    loadSlugs();

    try {
      await loadFastData();
    } catch (e) {
      $("view-play").innerHTML = '<h2>Could not load data</h2><p class="muted">Expected files at <code>web/data/markets-hot.json</code> and <code>web/data/taxonomy.json</code>.</p>';
      return;
    }

    // Custom-mode users land on filters that the hot-only pack can't satisfy,
    // so block on the full set before the first render. The fetch already
    // started above in parallel with the hot pack.
    if (prefs.mode === "custom" && prefs.subs) {
      const qEl = $("m-question");
      if (qEl) qEl.textContent = "Loading your custom deck...";
      await fullMarketsKick;
    }

    // Sub-sanitization is handled inside applyDataMode now (against the
    // destination taxonomy), so legacy decks get cleaned exactly once - when
    // the user is on that mode and the taxonomy is in scope.
    savePrefs();

    // If the user's last session ended in Active mode, load active data
    // before the first paint so they don't see resolved markets flash by.
    if (prefs.dataMode === "active") {
      const qEl = $("m-question");
      if (qEl) qEl.textContent = "Loading active markets...";
      const ok = await loadActiveData();
      if (ok) {
        applyDataMode("active", { silent: true });
      } else {
        // Fallback to resolved if active data is unreachable.
        prefs.dataMode = "resolved";
        savePrefs();
      }
    }

    renderSession();
    renderDeckStrip();
    renderNavCount();
    renderOnboarding();

    // Phase B.3: when the app boots, sweep any pending entries whose
    // markets have already closed and upgrade the resolved ones into
    // history. Fire-and-forget - the UI already painted, this just
    // refreshes nav count / open tray / stats once results come back.
    if (pending.length) {
      checkPendingResolutions().catch(() => {});
    }

    // One-shot migration: any active-mode history entry with no
    // resolution_v marker was scored with the inverted YES/NO mapping.
    // Re-fetch the resolution and rewrite the record. See git blame on
    // check-resolution.js for the original miss.
    repairFlippedActiveHistory().catch(() => {});

    // slider
    const slider = $("p-slider");
    slider.addEventListener("input", (e) => setBubble(+e.target.value));
    // Shift+Arrow snaps to the extremum (matches OS conventions for "jump
    // to end"). Plain arrows keep stepping by 1% via the native input behavior.
    slider.addEventListener("keydown", (e) => {
      if (!e.shiftKey) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "Home") {
        e.preventDefault();
        slider.value = String(slider.min || 0);
        setBubble(+slider.value);
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "End") {
        e.preventDefault();
        slider.value = String(slider.max || 100);
        setBubble(+slider.value);
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    // predict actions
    $("btn-submit").addEventListener("click", submit);
    $("btn-skip").addEventListener("click", skipQuestion);
    $("btn-next").addEventListener("click", nextQuestion);
    $("btn-next-active").addEventListener("click", nextQuestion);

    // mode toggle (Resolved / Active)
    async function switchMode(mode) {
      if (prefs.dataMode === mode) return;
      if (mode === "active" && !activeLoaded) {
        const qEl = $("m-question");
        if (qEl) {
          qEl.textContent = "Loading active markets...";
          qEl.classList.add("is-loading");
        }
        const ok = await loadActiveData();
        if (!ok) {
          if (qEl) qEl.textContent = "Could not load active markets.";
          return;
        }
      }
      applyDataMode(mode);
      // Drop any open reveal panels - they belong to the other mode
      $("reveal-block").classList.add("hidden");
      $("reveal-block-active").classList.add("hidden");
      $("predict-block").classList.remove("hidden");
      // The mode toggle now lives inside Change deck. If the user flipped
      // there, the modal's presets / category grid / sort labels / pool
      // count are still showing the old universe - re-render them so the
      // whole sheet stays consistent with the active mode.
      const modalEl = $("deck-modal");
      if (modalEl && !modalEl.classList.contains("hidden")) {
        renderPresets();
        renderDeckGrid();
        renderSortRow();
        updateDeckPoolInfo();
      }
      nextQuestion();
    }
    $("btn-mode-resolved").addEventListener("click", () => switchMode("resolved"));
    $("btn-mode-active").addEventListener("click", () => switchMode("active"));
    renderModeToggle();

    // Empty-tray "Go to Active mode" button: jump to Play and ensure we're
    // in active mode so the user can immediately make their first prediction.
    const goActiveBtn = $("btn-open-go-active");
    if (goActiveBtn) {
      goActiveBtn.addEventListener("click", async () => {
        showView("play");
        await switchMode("active");
      });
    }

    // Just-resolved banner: "See results" jumps to History so the user
    // sees the concrete cards that just landed. X dismisses.
    const bannerCta = $("btn-resolved-banner-view");
    if (bannerCta) {
      bannerCta.addEventListener("click", () => {
        hideResolvedBanner();
        // Reset paging so newly-resolved entries are visible without
        // having to "Show more" past prior page state from a previous visit.
        archiveLimit = ARCHIVE_PAGE_SIZE;
        showView("history");
      });
    }
    const bannerDismiss = $("btn-resolved-banner-dismiss");
    if (bannerDismiss) {
      bannerDismiss.addEventListener("click", hideResolvedBanner);
    }

    // Stats scope toggle (All / Resolved / Active)
    ["all", "resolved", "active"].forEach((s) => {
      const btn = $("btn-stats-" + s);
      if (!btn) return;
      btn.addEventListener("click", () => {
        if (statsScope === s) return;
        statsScope = s;
        // Reset archive pagination - showing 5/120 from the previous scope
        // leaks state (and is confusing) when the user switches.
        archiveLimit = ARCHIVE_PAGE_SIZE;
        renderStats();
      });
    });

    // Archive "Show more" - additive paging, doesn't trigger a full
    // renderStats since the chart and aggregates haven't changed.
    const archiveMore = $("btn-archive-more");
    if (archiveMore) {
      archiveMore.addEventListener("click", () => {
        archiveLimit += ARCHIVE_PAGE_SIZE;
        renderArchive();
      });
    }

    // description toggle - on phone we toggle hidden vs fully shown; on
    // desktop we toggle the collapsed-with-fade preview vs fully expanded.
    $("btn-desc-toggle").addEventListener("click", () => {
      const d = $("m-desc");
      let willShow;
      if (window.matchMedia(MOBILE_MQ).matches) {
        const nowHidden = d.classList.toggle("hidden");
        d.classList.remove("collapsed");
        willShow = !nowHidden;
      } else {
        const collapsed = d.classList.toggle("collapsed");
        willShow = !collapsed;
      }
      $("btn-desc-toggle").textContent = willShow ? "hide description ↑" : "show description ↓";
    });

    // nav
    $$(".navlink").forEach((b) => {
      b.addEventListener("click", () => showView(b.dataset.view));
    });
    $("nav-home").addEventListener("click", (e) => {
      e.preventDefault();
      showView("play");
    });

    // session pill - clicking it goes to stats
    $("session-pill").addEventListener("click", () => showView("stats"));
    $("session-pill").style.cursor = "pointer";

    // Browser back/forward and direct hash edits both fire popstate or
    // hashchange. We treat either as a "go to view" event - the URL is the
    // source of truth, not our internal state. fromHistory:true skips the
    // pushState round-trip that would otherwise create a duplicate entry.
    window.addEventListener("popstate", () => {
      const name = parseHash() || "play";
      if (name !== currentView) showView(name, { fromHistory: true });
    });
    window.addEventListener("hashchange", () => {
      const name = parseHash() || "play";
      if (name !== currentView) showView(name, { fromHistory: true });
    });

    // deck modal
    $("btn-open-deck").addEventListener("click", openDeckModal);
    $("btn-deck-close").addEventListener("click", closeDeckModal);
    $("btn-deck-done").addEventListener("click", closeDeckModal);
    $("btn-clear-cats").addEventListener("click", () => {
      bootstrapCustomFromHot();
      prefs.subs = {};
      savePrefs();
      renderPresets();
      renderDeckGrid();
      updateDeckPoolInfo();
    });
    $("deck-modal").addEventListener("click", (e) => {
      if (e.target.id === "deck-modal") closeDeckModal();
    });
    // volume slider in modal
    $("vol-slider").value = prefs.volIdx;
    $("vol-slider").addEventListener("input", (e) => {
      prefs.volIdx = +e.target.value;
      savePrefs();
      updateDeckPoolInfo();
    });

    // sort row in modal - changing order resets session-shown so ordered
    // mode advances from the top of the new sort instead of mid-list.
    renderSortRow();
    document.querySelectorAll(".sort-row [data-sort]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = btn.dataset.sort;
        if (!VALID_SORTS.includes(next) || prefs.sort === next) return;
        prefs.sort = next;
        savePrefs();
        shownIds.clear();
        eventShowCounts.clear();
        renderSortRow();
      });
    });

    // Welcome card: any click anywhere on the overlay or the card itself
    // dismisses (the explainer is read-only - there's nothing inside to
    // interact with). The X stays for users who scan for an explicit close.
    $("btn-onboarding-dismiss").addEventListener("click", (e) => {
      e.stopPropagation();
      dismissOnboarding();
    });
    const welcomeOverlay = $("welcome-overlay");
    if (welcomeOverlay) {
      welcomeOverlay.addEventListener("click", () => dismissOnboarding());
    }
    // Topbar "?" glyph toggles the welcome card. The single canonical entry
    // point now that the footer "show intro" link has been removed - one
    // affordance, less duplication, less footer crowding.
    const helpTop = $("btn-help-topbar");
    if (helpTop) helpTop.addEventListener("click", toggleOnboarding);

    // empty-deck "Change deck" button just opens the deck modal
    $("btn-empty-open-deck").addEventListener("click", openDeckModal);

    // reset
    $("btn-reset").addEventListener("click", resetAll);
    const resetAllBtn = $("btn-reset-all");
    if (resetAllBtn) resetAllBtn.addEventListener("click", resetEverything);

    // "Where the market knew better" - per-row "mark revisited" delegation.
    // Stops the queue from staying frozen at the same five entries forever:
    // mark a row, the next biggest miss takes its slot, counter shows how
    // many candidates are still queued.
    const missesList = $("biggest-misses");
    if (missesList) {
      missesList.addEventListener("click", (e) => {
        const btn = e.target.closest(".archive-revisit");
        if (!btn) return;
        const key = btn.dataset.revisitKey;
        if (!key) return;
        revisited.add(key);
        saveRevisited();
        renderBiggestMisses(statsHistory());
      });
    }

    // Tap-to-toggle tooltips. Hover-capable devices already get them via
    // :hover, but @media (hover: none) hides ::after entirely on touch,
    // leaving (?) and date affordances unreachable. Click handler adds a
    // .show-tip class that overrides the mobile display:none. Tapping
    // outside (or another tip) dismisses.
    document.addEventListener("click", (e) => {
      const tip = e.target.closest(".has-tip");
      document.querySelectorAll(".has-tip.show-tip").forEach((el) => {
        if (el !== tip) el.classList.remove("show-tip");
      });
      if (tip) tip.classList.toggle("show-tip");
    });

    // keyboard: Enter to submit, S to skip. Range input handles arrows natively.
    document.addEventListener("keydown", (e) => {
      // Block shortcuts inside text-typing inputs (but allow them on range/button).
      const t = e.target;
      const isTextInput = (t.tagName === "TEXTAREA") ||
        (t.tagName === "INPUT" && !["range", "checkbox", "radio", "button", "submit"].includes(t.type));
      if (isTextInput) return;
      // Hold-to-autoscroll guard: keydown fires repeatedly while a key is
      // held (e.repeat=true). Without this, holding Enter would submit,
      // immediately trigger nextQuestion on the next repeat, and rip
      // through the deck without the user ever reading anything. We want
      // strictly one keypress -> one action.
      if (e.repeat) return;
      // Welcome overlay catches every keypress - any key dismisses, since
      // the card is read-only and the user shouldn't have to hunt for the
      // right key. Modifier-only keypresses (Shift, Ctrl, Alt, Meta on
      // their own) are ignored so the user can chord without losing the card.
      if (isOnboardingOpen()) {
        const modifierOnly = e.key === "Shift" || e.key === "Control"
          || e.key === "Alt" || e.key === "Meta";
        if (!modifierOnly) {
          e.preventDefault();
          dismissOnboarding();
        }
        return;
      }
      if ($("deck-modal") && !$("deck-modal").classList.contains("hidden")) {
        if (e.key === "Escape") closeDeckModal();
        // Enter dismisses the modal as if Done was clicked - but only when
        // focus is on the modal backdrop / body, not on an interactive
        // control. Otherwise the native Enter-on-button behavior (toggle a
        // preset, flip mode, pick a category) would race with closing.
        else if (e.key === "Enter") {
          const tag = e.target && e.target.tagName;
          if (tag !== "BUTTON" && tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") {
            e.preventDefault();
            closeDeckModal();
          }
        }
        return;
      }
      if (currentView !== "play") return;
      const revealOpen = !$("reveal-block").classList.contains("hidden")
        || !$("reveal-block-active").classList.contains("hidden");
      if (e.key === "Enter" && !revealOpen) { e.preventDefault(); submit(); }
      else if (e.key === "Enter" && revealOpen) { e.preventDefault(); nextQuestion(); }
      else if (e.key.toLowerCase() === "s" && !revealOpen) { skipQuestion(); }
    });

    // Honor a deep-link hash on cold load. Default (#play or no hash) is a
    // no-op since play is the visible view by default. Anything else - the
    // user pasted /#stats, came back to a tab parked on /#open, etc. -
    // routes there now that data and listeners are ready. fromHistory:true
    // skips the pushState since the URL already reflects this state.
    const initialView = parseHash();
    if (initialView && initialView !== "play") {
      showView(initialView, { fromHistory: true });
    }

    // first question - background fetches were kicked at the very top of init
    nextQuestion();
  })();
})();
