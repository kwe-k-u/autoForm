/**
 * content-script.js
 *
 * Injected into every web page via MV3 content_scripts.
 * Responsibilities:
 *   1. Detect form fields and read their labels/placeholders for question text.
 *   2. Match on-page questions against saved answers in the active profile.
 *   3. Apply matched values to empty fields (heuristic token-set matching).
 *   4. Optionally use LLM semantic matching for unmatched fields (manual "Autofill now" only).
 *   5. Learn new answers while the user types (auto-save via debounced flush).
 *   6. Capture all answers on form submit or explicit "Save this page's answers".
 *
 * Guard: `window.__FF_INJECTED` prevents double-injection on SPAs.
 * The `__FF_AUTOFILLING` flag suppresses the auto-save input listener while
 * the extension is programmatically filling a field.
 *
 * Requires shared/matching.js (loaded first — see manifest.json) for
 * text-normalisation and answer-matching (`normalizeKey`, `cleanText`,
 * `humanize`, `tokenSet`, `matchAnswer`).
 */
(() => {
  "use strict";

  /* ── Guard against double-injection ── */
  if (window.__FF_INJECTED) return;
  window.__FF_INJECTED = true;

  /* ── Shared text-normalisation & matching helpers (shared/matching.js) ── */
  const { normalizeKey, cleanText, humanize, tokenSet, matchAnswer } = FFMatching;

  /* ── Tuning constants ── */
  const SAVE_DEBOUNCE_MS = 1200;          // Legacy; flush timer uses 400 ms instead
  const FIELD_SELECTOR = "input, select, textarea";

  /** Input types we never try to auto-fill (buttons, files, ranges, etc.) */
  const SKIP_TYPES = new Set([
    "hidden", "submit", "button", "reset", "image", "file", "password", "range"
  ]);

  /* ── Shared mutable state ── */
  const state = { autofillEnabled: false, autoSaveTyping: false, autoSaveDetection: false, activeProfileId: null };

  /** Hostname of the current page, stored with every saved answer */
  const PAGE_SITE = location.hostname || null;

  /**
   * Friendly application/site name for the current page, stored alongside
   * PAGE_SITE so the options UI can display it instead of the raw hostname.
   * Prefers the page's declared site name (og:site_name / application-name)
   * over the document title, since titles often include the specific
   * page/article name rather than the site's brand name.
   */
  const PAGE_NAME = (() => {
    const meta = document.querySelector(
      'meta[property="og:site_name"], meta[name="application-name"]'
    );
    const metaName = meta && meta.content ? meta.content.trim() : "";
    if (metaName) return metaName;
    const title = document.title ? document.title.trim() : "";
    return title || null;
  })();

  /** Per-page auto-save toggle (toggled by user or LLM detection) */
  let pageAutoSave = false;
  let pageAutoSaveChecked = false;  // Ensures LLM detection runs only once per load

  /** Map of key → { key, value, source, question } awaiting flush to background */
  const pending = new Map();
  let flushTimer = null;     // Debounce timer for flushing pending answers
  let autofillTimer = null;  // Debounce timer for auto-triggered autofill runs
  let lastFillCount = 0;     // Number of fields filled in the most recent run

  /* ── Messaging helpers ── */

  /**
   * Send a message to the service worker (background.js).
   * Returns a promise that always resolves — errors are normalised to
   * `{ ok: false, error: "..." }`.
   */
  function sendMsg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(res || { ok: false, error: "No response" });
      });
    });
  }

  /** Pull the latest shared state (autofill toggle, active profile, etc.) */
  async function refreshState() {
    const r = await sendMsg({ type: "getState" });
    if (r.ok) {
      state.autofillEnabled = !!r.data.autofillEnabled;
      state.autoSaveTyping = r.data.autoSaveTyping !== false;
      state.autoSaveDetection = r.data.autoSaveDetection === true;
      state.activeProfileId = r.data.activeProfileId || null;
    }
  }

  /** Fetch the full profile object (including answers map) by id */
  async function getProfile(id) {
    const r = await sendMsg({ type: "getProfile", profileId: id });
    return r.ok ? r.data : null;
  }

  /* ── Field introspection helpers ── */

  /** Return a canonical type string: "textarea", "select", or the `type` attr */
  function fieldType(el) {
    if (el.tagName === "TEXTAREA") return "textarea";
    if (el.tagName === "SELECT") return "select";
    return (el.getAttribute("type") || "text").toLowerCase();
  }

  /** True if the element is connected, not disabled/read-only, and not a skipped type */
  function isEligible(el) {
    if (!el || !el.isConnected) return false;
    if (el.disabled || el.readOnly) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const t = fieldType(el);
    return !SKIP_TYPES.has(t);
  }

  const SHORT_LABEL = 120; // Max length for a node to be considered a label candidate

  /** True for elements that look like a short text label (not a field itself) */
  function isLabelish(node) {
    if (node.nodeType !== 1) return false;
    const t = cleanText(node.textContent);
    if (!t || t.length > SHORT_LABEL) return false;
    if (node.matches && node.matches(FIELD_SELECTOR)) return false;
    if (node.querySelector && node.querySelector(FIELD_SELECTOR)) return false;
    return true;
  }

  /**
   * Collect text from preceding text nodes within a container.
   * Returns null if nothing meaningful or if the text is too long.
   */
  function precedingTextNode(container, child) {
    let text = "";
    for (const node of container.childNodes) {
      if (node === child) break;
      if (node.nodeType === 3) {
        const t = cleanText(node.textContent);
        if (t) text = (text + " " + t).trim();
      }
    }
    if (!text || text.length > SHORT_LABEL) return null;
    return text;
  }

  /**
   * Walk up to 4 ancestor levels looking for a preceding sibling element
   * whose text looks like a question label for this field.
   */
  function scanQuestion(el) {
    let child = el;
    let parent = el.parentElement;
    for (let depth = 0; parent && depth < 4; depth++) {
      const children = Array.from(parent.children);
      const idx = children.indexOf(child);
      if (idx > 0) {
        for (let i = idx - 1; i >= 0; i--) {
          if (isLabelish(children[i])) return cleanText(children[i].textContent);
        }
      }
      const text = precedingTextNode(parent, child);
      if (text) return text;
      child = parent;
      parent = parent.parentElement;
    }
    return null;
  }

  /** True if `el` belongs to a group of same-name radios or checkboxes */
  function isGroupedChoice(el) {
    const group = Array.from(document.getElementsByName(el.name)).filter(
      (r) => r.type === el.type && r.name === el.name
    );
    return group.length > 1;
  }

  /**
   * For grouped radios/checkboxes, find the nearest common ancestor and look
   * for a question label — prefers `<legend>` inside a `<fieldset>`, otherwise
   * walks preceding siblings up to 3 levels.
   */
  function groupQuestion(el) {
    const group = Array.from(document.getElementsByName(el.name)).filter(
      (r) => r.type === el.type
    );
    if (!group.length) return null;
    let common = group[0].parentElement;
    while (common && !group.every((g) => common.contains(g))) {
      common = common.parentElement;
    }
    if (!common) return null;
    const fs = common.closest("fieldset");
    if (fs) {
      const legend = fs.querySelector(":scope > legend");
      if (legend) return cleanText(legend.textContent);
    }
    let node = common;
    let parent = node.parentElement;
    for (let depth = 0; parent && depth < 3; depth++) {
      const children = Array.from(parent.children);
      const idx = children.indexOf(node);
      if (idx > 0) {
        for (let i = idx - 1; i >= 0; i--) {
          if (isLabelish(children[i])) return cleanText(children[i].textContent);
        }
      }
      node = parent;
      parent = parent.parentElement;
    }
    return null;
  }

  /**
   * Determine the display label for a radio/checkbox option element.
   * Checks `<label for>`, `.labels`, parent `<label>`, preceding sibling,
   * and falls back to the option value.
   */
  function optionLabel(el) {
    const id = el.id;
    if (id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl) return cleanText(lbl.textContent);
      } catch {
        /* ignore invalid selector */
      }
    }
    if (el.labels && el.labels.length) {
      const t = cleanText(el.labels[0].textContent);
      if (t) return t;
    }
    const parent = el.parentElement;
    if (parent && parent.matches("label")) {
      const t = cleanText(parent.textContent);
      if (t) return t;
    }
    if (parent) {
      const children = Array.from(parent.children);
      const idx = children.indexOf(el);
      if (idx > 0) {
        const prev = children[idx - 1];
        if (prev) {
          const t = cleanText(prev.textContent);
          if (t && t.length <= SHORT_LABEL && !prev.querySelector(FIELD_SELECTOR)) return t;
        }
      }
    }
    return el.value ? String(el.value) : null;
  }

  /**
   * Master label resolution for any form element.
   * Tries, in order: group question, `<label for>`, `.labels[0]`,
   * `aria-labelledby`, `<legend>`, `aria-label`, placeholder, title,
   * surrounding DOM scan. Returns the first non-empty result.
   */
  function getLabel(el) {
    const isChoice = el.type === "radio" || el.type === "checkbox";
    if (isChoice && isGroupedChoice(el)) {
      const gq = groupQuestion(el);
      if (gq) return gq;
    }
    const id = el.id;
    if (id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl) return cleanText(lbl.textContent);
      } catch {
        /* ignore invalid selector */
      }
    }
    if (el.labels && el.labels.length) {
      const t = cleanText(el.labels[0].textContent);
      if (t) return t;
    }
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      for (const refId of labelledby.split(/\s+/)) {
        const ref = document.getElementById(refId);
        if (ref) {
          const t = cleanText(ref.textContent);
          if (t) return t;
        }
      }
    }
    if (isChoice) {
      const fs = el.closest("fieldset");
      if (fs) {
        const legend = fs.querySelector(":scope > legend");
        if (legend) return cleanText(legend.textContent);
      }
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return cleanText(ariaLabel);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return cleanText(placeholder);
    const title = el.getAttribute("title");
    if (title) return cleanText(title);
    const surrounding = scanQuestion(el);
    if (surrounding) return surrounding;
    return null;
  }

  /** Return the best-guess question text for a field (label or humanised name/id) */
  function fieldQuestion(el) {
    const label = getLabel(el);
    if (label) return label;
    const name = el.getAttribute("name") || el.id;
    return name ? humanize(name) : null;
  }

  /** Build a normalised lookup key from the field's label or name/id */
  function fieldKey(el) {
    const question = getLabel(el);
    if (question) return normalizeKey(question);
    return normalizeKey(el.getAttribute("name") || el.id);
  }

  /* ── Value set/read with React-compatible native setter ── */

  /**
   * Use the prototype's native setter so React-controlled inputs
   * pick up the change (they intercept direct `el.value = ...`).
   */
  function setNativeValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype;
    const prop =
      el.tagName === "SELECT" || el.type !== "checkbox"
        ? "value"
        : "checked";
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (desc && desc.set) desc.set.call(el, value);
    else el[prop] = value;
  }

  /** Dispatch `input` and `change` events so framework listeners fire */
  function fireEvents(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** True if the field already has a user-entered value (or a radio in the group is checked) */
  function hasExistingValue(el) {
    const t = fieldType(el);
    if (t === "radio") {
      return Array.from(document.getElementsByName(el.name)).some((r) => r.checked);
    }
    if (t === "checkbox") return el.checked;
    return String(el.value || "").trim() !== "";
  }

  /**
   * Apply a value to a field, handling select/radio/checkbox/text specially.
   * Returns true if the value was applied.
   */
  function applyValue(el, value) {
    const t = fieldType(el);
    const v = String(value ?? "");

    if (t === "select") {
      const opt = Array.from(el.options).find(
        (o) => o.value === v || o.text.trim() === v || o.text.trim().toLowerCase() === v.toLowerCase()
      );
      if (!opt) return false;
      setNativeValue(el, opt.value);
      fireEvents(el);
      return true;
    }

    if (t === "radio") {
      const group = Array.from(document.getElementsByName(el.name));
      const match = group.find(
        (r) =>
          r.value === v ||
          String(r.value).toLowerCase() === v.toLowerCase() ||
          (optionLabel(r) || "").toLowerCase() === v.toLowerCase()
      );
      if (!match) return false;
      if (!match.checked) {
        setNativeValue(match, true);
        fireEvents(match);
      }
      return true;
    }

    if (t === "checkbox") {
      const truthy = /^(yes|true|y|1|agree|ok|on)$/i.test(v);
      if (el.checked !== truthy) {
        setNativeValue(el, truthy);
        fireEvents(el);
      }
      return true;
    }

    if (String(el.value || "") !== v) {
      setNativeValue(el, v);
      fireEvents(el);
    }
    return true;
  }

  /** Read the current value from a field as a normalised string (or null) */
  function readValue(el) {
    const t = fieldType(el);
    if (t === "radio") {
      const checked = Array.from(document.getElementsByName(el.name)).find((r) => r.checked);
      if (!checked) return null;
      return String(checked.value || optionLabel(checked) || "").trim() || null;
    }
    if (t === "checkbox") return el.checked ? "yes" : "no";
    const v = el.value;
    return v !== undefined && v !== null && String(v).trim() !== "" ? String(v).trim() : null;
  }

  /** Get the list of allowed option values for a select/radio/checkbox, or null */
  function optionsFor(el) {
    const t = fieldType(el);
    if (t === "select") {
      const opts = Array.from(el.options)
        .map((o) => o.value || o.text.trim())
        .filter((o) => o)
        .filter((o, i, arr) => arr.indexOf(o) === i);
      return opts.length ? opts : null;
    }
    if (t === "radio") {
      const vals = Array.from(document.getElementsByName(el.name))
        .map((r) => String(r.value || optionLabel(r) || "").trim())
        .filter((o) => o)
        .filter((o, i, arr) => arr.indexOf(o) === i);
      return vals.length ? vals : null;
    }
    if (t === "checkbox") return ["yes", "no"];
    return null;
  }

  /**
   * Return all visible, eligible form fields on the page.
   * Deduplicates by name/id/placeholder so grouped radios only appear once.
   */
  function visibleEligibleFields() {
    const els = Array.from(document.querySelectorAll(FIELD_SELECTOR));
    const out = [];
    const seen = new Set();
    for (const el of els) {
      if (!isEligible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const key = el.name || el.id || el.getAttribute("placeholder") || "";
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(el);
    }
    return out;
  }

  /* ── Touch tracking (prevents re-filling a field the user edited) ── */

  function isTouched(el) {
    return el.dataset.ffTouched === "1";
  }

  function markTouched(el) {
    el.dataset.ffTouched = "1";
  }

  /* ── Auto-save (learn while typing) ── */

  /** Debounced flush: batch pending answers and send to background */
  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPending, 400);
  }

  /**
   * Send all accumulated pending answer pairs to background.js for storage.
   * Clears the pending map. If no active profile, discards everything.
   */
  function flushPending() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!pending.size) return;
    if (!state.activeProfileId) {
      pending.clear();
      return;
    }
    const pairs = Array.from(pending.values());
    pending.clear();
    sendMsg({
      type: "saveAnswers",
      profileId: state.activeProfileId,
      pairs: pairs.map((p) => ({ ...p, site: PAGE_SITE, siteName: PAGE_NAME }))
    }).catch((err) => console.warn("[autoForm]", (err && err.message) || "Failed to save answers"));
  }

  /**
   * Input/change handler — records the field's value for auto-save.
   * Ignored while `__FF_AUTOFILLING` is true (programmatic fill in progress).
   */
  function onFieldInput(e) {
    if (window.__FF_AUTOFILLING) return;
    const el = e.target;
    if (!el || !isEligible(el)) return;
    markTouched(el);
    if (!pageAutoSave) return;
    const question = fieldQuestion(el);
    const key = fieldKey(el);
    if (!key) return;
    const value = readValue(el);
    if (value === null) return;
    const pair = pending.get(key);
    if (pair && pair.value === value) return;
    pending.set(key, { key, value, source: "learned", question: question || null });
    scheduleFlush();
  }

  /* ── Core autofill logic ── */

  /**
   * Run the autofill pipeline for the current page.
   *
   * @param {object} opts
   * @param {boolean} [opts.manual]  — true when triggered by "Autofill now" button
   *                                    (bypasses autofillEnabled toggle)
   * @param {boolean} [opts.llm]     — true to use LLM semantic matching for
   *                                    unmatched fields after heuristic matching
   */
  async function runAutofill(opts) {
    opts = opts || {};
    await refreshState();
    if (!opts.manual && !state.autofillEnabled) return;
    const profile = await getProfile(state.activeProfileId);
    if (!profile) return;
    lastFillCount = 0;
    const answers = profile.answers || {};
    const keys = Object.keys(answers);
    if (!keys.length) return;

    const fields = visibleEligibleFields();
    const toMatch = []; // Fields that need LLM matching

    // First pass: count how many fields would be filled (no side effects)
    const fillPlan = [];
    for (const el of fields) {
      if (isTouched(el)) continue;
      if (hasExistingValue(el)) continue;
      const labelKey = normalizeKey(getLabel(el));
      const nameKey = normalizeKey(el.getAttribute("name") || el.id);
      const answer = matchAnswer(profile, labelKey, nameKey);
      if (answer) {
        fillPlan.push({ el, answer });
        continue;
      }
      if (opts.llm) {
        toMatch.push({ el, labelKey, nameKey, question: fieldQuestion(el) });
      }
    }

    if (!fillPlan.length && !toMatch.length) return;

    // Auto-triggered fills require user confirmation
    if (!opts.manual && fillPlan.length > 0) {
      const confirmed = await showAutofillConfirmation(fillPlan.length + toMatch.length);
      if (!confirmed) return;
    }

    // Apply heuristic matches
    for (const { el, answer } of fillPlan) {
      window.__FF_AUTOFILLING = true;
      try {
        if (applyValue(el, answer.value)) {
          markTouched(el);
          lastFillCount++;
        }
      } finally {
        window.__FF_AUTOFILLING = false;
      }
    }

    // If no LLM pass requested or nothing to match, we're done
    if (!opts.llm || !toMatch.length) return;

    // Send unmatched fields to background for LLM semantic matching
    let matches = [];
    try {
      const res = await sendMsg({
        type: "matchSavedAnswers",
        profileId: state.activeProfileId,
        fields: toMatch.map(({ el, ...rest }) => rest)
      });
      if (!res.ok) throw new Error(res.error);
      matches = res.data || [];
    } catch (e) {
      return;
    }

    // Apply LLM-matched values
    for (let i = 0; i < matches.length; i++) {
      const item = matches[i];
      const entry = toMatch[i];
      if (!item || item.error || item.value == null) continue;
      const el = entry.el;
      window.__FF_AUTOFILLING = true;
      try {
        if (applyValue(el, item.value)) {
          markTouched(el);
          lastFillCount++;
        }
      } finally {
        window.__FF_AUTOFILLING = false;
      }
    }
  }

  /** Debounced auto-trigger for autofill (page load, mutations, storage changes) */
  function scheduleAutofill(delay) {
    if (autofillTimer) clearTimeout(autofillTimer);
    autofillTimer = setTimeout(runAutofill, delay || 300);
  }

  /**
   * Snapshot every eligible field's value and save it as a "learned" answer.
   * Called on form submit and via the "Save this page's answers" button.
   */
  async function captureForm(form) {
    if (!state.activeProfileId) await refreshState();
    if (!state.activeProfileId) return;
    const scope = form ? form : document;
    const pairs = Array.from(scope.querySelectorAll(FIELD_SELECTOR))
      .filter(isEligible)
      .map((el) => {
        const key = fieldKey(el);
        const value = readValue(el);
        const question = fieldQuestion(el);
        return key && value ? { key, value, source: "learned", site: PAGE_SITE, siteName: PAGE_NAME, question: question || null } : null;
      })
      .filter(Boolean);
    if (pairs.length) {
      await sendMsg({ type: "saveAnswers", profileId: state.activeProfileId, pairs });
    }
  }

  /* ── Autofill confirmation banner ── */

  /**
   * Show a floating confirmation banner at the top of the page asking
   * the user to confirm before autofill proceeds. Returns a promise
   * that resolves to `true` (confirmed) or `false` (dismissed/timeout).
   */
  function showAutofillConfirmation(count) {
    return new Promise((resolve) => {
      // Remove any existing banner
      const existing = document.getElementById("__ff_confirm_banner");
      if (existing) existing.remove();

      const host = (typeof location !== "undefined" && location.hostname) || "this page";
      const banner = document.createElement("div");
      banner.id = "__ff_confirm_banner";
      banner.style.cssText = [
        "position:fixed","top:0","left:0","right:0","z-index:2147483647",
        "background:#1e293b","color:#f8fafc","padding:10px 16px",
        "display:flex","align-items:center","justify-content:center","gap:12px",
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
        "font-size:13px","box-shadow:0 2px 12px rgba(0,0,0,0.25)",
        "animation:__ff_slideDown 0.2s ease"
      ].join(";");

      const style = document.createElement("style");
      style.textContent = "@keyframes __ff_slideDown{from{transform:translateY(-100%)}to{transform:translateY(0)}}";
      banner.appendChild(style);

      const msg = document.createElement("span");
      msg.textContent = `autoForm found ${count} matching field${count === 1 ? "" : "s"}. Autofill now?`;
      banner.appendChild(msg);

      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        banner.remove();
        resolve(result);
      };

      const fillBtn = document.createElement("button");
      fillBtn.textContent = "\u2713 Fill";
      fillBtn.style.cssText = "background:#22c55e;color:#fff;border:none;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:13px;font-weight:600;";
      fillBtn.addEventListener("click", () => settle(true));

      const dismissBtn = document.createElement("button");
      dismissBtn.textContent = "\u2715 Dismiss";
      dismissBtn.style.cssText = "background:#64748b;color:#fff;border:none;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:13px;";
      dismissBtn.addEventListener("click", () => settle(false));

      banner.appendChild(fillBtn);
      banner.appendChild(dismissBtn);
      document.documentElement.appendChild(banner);

      // Auto-dismiss after 30 seconds
      setTimeout(() => settle(false), 30000);
    });
  }

  /* ── LLM form detection (once per page load) ── */

  /**
   * Ask the LLM whether the current page is a fillable form.
   * Runs at most once per page load. If the LLM says yes,
   * pageAutoSave is turned on for this page.
   */
  async function runFormDetection() {
    if (pageAutoSaveChecked) return;
    pageAutoSaveChecked = true;
    if (!state.autoSaveDetection) return;
    // Collect field labels to give the LLM context
    const fields = visibleEligibleFields();
    const labels = fields.slice(0, 25).map((el) => fieldQuestion(el) || "").filter(Boolean);
    if (!labels.length) return; // No fields visible — not a form
    try {
      const res = await sendMsg({
        type: "detectFormPage",
        url: location.href,
        title: document.title,
        fieldLabels: labels
      });
      if (res.ok && res.data && res.data.isForm) {
        pageAutoSave = true;
      }
    } catch {
      // Silently fail — detection is best-effort
    }
  }

  /**
   * "Suggest with AI" pipeline.
   * 1. Heuristic-fill from profile (like runAutofill without LLM).
   * 2. Send remaining unfilled fields to background for LLM suggestions.
   * 3. Apply suggestions and mark as learned.
   */
  async function suggestAll() {
    await refreshState();
    if (!state.activeProfileId) {
      return { ok: false, error: "No active profile. Create or select one in the autoForm popup." };
    }
    const profile = await getProfile(state.activeProfileId);
    if (!profile) return { ok: false, error: "Active profile could not be loaded." };

    let autofilled = 0;
    const toSuggest = [];
    const fields = visibleEligibleFields();

    for (const el of fields) {
      const label = fieldQuestion(el);
      const labelKey = normalizeKey(label);
      const nameKey = normalizeKey(el.getAttribute("name") || el.id);
      const answer = matchAnswer(profile, labelKey, nameKey);

      if (answer && !hasExistingValue(el)) {
        window.__FF_AUTOFILLING = true;
        try {
          if (applyValue(el, answer.value)) {
            markTouched(el);
            autofilled++;
          }
        } finally {
          window.__FF_AUTOFILLING = false;
        }
        continue;
      }
      if (hasExistingValue(el) || isTouched(el)) continue;
      toSuggest.push({
        key: labelKey || nameKey,
        question: label || humanize(nameKey),
        fieldType: fieldType(el),
        options: optionsFor(el),
        _el: el
      });
    }

    if (!toSuggest.length) {
      return { ok: true, count: 0, autofilled, message: "No unanswered fields found on this page." };
    }

    // Strip DOM elements before sending to background
    const payload = toSuggest.map(({ _el, ...rest }) => rest);
    const res = await sendMsg({
      type: "suggestAnswers",
      profileId: state.activeProfileId,
      fields: payload
    });
    if (!res.ok) throw new Error(res.error);

    let suggested = 0;
    for (let i = 0; i < res.data.length; i++) {
      const item = res.data[i];
      if (item.error || item.suggested == null) continue;
      const el = toSuggest[i]._el;
      window.__FF_AUTOFILLING = true;
      try {
        if (applyValue(el, item.suggested)) {
          markTouched(el);
          suggested++;
        }
      } finally {
        window.__FF_AUTOFILLING = false;
      }
      // Queue LLM-sourced answers for persistence
      pending.set(toSuggest[i].key, {
        key: toSuggest[i].key,
        value: item.suggested,
        source: "llm",
        question: toSuggest[i].question || null
      });
    }
    scheduleFlush();

    return {
      ok: true,
      count: suggested,
      autofilled,
      message: suggested
        ? `Suggested ${suggested} answer(s), autofilled ${autofilled} from profile.`
        : `Autofilled ${autofilled} from profile. No LLM suggestions returned.`
    };
  }

  /* ── Message listener (receives commands from popup) ── */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      switch (msg.type) {
        case "FF_AUTOFILL":
          // Manual autofill: bypasses toggle, uses LLM for unmatched fields
          await runAutofill({ llm: true, manual: true });
          return { ok: true, count: lastFillCount };
        case "FF_CAPTURE":
          await captureForm(null);
          return { ok: true, message: "Saved this page's answers." };
        case "FF_SUGGEST":
          return suggestAll();
        case "FF_CLEAR_TOUCHED":
          // Reset touch tracking so fields can be re-filled
          document
            .querySelectorAll("[data-ff-touched]")
            .forEach((el) => delete el.dataset.ffTouched);
          return { ok: true };
        case "FF_TOGGLE_PAGE_AUTOSAVE":
          pageAutoSave = !!msg.enabled;
          return { ok: true, pageAutoSave };
        case "FF_GET_PAGE_AUTOSAVE":
          return { ok: true, pageAutoSave };
        default:
          return { ok: false, error: "Unknown FF message: " + msg.type };
      }
    })()
      .then((data) => sendResponse(data))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // Keep the message channel open for async response
  });

  /* ── Storage change listener (reacts to popup toggle changes) ── */

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const c = changes["formauto"];
    if (!c) return;
    const prev = c.oldValue || {};
    const next = c.newValue || {};
    state.autoSaveDetection = next.autoSaveDetection === true;
    // Re-run autofill when the active profile or toggle changes
    if (
      next.autofillEnabled !== prev.autofillEnabled ||
      next.activeProfileId !== prev.activeProfileId
    ) {
      scheduleAutofill(200);
    }
    // Reset detection flag when auto-detection toggle changes so it re-runs
    if (next.autoSaveDetection !== prev.autoSaveDetection) {
      pageAutoSaveChecked = false;
      if (next.autoSaveDetection) {
        runFormDetection();
      } else {
        pageAutoSave = false;
      }
    }
  });

  /* ── Page event listeners ── */

  // Auto-save: record values as the user types or changes fields
  document.addEventListener("input", onFieldInput, true);
  document.addEventListener("change", onFieldInput, true);

  // Capture all answers on form submit
  document.addEventListener(
    "submit",
    (e) => {
      captureForm(e.target).catch(() => {});
    },
    true
  );

  // Flush any pending answers before the page unloads
  window.addEventListener("beforeunload", flushPending);

  /* ── MutationObserver: detect dynamically added form fields ── */

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type !== "childList" || !m.addedNodes.length) continue;
      let hasField = false;
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches(FIELD_SELECTOR)) {
          hasField = true;
          break;
        }
        if (node.querySelector && node.querySelector(FIELD_SELECTOR)) {
          hasField = true;
          break;
        }
      }
      if (hasField) {
        scheduleAutofill(400);
        break;
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  /* ── Initial autofill on page load (multiple passes for slow-rendering pages) ── */

  async function initialLoad() {
    await refreshState();
    // Run LLM form detection once (if auto-detection is enabled)
    runFormDetection();
    // Schedule autofill passes
    scheduleAutofill(150);
    setTimeout(() => scheduleAutofill(1200), 1200);   // Catch late-rendering SPAs
    setTimeout(() => scheduleAutofill(3000), 3000);   // Catch very slow loaders
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialLoad);
  } else {
    initialLoad();
  }
})();
