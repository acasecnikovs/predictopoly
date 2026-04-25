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

  const VOL_STEPS  = [0, 100, 1000, 10000, 100000, 1000000];

  // Deck presets - map preset id to a function that returns a {cat: [sub,...]}
  // shape using the live taxonomy. Order matters - first one is the "default" for fresh users.
  const PRESETS = [
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
      id: "all",
      label: "All",
      hint: "every category",
      build: (tax) => pickCats(tax, Object.keys(tax)),
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
  let markets   = [];
  let taxonomy  = {};
  let descs     = {};       // id -> description text. Lazy-loaded after first paint.
  let descsReady = false;
  let slugs     = {};       // id -> polymarket slug. Lazy-loaded after first paint.
  let history   = loadHistory();
  let prefs     = loadPrefs();
  let current   = null;     // currently displayed market
  let chart     = null;     // chart.js instance
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

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(LS_PREFS) || "{}");
      const vi = p.volIdx ?? 4;
      return {
        mode: p.mode || "hot",       // "hot" = curated allowlist, "custom" = subs-based
        subs: p.subs || null,
        volIdx: Math.max(0, Math.min(VOL_STEPS.length - 1, vi)),
      };
    } catch { return { mode: "hot", subs: null, volIdx: 4 }; }
  }
  function savePrefs() { localStorage.setItem(LS_PREFS, JSON.stringify(prefs)); }

  // ------- data -------
  // Cache-bust by app version so taxonomy revisions actually reach the browser.
  const DATA_V = "14";

  // First paint only needs the 87-question hot pack (~7 KB brotli). The full
  // markets.json (1.3 MB brotli) loads in the background and swaps in when
  // the user actually needs more (deck modal, stats view, hot deck exhausted).
  let marketsAreFastPack = true;
  let fullMarketsPromise = null;

  async function loadFastData() {
    const [mRes, tRes] = await Promise.all([
      fetch(`data/markets-hot.json?v=${DATA_V}`),
      fetch(`data/taxonomy.json?v=${DATA_V}`),
    ]);
    if (!mRes.ok || !tRes.ok) throw new Error("data fetch failed");
    markets = await mRes.json();
    taxonomy = await tRes.json();
  }

  function loadFullMarkets() {
    if (fullMarketsPromise) return fullMarketsPromise;
    fullMarketsPromise = (async () => {
      try {
        const res = await fetch(`data/markets.json?v=${DATA_V}`);
        if (!res.ok) return false;
        const full = await res.json();
        // Preserve any session-only state by replacing wholesale; ids are stable.
        markets = full;
        marketsAreFastPack = false;
        return true;
      } catch {
        return false;
      }
    })();
    return fullMarketsPromise;
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
      slugs = await res.json();
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
    ["play", "stats"].forEach((v) => {
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
  function marketPasses(m) {
    // Source of truth for "is this market in the active deck right now?"
    // Edition picks bypass the volume filter - they're hand-curated, the
    // filter is meant for taming the long tail of low-volume custom decks.
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
    // Weight by p7 uncertainty: questions where the market itself was uncertain
    // (p7 near 0.5) are more calibration-rich than near-certain ones.
    // Items without p7 get the median weight so they aren't excluded.
    let total = 0;
    const weights = pool.map((m) => {
      const w = (m.p7 != null) ? Math.max(0.1, 1 - 2 * Math.abs(m.p7 - 0.5)) : 0.5;
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
    if (prefs.mode === "hot") {
      $("deck-label").textContent = `edition picks · ${fmtNum(total)} questions`;
      return;
    }
    const allCats = Object.keys(taxonomy);
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
    if (history.length > 0) return;
    $("onboarding").classList.remove("hidden");
  }
  function dismissOnboarding() {
    localStorage.setItem(LS_ONBOARD, "1");
    $("onboarding").classList.add("hidden");
  }

  // ------- play view rendering -------
  function showQuestion(m) {
    current = m;
    $("m-cat").textContent  = m.c || "";
    $("m-sub").textContent  = m.s || "";
    $("m-date").textContent = "resolved " + fmtDate(m.t);
    $("m-vol").textContent  = fmtVol(m.v);
    const qEl = $("m-question");
    qEl.textContent = m.q || "";
    qEl.classList.remove("is-loading");
    $("m-yn").textContent = m.yn ? `(YES = ${m.yn})` : "";

    // description (may be empty if descriptions.json hasn't loaded yet)
    renderDescription(descs[m.id] || "");

    // reset slider
    const slider = $("p-slider");
    slider.value = "50";
    setBubble(50);

    // show predict, hide reveal
    $("predict-block").classList.remove("hidden");
    $("reveal-block").classList.add("hidden");

    // focus the slider so arrow keys work immediately and Enter submits
    requestAnimationFrame(() => slider.focus({ preventScroll: true }));
  }

  function renderDescription(text) {
    const descEl = $("m-desc");
    const toggleBtn = $("btn-desc-toggle");
    const t = (text || "").trim();
    descEl.classList.add("collapsed");
    if (t.length > 0) {
      descEl.textContent = t;
      descEl.classList.remove("hidden");
      requestAnimationFrame(() => {
        if (descEl.scrollHeight > descEl.clientHeight + 2) {
          toggleBtn.classList.remove("hidden");
          toggleBtn.textContent = "show description ↓";
        } else {
          toggleBtn.classList.add("hidden");
          descEl.classList.remove("collapsed");
        }
      });
    } else {
      descEl.classList.add("hidden");
      toggleBtn.classList.add("hidden");
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
      t: Date.now(),
    };
    history.push(rec);
    saveHistory();
    renderReveal(rec, current, score, mp);
    renderSession();
    fetchPercentile(current.id, score.yourBrier);
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

    // hide percentile until backend responds (or fails)
    $("r-percentile").classList.add("hidden");

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
      if (data && typeof data.percentile === "number" && data.n >= 3) {
        $("r-percentile-val").textContent = `${Math.round(data.percentile)}%`;
        $("r-percentile").classList.remove("hidden");
      }
    } catch { /* offline / no backend - hide silently */ }
  }

  // ------- next / skip -------
  async function nextQuestion() {
    let q = pickQuestion();
    // Custom decks won't be satisfied by the hot-only fast pack. Block briefly
    // for the full set if it's still in flight, then retry.
    if (!q && marketsAreFastPack) {
      await loadFullMarkets();
      q = pickQuestion();
    }
    if (!q) {
      alert("Out of questions matching your filters. Open the deck modal and broaden them.");
      openDeckModal();
      return;
    }
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
    // if current question no longer matches the (possibly changed) filter, swap it
    if (current && !marketPasses(current)) {
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
    const cats = Object.keys(taxonomy);
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
  function renderStats() {
    const n = history.length;
    $("s-count").textContent = n;
    if (n === 0) {
      $("s-points").textContent = "0";
      $("s-ppq").textContent = "-";
      $("s-brier").textContent = "-";
      $("s-log").textContent = "-";
      $("s-vs-mkt").textContent = "-";
      $("s-by-cat").innerHTML = '<div class="muted small">Predict a few questions to see your calibration breakdown.</div>';
      if (chart) { chart.destroy(); chart = null; }
      return;
    }
    const totalPts = history.reduce((s, r) => s + (r.pts || 0), 0);
    const ppq = totalPts / n;
    const meanBrier = history.reduce((s, r) => s + r.brier, 0) / n;
    const meanLog = history.reduce((s, r) => s + r.log, 0) / n;

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

    const withMkt = history.filter((r) => r.mkt30 != null || r.mkt7 != null || r.mkt1 != null);
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

    renderReliability();
    renderByCategory();
  }

  function renderReliability() {
    const buckets = Array.from({ length: 10 }, () => ({ preds: [], outcomes: [] }));
    for (const r of history) {
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

  function renderByCategory() {
    const byCat = {};
    for (const r of history) {
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

  // ------- init -------
  (async () => {
    try {
      await loadFastData();
    } catch (e) {
      $("view-play").innerHTML = '<h2>Could not load data</h2><p class="muted">Expected files at <code>web/data/markets-hot.json</code> and <code>web/data/taxonomy.json</code>.</p>';
      return;
    }

    // Custom-mode users land on filters that the hot-only pack can't satisfy,
    // so block on the full set before the first render.
    if (prefs.mode === "custom" && prefs.subs) {
      await loadFullMarkets();
    }

    // Fresh users land in "hot" mode = curated allowlist of ~130 hand-picked
    // questions, the strongest possible first impression. Power users can
    // switch to a custom deck via the deck modal at any time.
    if (prefs.mode === "custom" && prefs.subs) {
      // sanitize stored subs: drop unknown cats / subs from older taxonomies
      const cleaned = {};
      for (const cat of Object.keys(taxonomy)) {
        const valid = new Set((taxonomy[cat] || []).map((x) => x.sub));
        const prev = prefs.subs[cat];
        if (prev) cleaned[cat] = prev.filter((s) => valid.has(s));
      }
      prefs.subs = cleaned;
    }
    savePrefs();

    renderSession();
    renderDeckStrip();
    renderOnboarding();

    // slider
    const slider = $("p-slider");
    slider.addEventListener("input", (e) => setBubble(+e.target.value));

    // predict actions
    $("btn-submit").addEventListener("click", submit);
    $("btn-skip").addEventListener("click", skipQuestion);
    $("btn-next").addEventListener("click", nextQuestion);

    // description toggle
    $("btn-desc-toggle").addEventListener("click", () => {
      const d = $("m-desc");
      const collapsed = d.classList.toggle("collapsed");
      $("btn-desc-toggle").textContent = collapsed ? "show description ↓" : "hide description ↑";
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

    // onboarding dismiss
    $("btn-onboarding-dismiss").addEventListener("click", dismissOnboarding);

    // reset
    $("btn-reset").addEventListener("click", resetAll);

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
      const revealOpen = !$("reveal-block").classList.contains("hidden");
      if (e.key === "Enter" && !revealOpen) { e.preventDefault(); submit(); }
      else if (e.key === "Enter" && revealOpen) { e.preventDefault(); nextQuestion(); }
      else if (e.key.toLowerCase() === "s" && !revealOpen) { skipQuestion(); }
    });

    // first question
    nextQuestion();

    // Fire the description fetch after first paint so the page is interactive
    // immediately. requestIdleCallback when available, otherwise a short timeout.
    const kick = () => { loadFullMarkets(); loadDescriptions(); loadSlugs(); };
    if ("requestIdleCallback" in window) requestIdleCallback(kick, { timeout: 1500 });
    else setTimeout(kick, 200);
  })();
})();
