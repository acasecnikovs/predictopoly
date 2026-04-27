// predictopoly - calibration training on resolved Polymarket questions
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
    {
      id: "clear",
      label: "Clear",
      hint: "deselect everything",
      build: () => ({}),
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
  let prefs     = loadPrefs();
  let current   = null;     // currently displayed market
  let chart     = null;     // chart.js instance
  // Stats scope: which slice of history the Stats view shows. Session-only
  // (resets on reload) - stats are a glanceable snapshot, no need to persist.
  let statsScope = "all";   // "all" | "resolved" | "active"
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
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(LS_PREFS) || "{}");
      const vi = p.volIdx ?? 4;
      const dm = p.dataMode === "active" ? "active" : "resolved";
      const decks = (p._decks && typeof p._decks === "object") ? p._decks : {};
      return {
        mode: p.mode || "hot",       // "hot" = curated allowlist, "custom" = subs-based
        subs: p.subs || null,
        volIdx: Math.max(0, Math.min(VOL_STEPS.length - 1, vi)),
        dataMode: dm,                // "resolved" | "active"
        _decks: decks,               // { resolved?: {mode, subs}, active?: {mode, subs} }
      };
    } catch { return { mode: "hot", subs: null, volIdx: 4, dataMode: "resolved", _decks: {} }; }
  }
  function savePrefs() { localStorage.setItem(LS_PREFS, JSON.stringify(prefs)); }

  // ------- data -------
  // Cache-bust by app version so taxonomy revisions actually reach the browser.
  const DATA_V = "18";

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
        if (!res.ok) return false;
        const full = await res.json();
        // Preserve any session-only state by replacing wholesale; ids are stable.
        marketsResolved = full;
        marketsAreFastPack = false;
        if (prefs.dataMode === "resolved") markets = marketsResolved;
        return true;
      } catch {
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
    prefs.dataMode = mode;
    savePrefs();
    if (!silent) {
      renderModeToggle();
      renderDeckStrip();
    }
  }

  function renderModeToggle() {
    const dm = prefs.dataMode;
    const r = $("btn-mode-resolved");
    const a = $("btn-mode-active");
    if (!r || !a) return;
    r.classList.toggle("current", dm === "resolved");
    a.classList.toggle("current", dm === "active");
    r.setAttribute("aria-selected", dm === "resolved");
    a.setAttribute("aria-selected", dm === "active");
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
  function pointsFor(p, o, mktP) {
    const yourBrier = brierOf(p, o);
    const calibration = Math.round(100 - 400 * yourBrier);
    let marketBeat = 0;
    let mktBrier = null;
    if (mktP != null) {
      mktBrier = brierOf(mktP, o);
      const delta = mktBrier - yourBrier;  // positive = you beat market
      marketBeat = Math.max(-50, Math.min(50, Math.round(1000 * delta)));
    }
    return {
      yourBrier, mktBrier,
      calibration, marketBeat,
      total: calibration + marketBeat,
    };
  }

  // ------- view switching -------
  function showView(name) {
    ["play", "open", "stats"].forEach((v) => {
      const el = $("view-" + v);
      if (el) el.classList.toggle("hidden", v !== name);
    });
    $$(".navlink").forEach((b) => b.classList.toggle("current", b.dataset.view === name));
    currentView = name;
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
    let total = 0;
    const weights = pool.map((m) => {
      // In active mode the comparable signal is the current price (p_now).
      // In resolved mode it's the 7-day-pre-close price (p7). Same idea:
      // weight uncertain markets higher, since 50/50 markets are more
      // calibration-rich than 95/5 ones.
      const ref = (prefs.dataMode === "active") ? m.p_now : m.p7;
      const w = (ref != null) ? Math.max(0.1, 1 - 2 * Math.abs(ref - 0.5)) : 0.5;
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

  // ------- top bar / session -------
  function todayPoints() {
    const today = new Date().toDateString();
    return history
      .filter((r) => new Date(r.t).toDateString() === today)
      .reduce((s, r) => s + (r.pts || 0), 0);
  }
  function renderSession() {
    const v = todayPoints();
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
  function renderOnboarding() {
    if (localStorage.getItem(LS_ONBOARD) === "1") return;
    // Don't show the welcome card to returning users (we treat any prior
    // resolved history OR pending active prediction as "they've used this").
    if (history.length > 0 || pending.length > 0) return;
    const card = $("welcome-card");
    if (card) card.classList.remove("hidden");
  }
  function dismissOnboarding() {
    localStorage.setItem(LS_ONBOARD, "1");
    const card = $("welcome-card");
    if (card) card.classList.add("hidden");
  }
  // Footer "show intro" button - re-opens the welcome card on demand. Doesn't
  // unset LS_ONBOARD so dismissing again is silent (no re-tutorial loop).
  function showOnboardingNow() {
    const card = $("welcome-card");
    if (!card) return;
    card.classList.remove("hidden");
    card.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ------- play view rendering -------
  function showQuestion(m) {
    current = m;
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
    fetchPercentile(current.id, score.yourBrier);
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
      status: "pending",
      t: Date.now(),
    };
    pending.push(rec);
    savePending();
    renderNavCount();
    renderRevealActive(rec, m);
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

  // ------- percentile (backend) -------
  async function fetchPercentile(qid, brier) {
    try {
      const res = await fetch("/api/percentile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qid, brier }),
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
      const expBtn = onlySub ? "" : `<button class="deck-exp" title="${expanded ? "collapse" : "subcategories"}">${expanded ? "▾" : "▸"}</button>`;

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

      // toggle whole category by clicking head text
      card.querySelector(".deck-head-text").addEventListener("click", () => {
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
        bits.push("No active predictions yet - switch to Active mode and make one.");
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
        ? 'Active scores show up here when your <b>Open</b> predictions resolve on Polymarket.'
        : 'Predict a few questions to see your calibration breakdown.';
      $("s-by-cat").innerHTML = `<div class="muted small">${emptyMsg}</div>`;
      if (chart) { chart.destroy(); chart = null; }
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

    renderReliability(hist);
    renderByCategory(hist);
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
                if (c.dataset.label === "Perfect") return "";
                const { x, y, n } = c.raw;
                return `n=${n}, said ${(x * 100).toFixed(0)}%, actual ${(y * 100).toFixed(0)}%`;
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

    // slider
    const slider = $("p-slider");
    slider.addEventListener("input", (e) => setBubble(+e.target.value));

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

    // Stats scope toggle (All / Resolved / Active)
    ["all", "resolved", "active"].forEach((s) => {
      const btn = $("btn-stats-" + s);
      if (!btn) return;
      btn.addEventListener("click", () => {
        if (statsScope === s) return;
        statsScope = s;
        renderStats();
      });
    });

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

    // deck modal
    $("btn-open-deck").addEventListener("click", openDeckModal);
    $("btn-deck-close").addEventListener("click", closeDeckModal);
    $("btn-deck-done").addEventListener("click", closeDeckModal);
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

    // welcome card dismiss (X and "Got it" both close it)
    $("btn-onboarding-dismiss").addEventListener("click", dismissOnboarding);
    $("btn-welcome-go").addEventListener("click", dismissOnboarding);
    // footer "show intro" - re-opens the card whenever the user wants a refresher
    const introBtn = $("btn-show-intro");
    if (introBtn) introBtn.addEventListener("click", showOnboardingNow);

    // empty-deck "Change deck" button just opens the deck modal
    $("btn-empty-open-deck").addEventListener("click", openDeckModal);

    // reset
    $("btn-reset").addEventListener("click", resetAll);
    const resetAllBtn = $("btn-reset-all");
    if (resetAllBtn) resetAllBtn.addEventListener("click", resetEverything);

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
      if ($("deck-modal") && !$("deck-modal").classList.contains("hidden")) {
        if (e.key === "Escape") closeDeckModal();
        return;
      }
      if (currentView !== "play") return;
      const revealOpen = !$("reveal-block").classList.contains("hidden")
        || !$("reveal-block-active").classList.contains("hidden");
      if (e.key === "Enter" && !revealOpen) { e.preventDefault(); submit(); }
      else if (e.key === "Enter" && revealOpen) { e.preventDefault(); nextQuestion(); }
      else if (e.key.toLowerCase() === "s" && !revealOpen) { skipQuestion(); }
    });

    // first question - background fetches were kicked at the very top of init
    nextQuestion();
  })();
})();
