/**
 * options/options.js
 *
 * Settings page controller. Handles three main views:
 *   1. Profiles — create, rename, delete, set active
 *   2. Answers  — view/edit/delete saved answers, grouped by site or flat table
 *   3. AI Settings — manage LLM connections (create, edit, delete, test, set active)
 *   4. Data — export/import/reset all extension data
 *
 * Also renders a plan banner at the top showing account status and plan limits.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /* ── Page state (mirrors what's in chrome.storage) ── */

  const state = {
    profiles: [],
    activeProfileId: null,
    connections: [],
    activeConnectionId: null,
    editingConnectionId: null,  // Which connection is loaded into the AI form
    answersProfileId: null,     // Which profile's answers are being viewed
    answers: [],
    search: "",                 // Current search filter for answers
    answersView: "all",         // "all" (flat table) or "sites" (grouped cards)
    expandedSites: new Set(),   // Which site cards are expanded in sites view
    account: null,              // Current account data from background
    autoSaveDetection: false    // Whether LLM auto-detect forms is enabled
  };

  const PROVIDERS = (typeof FFProviders !== "undefined" && FFProviders.PRESETS) || {};

  /* ── Provider preset helpers ── */

  function providerPreset(provider) {
    return PROVIDERS[provider] || {};
  }

  /**
   * Update placeholder/title text on the API key field based on the
   * selected provider (e.g. "optional" for Ollama, "sk-..." for OpenAI).
   */
  function syncProviderUI() {
    const f = $("aiForm");
    const provider = f.provider.value;
    const preset = providerPreset(provider);
    f.apiKey.placeholder = preset.apiKeyHint || "sk-…";
    f.apiKey.title = "";
    if (preset.apiKeyOptional) {
      f.apiKey.placeholder = "optional";
      f.apiKey.title = "Not required for this provider";
    }
    if (preset.model) f.model.placeholder = preset.model;
  }

  /**
   * Auto-fill all form fields with the selected provider's defaults
   * (baseUrl, model, temperature, maxTokens). Clears the API key.
   */
  function applyProviderPreset(provider) {
    const f = $("aiForm");
    const preset = providerPreset(provider);
    f.baseUrl.value = preset.baseUrl || "";
    f.model.value = preset.model || "";
    f.apiKey.value = "";
    if (typeof preset.temperature === "number") f.temperature.value = preset.temperature;
    if (typeof preset.maxTokens === "number") f.maxTokens.value = preset.maxTokens;
    syncProviderUI();
  }

  /* ── Messaging ── */

  function sendMsg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(res || { ok: false, error: "No response" });
      });
    });
  }

  /* ── State loading ── */

  /** Load all state from background (profiles, connections, active IDs) */
  async function loadState() {
    const res = await sendMsg({ type: "getState" });
    if (res.ok) {
      state.profiles = res.data.profiles;
      state.activeProfileId = res.data.activeProfileId;
      state.connections = res.data.connections;
      state.activeConnectionId = res.data.activeConnectionId;
      state.autoSaveDetection = res.data.autoSaveDetection === true;
      // if (!state.editingConnectionId) {
        state.editingConnectionId = state.activeConnectionId || (state.connections[0] && state.connections[0].id);
      // }
      if (state.editingConnectionId && !state.connections.some((c) => c.id === state.editingConnectionId)) {
        state.editingConnectionId = state.activeConnectionId || state.connections[0]?.id || null;
      }
      if (!state.answersProfileId) {
        state.answersProfileId = state.activeProfileId || (state.profiles[0] && state.profiles[0].id);
      }
      if (state.answersProfileId && !state.profiles.some((p) => p.id === state.answersProfileId)) {
        state.answersProfileId = state.profiles[0]?.id || null;
      }
    }
  }

  /** Load account/plan data from background */
  async function loadAccount() {
    const res = await sendMsg({ type: "getAccount" });
    state.account = res.ok ? res.data : null;
  }

  /* ── Plan banner ── */

  /**
   * Render the plan info banner at the top of the settings page.
   * Shows plan label, limits text, and a "Manage account" or "Sign in" button.
   */
  function renderPlanBanner() {
    const banner = $("planBanner");
    if (!banner) return;
    banner.innerHTML = "";
    const data = state.account;
    if (!data || !data.plan) return;
    const account = data.account || {};
    const plan = data.plan;
    const paid = plan.key === "paid";

    const text = document.createElement("span");
    if (paid) {
      const until = new Date(account.planExpiresAt).toLocaleDateString();
      text.textContent = `Pro plan — unlimited profiles and answers until ${until}.`;
    } else if (account.signedIn) {
      text.textContent = `${account.name || account.email} · Free plan: unlimited profiles and answers.`;
    } else {
      text.textContent = "Local mode · Unlimited profiles and answers.";
    }

    const badge = document.createElement("span");
    badge.className = "plan-badge" + (paid ? " paid" : "");
    badge.textContent = plan.label;

    const btn = document.createElement("button");
    btn.className = "btn btn-ghost";
    btn.textContent = account.signedIn ? "Manage account" : "Sign in";
    btn.addEventListener("click", () => {
      chrome.windows.create({
        url: chrome.runtime.getURL("account/account.html"),
        type: "popup",
        width: 460,
        height: 660,
        focused: true
      });
    });

    banner.append(text, badge, btn);
  }

  /* ── Answers loading ── */

  /** Load answers for the currently selected profile into state.answers */
  async function loadAnswers() {
    if (!state.answersProfileId) {
      state.answers = [];
      return;
    }
    const res = await sendMsg({ type: "getProfile", profileId: state.answersProfileId });
    if (res.ok) {
      state.answers = Object.entries(res.data.answers || {}).map(([key, a]) => ({ key, ...a }));
    }
  }

  /** Format a timestamp as a human-readable relative time ("3m ago", "2d ago", etc.) */
  function fmtTime(ts) {
    if (!ts) return "—";
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function setStatus(el, text, kind) {
    el.textContent = text || "";
    el.className = "status" + (kind ? " " + kind : "");
  }

  /* ── Navigation (tab switching between views) ── */

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
      $("view-" + btn.dataset.view).classList.remove("hidden");
    });
  });

  /* ── Profiles view ── */

  /** Render the list of profiles with Set active / Rename / Delete actions */
  function renderProfiles() {
    const list = $("profileList");
    list.innerHTML = "";
    $("profilesEmpty").classList.toggle("hidden", state.profiles.length > 0);
    for (const p of state.profiles) {
      const li = document.createElement("li");
      li.classList.toggle("active", p.id === state.activeProfileId);

      const name = document.createElement("span");
      name.className = "profile-name";
      name.textContent = p.name;

      const count = document.createElement("span");
      count.className = "badge-muted";
      count.textContent = `${p.answerCount} answers`;

      const activeBadge = document.createElement("span");
      activeBadge.className = "badge";
      activeBadge.textContent = "Active";

      const actions = document.createElement("div");
      actions.className = "row-actions";

      if (p.id !== state.activeProfileId) {
        const setBtn = document.createElement("button");
        setBtn.className = "btn btn-small";
        setBtn.textContent = "Set active";
        setBtn.addEventListener("click", async () => {
          await sendMsg({ type: "setActiveProfile", profileId: p.id });
          await refresh();
        });
        actions.appendChild(setBtn);
      } else {
        actions.appendChild(activeBadge);
      }

      const renameBtn = document.createElement("button");
      renameBtn.className = "btn btn-small";
      renameBtn.textContent = "Rename";
      renameBtn.addEventListener("click", async () => {
        const name2 = prompt("Profile name:", p.name);
        if (!name2) return;
        await sendMsg({ type: "renameProfile", profileId: p.id, name: name2 });
        await refresh();
      });
      actions.appendChild(renameBtn);

      const delBtn = document.createElement("button");
      delBtn.className = "btn btn-small btn-danger";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete profile "${p.name}" and all its answers?`)) return;
        await sendMsg({ type: "deleteProfile", profileId: p.id });
        if (state.answersProfileId === p.id) state.answersProfileId = null;
        await refresh();
      });
      actions.appendChild(delBtn);

      li.append(name, count, actions);
      list.appendChild(li);
    }
  }

  $("addProfileBtn").addEventListener("click", async () => {
    const name = prompt("New profile name:", "New Profile");
    if (!name) return;
    const res = await sendMsg({ type: "createProfile", name });
    if (res.ok) await refresh();
    else alert(res.error);
  });

  // Auto-detect forms toggle
  $("autoDetectToggle").addEventListener("change", async (e) => {
    const res = await sendMsg({ type: "setAutoSaveDetection", enabled: e.target.checked });
    if (!res.ok) {
      alert(res.error);
      e.target.checked = !e.target.checked;
    } else {
      state.autoSaveDetection = e.target.checked;
    }
  });

  function renderAutoDetectToggle() {
    $("autoDetectToggle").checked = state.autoSaveDetection;
  }

  /* ── Answers view ── */

  /** Populate the profile selector in the answers view */
  function renderAnswersSelect() {
    const sel = $("answersProfileSelect");
    sel.innerHTML = "";
    for (const p of state.profiles) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
    sel.value = state.answersProfileId || "";
    sel.disabled = state.profiles.length === 0;
  }

  /** Get the display label for an answer (question text or normalised key) */
  function questionLabel(a) {
    return a.question || a.key || "—";
  }

  /**
   * Build a single answer card element.
   * @param {Object} a - answer object
   * @param {Object} [opts] - { compact: bool } for inside site cards
   */
  function buildAnswerCard(a, opts) {
    const card = document.createElement("div");
    card.className = "answer-card";

    const meta = document.createElement("div");
    meta.className = "answer-card-meta";

    const date = document.createElement("span");
    date.className = "answer-card-date";
    date.textContent = fmtTime(a.updatedAt);
    meta.appendChild(date);

    const tag = document.createElement("span");
    tag.className = "source-tag" + (a.source === "llm" ? " llm" : "");
    tag.textContent = a.source || "learned";
    meta.appendChild(tag);

    if (!opts?.compact) {
      const sites = (a.sites || []).join(", ");
      if (sites) {
        const sitesTag = document.createElement("span");
        sitesTag.className = "answer-card-sites";
        sitesTag.textContent = sites;
        sitesTag.title = sites;
        meta.appendChild(sitesTag);
      }
    }

    const q = document.createElement("div");
    q.className = "answer-card-question";
    q.textContent = questionLabel(a);

    const v = document.createElement("div");
    v.className = "answer-card-value";
    v.textContent = a.value;

    const vWrap = document.createElement("div");
    vWrap.className = "answer-card-value-wrap";
    vWrap.appendChild(v);

    const toggle = document.createElement("button");
    toggle.className = "answer-card-toggle";
    toggle.textContent = "Show more";
    toggle.addEventListener("click", () => {
      const expanded = vWrap.classList.toggle("expanded");
      toggle.textContent = expanded ? "Show less" : "Show more";
    });

    const actions = document.createElement("div");
    actions.className = "answer-card-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "btn btn-small";
    editBtn.textContent = "Edit";

    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-small btn-danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete answer for "${questionLabel(a)}"?`)) return;
      await sendMsg({ type: "deleteAnswer", profileId: state.answersProfileId, key: a.key });
      await refresh();
    });

    // Inline edit: replaces question/value with input fields
    editBtn.addEventListener("click", () => {
      q.textContent = "";
      vWrap.textContent = "";
      toggle.classList.remove("visible");

      const keyInput = document.createElement("input");
      keyInput.className = "inline-input";
      keyInput.value = a.question || a.key;

      const valInput = document.createElement("input");
      valInput.className = "inline-input";
      valInput.value = a.value;

      const editRow = document.createElement("div");
      editRow.className = "answer-card-edit";
      editRow.append(keyInput, valInput);

      const saveBtn = document.createElement("button");
      saveBtn.className = "btn btn-small btn-primary";
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", async () => {
        const newQuestion = keyInput.value.trim();
        const newVal = valInput.value.trim();
        if (!newQuestion || !newVal) return;
        const res = await sendMsg({
          type: "saveAnswers",
          profileId: state.answersProfileId,
          pairs: [{ key: newQuestion, value: newVal, source: "manual", question: newQuestion }]
        });
        if (!res.ok) {
          alert(res.error);
          return;
        }
        if (newQuestion !== a.key && newQuestion !== (a.question || a.key)) {
          await sendMsg({ type: "deleteAnswer", profileId: state.answersProfileId, key: a.key });
        }
        await refresh();
      });

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "btn btn-small";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", renderAnswers);

      actions.textContent = "";
      actions.append(saveBtn, cancelBtn);
      vWrap.append(editRow);
    });

    actions.append(editBtn, delBtn);
    card.append(meta, q, vWrap, toggle, actions);

    // Auto-collapse long answers after card is in the DOM
    requestAnimationFrame(() => {
      const lineHeight = parseFloat(getComputedStyle(v).lineHeight) || 18;
      if (v.scrollHeight > lineHeight * 5 + 2) {
        vWrap.classList.add("collapsible");
        toggle.classList.add("visible");
      }
    });

    return card;
  }

  /**
   * Render the answers section: toggles between the flat card view
   * and the grouped-by-site card view.
   */
  function renderAnswers() {
    document.querySelectorAll("[data-answers-view]").forEach((b) => {
      b.classList.toggle("active", b.dataset.answersView === state.answersView);
    });
    if (state.answersView === "sites") {
      $("answersList").classList.add("hidden");
      $("siteCards").classList.remove("hidden");
      $("answersEmpty").classList.add("hidden");
      renderSiteCards();
      return;
    }
    $("answersList").classList.remove("hidden");
    $("siteCards").classList.add("hidden");
    renderAnswersList();
  }

  /** Render the flat list of all answer cards (with search filter applied) */
  function renderAnswersList() {
    const list = $("answersList");
    list.innerHTML = "";

    const q = state.search.toLowerCase();
    const filtered = state.answers.filter(
      (a) =>
        !q ||
        questionLabel(a).toLowerCase().includes(q) ||
        String(a.value).toLowerCase().includes(q)
    );

    $("answersEmpty").classList.toggle(
      "hidden",
      state.profiles.length > 0 && filtered.length > 0
    );
    $("answersEmpty").textContent =
      state.profiles.length === 0
        ? "Create a profile first to save answers."
        : "No answers saved in this profile yet.";

    for (const a of filtered) {
      list.appendChild(buildAnswerCard(a));
    }
  }

  /** Group answers by their firstSeenOn site hostname */
  function groupBySite(answers) {
    const groups = {};
    for (const a of answers) {
      const site = a.firstSeenOn || "unknown";
      (groups[site] = groups[site] || []).push(a);
    }
    return groups;
  }

  function siteLabel(site) {
    return site === "unknown" ? "Unknown site" : site;
  }

  /**
   * Display label for a group of answers: prefers the application's own
   * name (captured from the page when the answer was saved) and only
   * falls back to the raw site/URL when no name is available.
   */
  function groupDisplayName(site, answers) {
    const named = answers.find((a) => a.appName);
    return named ? named.appName : siteLabel(site);
  }

  /**
   * Build a collapsible site card for the grouped view.
   * Header shows site name + answer count; clicking expands to show the
   * answer table. Each card has a "Delete collection" button.
   */
  function buildSiteCard(site, answers) {
    const card = document.createElement("div");
    card.className = "site-card";

    const header = document.createElement("div");
    header.className = "site-card-header";

    const chevron = document.createElement("span");
    chevron.className = "chevron" + (state.expandedSites.has(site) ? " open" : "");
    header.appendChild(chevron);

    const title = document.createElement("div");
    title.className = "site-card-title";
    const name = document.createElement("span");
    name.className = "site-card-name";
    const displayName = groupDisplayName(site, answers);
    name.textContent = displayName;
    if (displayName !== siteLabel(site)) name.title = siteLabel(site);
    const count = document.createElement("span");
    count.className = "badge-muted";
    count.textContent = `${answers.length} answer${answers.length === 1 ? "" : "s"}`;
    title.append(name, count);

    const actions = document.createElement("div");
    actions.className = "row-actions";
    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-small btn-danger";
    delBtn.textContent = "Delete collection";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const label = groupDisplayName(site, answers);
      if (
        !confirm(`Delete all ${answers.length} answers from "${label}"? This cannot be undone.`)
      ) return;
      const res = await sendMsg({
        type: "deleteSiteCollection",
        profileId: state.answersProfileId,
        site
      });
      if (!res.ok) {
        alert(res.error);
        return;
      }
      state.expandedSites.delete(site);
      await refresh();
    });
    actions.appendChild(delBtn);

    header.append(title, actions);

    // Toggle expand/collapse on click
    header.addEventListener("click", () => {
      if (state.expandedSites.has(site)) state.expandedSites.delete(site);
      else state.expandedSites.add(site);
      renderAnswers();
    });

    card.appendChild(header);

    // Render the nested answer cards when expanded
    if (state.expandedSites.has(site)) {
      const list = document.createElement("div");
      list.className = "site-card-answers";
      for (const a of answers) {
        list.appendChild(buildAnswerCard(a, { compact: true }));
      }
      card.appendChild(list);
    }

    return card;
  }

  /** Render the grouped-by-site card view */
  function renderSiteCards() {
    const wrap = $("siteCards");
    wrap.innerHTML = "";

    const q = state.search.toLowerCase();
    const filtered = state.answers.filter(
      (a) =>
        !q ||
        questionLabel(a).toLowerCase().includes(q) ||
        String(a.value).toLowerCase().includes(q)
    );

    if (state.answers.length === 0) {
      const div = document.createElement("div");
      div.className = "empty";
      div.textContent = "No answers saved in this profile yet.";
      wrap.appendChild(div);
      return;
    }
    if (filtered.length === 0) {
      const div = document.createElement("div");
      div.className = "empty";
      div.textContent = "No answers match your search.";
      wrap.appendChild(div);
      return;
    }

    const groups = groupBySite(filtered);
    const sites = Object.keys(groups).sort((x, y) => groups[y].length - groups[x].length);
    for (const site of sites) {
      wrap.appendChild(buildSiteCard(site, groups[site]));
    }
  }

  /** Add a blank answer card to the top of the list for manual entry */
  function addAnswerRow() {
    if (!state.answersProfileId) {
      alert("Create a profile first.");
      return;
    }
    const list = $("answersList");
    if (list.querySelector(".new-answer")) return;

    const card = document.createElement("div");
    card.className = "answer-card new-answer";

    const row = document.createElement("div");
    row.className = "answer-card-row";

    const text = document.createElement("div");
    text.className = "answer-card-text";

    const keyInput = document.createElement("input");
    keyInput.className = "inline-input";
    keyInput.placeholder = "question / key";

    const valInput = document.createElement("input");
    valInput.className = "inline-input";
    valInput.placeholder = "answer";

    const editRow = document.createElement("div");
    editRow.className = "answer-card-edit";
    editRow.append(keyInput, valInput);

    text.appendChild(editRow);

    const actions = document.createElement("div");
    actions.className = "answer-card-actions";

    const saveBtn = document.createElement("button");
    saveBtn.className = "btn btn-small btn-primary";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", async () => {
      const key = keyInput.value.trim();
      const val = valInput.value.trim();
      if (!key || !val) return;
      const res = await sendMsg({
        type: "saveAnswers",
        profileId: state.answersProfileId,
        pairs: [{ key, value: val, source: "manual", question: key }]
      });
      if (!res.ok) {
        alert(res.error);
        return;
      }
      await refresh();
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-small";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", renderAnswers);

    actions.append(saveBtn, cancelBtn);
    row.append(text, actions);
    card.appendChild(row);
    list.insertBefore(card, list.firstChild);
  }

  // Profile selector in answers view
  $("answersProfileSelect").addEventListener("change", (e) => {
    state.answersProfileId = e.target.value || null;
    loadAnswers().then(renderAnswers);
  });

  // Toggle between flat table and grouped-by-site view
  document.querySelectorAll("[data-answers-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.answersView = btn.dataset.answersView;
      renderAnswers();
    });
  });

  $("addAnswerBtn").addEventListener("click", () => {
    if (state.answersView !== "all") {
      state.answersView = "all";
      renderAnswers();
    }
    addAnswerRow();
  });

  // Live search filter for answers
  $("answerSearch").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderAnswers();
  });

  /* ── AI Settings view ── */

  /** Render the connection selector dropdown */
  function renderConnections() {
    const sel = $("connectionSelect");
    sel.innerHTML = "";
    for (const c of state.connections) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent =
        c.name +
        (c.provider && c.provider !== "Custom" ? ` (${c.provider})` : "") +
        (c.id === state.activeConnectionId ? " — active" : "");
      sel.appendChild(opt);
    }
    if (state.connections.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No connections yet";
      opt.disabled = true;
      sel.appendChild(opt);
    } else {
      sel.value = state.editingConnectionId || "";
    }
  }

  /**
   * Load a connection's details into the AI form for editing.
   * Pass null to reset the form to a blank "New connection" state.
   */
  async function loadConnectionIntoForm(id) {
    const f = $("aiForm");
    if (!id) {
      f.reset();
      f.name.value = "";
      f.provider.value = "OpenAI";
      state.editingConnectionId = null;
      applyProviderPreset("OpenAI");
      return;
    }
    const res = await sendMsg({ type: "getConnection", connectionId: id });
    if (!res.ok) return;
    const c = res.data.connection;
    state.editingConnectionId = id;
    f.name.value = c.name || "";
    f.provider.value = c.provider || "Custom";
    f.baseUrl.value = c.baseUrl || "";
    // The API key is never sent back from background.js — only whether one
    // is set. Leave the field blank; submitting blank keeps the saved key.
    f.apiKey.value = "";
    f.model.value = c.model || "";
    f.temperature.value = c.temperature;
    f.maxTokens.value = c.maxTokens;
    syncProviderUI();
    if (c.hasApiKey) f.apiKey.placeholder = "•••••••• (saved — leave blank to keep)";
    setStatus($("aiStatus"), "");
  }

  async function refreshAI() {
    await loadState();
    renderConnections();
    await loadConnectionIntoForm(state.editingConnectionId);
  }

  // Switch which connection is being edited
  $("connectionSelect").addEventListener("change", async (e) => {
    const id = e.target.value;
    if (!id) return;
    await sendMsg({ type: "setActiveConnection", connectionId: id });
    await refreshAI();
  });

  // Create a new connection (defaults to OpenAI preset)
  $("newConnBtn").addEventListener("click", async () => {
    const res = await sendMsg({ type: "createConnection", provider: "OpenAI", name: "OpenAI" });
    if (!res.ok) {
      setStatus($("aiStatus"), res.error, "error");
      return;
    }
    await loadState();
    renderConnections();
    await loadConnectionIntoForm(res.data.connection.id);
    setStatus($("aiStatus"), "New connection added — enter your API key and save.", "ok");
  });

  // When the provider dropdown changes, auto-fill all fields with that provider's preset
  $("aiForm").elements.provider.addEventListener("change", (e) => {
    applyProviderPreset(e.target.value);
    setStatus(
      $("aiStatus"),
      `Defaults filled for ${e.target.value} — edit if needed, then save.`
    );
  });

  // Save connection settings
  $("aiForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.editingConnectionId) {
      setStatus($("aiStatus"), "Select or add a connection first.", "error");
      return;
    }
    const f = e.target;
    const connection = {
      name: f.name.value,
      provider: f.provider.value,
      baseUrl: f.baseUrl.value,
      model: f.model.value,
      temperature: Number(f.temperature.value),
      maxTokens: Number(f.maxTokens.value)
    };
    // Blank API key field means "keep the current key" — only send it when
    // the user actually typed a new one.
    if (f.apiKey.value) connection.apiKey = f.apiKey.value;
    const res = await sendMsg({
      type: "updateConnection",
      connectionId: state.editingConnectionId,
      connection
    });
    setStatus($("aiStatus"), res.ok ? "Connection saved." : res.error, res.ok ? "ok" : "error");
    if (res.ok) await refreshAI();
  });

  // Delete the currently editing connection
  $("deleteConnBtn").addEventListener("click", async () => {
    if (!state.editingConnectionId) return;
    if (!confirm("Delete this connection?")) return;
    const res = await sendMsg({
      type: "deleteConnection",
      connectionId: state.editingConnectionId
    });
    if (!res.ok) {
      setStatus($("aiStatus"), res.error, "error");
      return;
    }
    state.editingConnectionId = null;
    await refreshAI();
  });

  // Send a test "Say OK" prompt to verify the active LLM connection
  $("testLLMBtn").addEventListener("click", async () => {
    const btn = $("testLLMBtn");
    btn.disabled = true;
    setStatus($("aiStatus"), "Testing…");
    const res = await sendMsg({ type: "testLLM" });
    setStatus(
      $("aiStatus"),
      res.ok ? `Connection OK — model replied: ${res.data.reply}` : res.error,
      res.ok ? "ok" : "error"
    );
    btn.disabled = false;
  });

  /* ── Data management ── */

  /** Export all profile/answer data as a downloadable JSON file */
  async function exportData() {
    try {
      const all = await chrome.storage.local.get("formauto");
      const blob = new Blob([JSON.stringify(all.formauto || {}, null, 2)], {
        type: "application/json"
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `formauto-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
      alert("Export failed: " + ((err && err.message) || err));
    }
  }

  $("exportBtn").addEventListener("click", exportData);

  // Import: open file picker, parse JSON, replace all data
  $("importBtn").addEventListener("click", () => $("importFile").click());

  $("importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== "object") throw new Error("Invalid backup file");
      await chrome.storage.local.set({ formauto: data });
      e.target.value = "";
      await refresh();
      alert("Import complete.");
    } catch (err) {
      alert("Import failed: " + err.message);
    }
  });

  // Reset: wipe everything
  $("resetBtn").addEventListener("click", async () => {
    if (!confirm("Delete ALL profiles, answers, and settings? This cannot be undone.")) return;
    try {
      await chrome.storage.local.remove("formauto");
      await refresh();
    } catch (err) {
      alert("Reset failed: " + ((err && err.message) || err));
    }
  });

  /* ── Full refresh (reloads all views) ── */

  async function refresh() {
    await loadAccount();
    renderPlanBanner();
    await loadState();
    renderProfiles();
    renderAutoDetectToggle();
    renderAnswersSelect();
    await loadAnswers();
    renderAnswers();
    renderConnections();
    await loadConnectionIntoForm(state.editingConnectionId);
  }

  refresh();
})();
