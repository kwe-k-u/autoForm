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
  const state = { autofillEnabled: false, autoSaveTyping: false, autoSaveDetection: false, formDetectionMode: "manual", activeProfileId: null };

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

  /** The element under the cursor the last time the native context menu opened */
  let lastContextMenuTarget = null;

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
      state.formDetectionMode = r.data.formDetectionMode === "auto" ? "auto" : "manual";
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

  /* ── Confirmation banners ── */

  /** Serializes banner prompts so two triggered in the same page load queue instead of clobbering each other's DOM node */
  let bannerChain = Promise.resolve();

  const BANNER_THROTTLE_STORAGE_KEY = "formautoBannerThrottle";
  const BANNER_THROTTLE_MS = 60 * 60 * 1000; // Don't re-prompt the same banner kind on the same site within an hour
  const BANNER_THROTTLE_PRUNE_MS = 7 * 24 * 60 * 60 * 1000; // Forget sites idle longer than a week, to bound storage growth

  /** True if `throttleKey` was already shown on this hostname within the last hour. */
  async function isBannerThrottled(throttleKey) {
    if (!PAGE_SITE) return false; // No hostname to key on (e.g. file://) -- never throttle
    try {
      const data = await chrome.storage.local.get(BANNER_THROTTLE_STORAGE_KEY);
      const last = ((data[BANNER_THROTTLE_STORAGE_KEY] || {})[PAGE_SITE] || {})[throttleKey];
      return typeof last === "number" && Date.now() - last < BANNER_THROTTLE_MS;
    } catch {
      return false; // Best-effort -- never block a banner because storage failed
    }
  }

  /** Record that `throttleKey` was just shown on this hostname, and prune long-idle hostnames. */
  async function recordBannerShown(throttleKey) {
    if (!PAGE_SITE) return;
    try {
      const data = await chrome.storage.local.get(BANNER_THROTTLE_STORAGE_KEY);
      const all = data[BANNER_THROTTLE_STORAGE_KEY] || {};
      const now = Date.now();
      const bucket = all[PAGE_SITE] || {};
      bucket[throttleKey] = now;
      all[PAGE_SITE] = bucket;
      for (const host of Object.keys(all)) {
        if (Object.values(all[host]).every((t) => now - t > BANNER_THROTTLE_PRUNE_MS)) delete all[host];
      }
      await chrome.storage.local.set({ [BANNER_THROTTLE_STORAGE_KEY]: all });
    } catch {
      // Best-effort -- a failed write just means this run isn't remembered
    }
  }

  /**
   * Show a small confirmation card in the middle of the page with a
   * confirm/dismiss button pair. Returns a promise that resolves to
   * `true` (confirmed) or `false` (dismissed/timed out/throttled).
   * When `throttleKey` is given, the card is skipped entirely (resolving
   * `false` without showing anything) if it was already shown for this
   * same hostname within the last hour -- this is what stops a dismissed
   * banner from reappearing on every reload.
   */
  function showConfirmationBanner({ message, confirmLabel, dismissLabel, throttleKey }) {
    const run = async () => {
      if (throttleKey && (await isBannerThrottled(throttleKey))) return false;
      if (throttleKey) await recordBannerShown(throttleKey);

      return new Promise((resolve) => {
        // Remove any existing banner
        const existing = document.getElementById("__ff_confirm_banner");
        if (existing) existing.remove();

        const card = document.createElement("div");
        card.id = "__ff_confirm_banner";
        card.style.cssText = [
          "position:fixed", "top:50%", "left:50%", "transform:translate(-50%,-50%)",
          "z-index:2147483647", "max-width:320px", "width:calc(100vw - 32px)",
          "background:#1e293b", "color:#f8fafc", "padding:16px",
          "border-radius:12px", "box-shadow:0 8px 30px rgba(0,0,0,0.4)",
          "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
          "font-size:13px", "display:flex", "flex-direction:column", "gap:12px"
        ].join(";");

        const msg = document.createElement("div");
        msg.textContent = message;
        card.appendChild(msg);

        let settled = false;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          card.remove();
          resolve(result);
        };

        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";

        const dismissBtn = document.createElement("button");
        dismissBtn.textContent = dismissLabel;
        dismissBtn.style.cssText = "background:#64748b;color:#fff;border:none;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:13px;";
        dismissBtn.addEventListener("click", () => settle(false));

        const confirmBtn = document.createElement("button");
        confirmBtn.textContent = confirmLabel;
        confirmBtn.style.cssText = "background:#22c55e;color:#fff;border:none;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:13px;font-weight:600;";
        confirmBtn.addEventListener("click", () => settle(true));

        btnRow.append(dismissBtn, confirmBtn);
        card.appendChild(btnRow);
        document.documentElement.appendChild(card);

        // Auto-dismiss after 30 seconds
        setTimeout(() => settle(false), 30000);
      });
    };
    const next = bannerChain.then(run, run);
    bannerChain = next.catch(() => {});
    return next;
  }

  /** Ask the user to confirm before autofill proceeds. At most once per hour per site. */
  function showAutofillConfirmation(count) {
    return showConfirmationBanner({
      message: `autoForm found ${count} matching field${count === 1 ? "" : "s"}. Autofill now?`,
      throttleKey: "autofill",
      confirmLabel: "\u2713 Fill",
      dismissLabel: "\u2715 Dismiss"
    });
  }

  /** Ask the user to confirm before saving answers on a detected relevant form. At most once per hour per site. */
  function showSaveConfirmation() {
    return showConfirmationBanner({
      message: "autoForm detected a form relevant to your profile. Start saving your answers?",
      throttleKey: "save",
      confirmLabel: "\u2713 Save",
      dismissLabel: "\u2715 Not now"
    });
  }

  /* ── Anchored per-field suggestion preview (used by "Suggest with AI") ── */

  const FIELD_PREVIEW_ID = "__ff_field_preview";
  const FIELD_PREVIEW_OPTIONS_ID = "__ff_field_preview_options";
  const FIELD_LOADING_ID = "__ff_field_loading";

  /**
   * Pins a floating box to `el`'s on-screen position: highlights the field,
   * scrolls it into view once, and keeps whatever box is currently shown
   * synced to the field's position via scroll/resize listeners. Multiple
   * boxes can be swapped in over the anchor's lifetime (e.g. a loading
   * indicator handed off to a preview box) without re-highlighting or
   * re-scrolling. `destroy()` tears everything down and restores the
   * field's original outline.
   */
  function createFieldAnchor(el) {
    const originalOutline = el.style.outline;
    const originalOutlineOffset = el.style.outlineOffset;
    el.style.outline = "2px solid #6366f1";
    el.style.outlineOffset = "2px";
    el.scrollIntoView({ block: "center", behavior: "auto" });

    let box = null;
    let onDisconnected = null;

    function reposition() {
      if (!el.isConnected) {
        if (onDisconnected) onDisconnected();
        return;
      }
      if (!box) return;
      const rect = el.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const bw = boxRect.width || 300;
      const bh = boxRect.height || 60;
      let left = Math.min(Math.max(rect.left, 8), window.innerWidth - bw - 8);
      if (left < 8) left = 8;
      let top;
      if (window.innerHeight - rect.bottom >= bh + 8) {
        top = rect.bottom + 8;
      } else if (rect.top >= bh + 8) {
        top = rect.top - bh - 8;
      } else {
        top = Math.min(Math.max(rect.bottom + 8, 8), window.innerHeight - bh - 8);
      }
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.visibility = "visible";
    }

    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);

    return {
      show(newBox) {
        if (box) box.remove();
        box = newBox;
        document.documentElement.appendChild(box);
        reposition();
      },
      setOnDisconnected(fn) {
        onDisconnected = fn;
      },
      destroy() {
        window.removeEventListener("scroll", reposition, true);
        window.removeEventListener("resize", reposition);
        if (box) box.remove();
        box = null;
        el.style.outline = originalOutline;
        el.style.outlineOffset = originalOutlineOffset;
      }
    };
  }

  /**
   * Show a small "thinking" indicator anchored next to `el` while an LLM
   * suggestion is being requested for it. Returns `{ anchor, dismiss() }` --
   * call `dismiss()` if no preview will follow (error/no suggestion), or
   * hand `anchor` to `showFieldPreview` to reuse the same highlight/scroll
   * position instead of restarting them.
   */
  function showFieldLoading(el) {
    const anchor = createFieldAnchor(el);

    const box = document.createElement("div");
    box.id = FIELD_LOADING_ID;
    box.style.cssText = [
      "position:fixed", "top:-9999px", "left:-9999px", "visibility:hidden",
      "z-index:2147483647", "display:flex", "align-items:center", "gap:8px",
      "background:#1e293b", "color:#f8fafc", "padding:10px 14px",
      "border-radius:10px", "box-shadow:0 4px 20px rgba(0,0,0,0.35)",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      "font-size:13px"
    ].join(";");

    const spinStyle = document.createElement("style");
    spinStyle.textContent = "@keyframes __ff_spin{to{transform:rotate(360deg)}}";
    box.appendChild(spinStyle);

    const spinner = document.createElement("div");
    spinner.style.cssText =
      "width:14px;height:14px;border-radius:50%;flex:none;" +
      "border:2px solid rgba(248,250,252,0.25);border-top-color:#f8fafc;" +
      "animation:__ff_spin 0.7s linear infinite;";
    box.appendChild(spinner);

    const text = document.createElement("span");
    text.textContent = "autoForm is thinking...";
    box.appendChild(text);

    anchor.show(box);

    return {
      anchor,
      dismiss() {
        anchor.destroy();
      }
    };
  }

  /**
   * Show a brief anchored message next to `el` (e.g. "No saved answer for
   * this field") that auto-dismisses after a couple of seconds. Used for
   * feedback from the right-click context-menu actions, which have no
   * popup UI to report errors into.
   */
  function showFieldMessage(el, text, isError) {
    const anchor = createFieldAnchor(el);
    const box = document.createElement("div");
    box.style.cssText = [
      "position:fixed", "top:-9999px", "left:-9999px", "visibility:hidden",
      "z-index:2147483647", "max-width:280px",
      `background:${isError ? "#7f1d1d" : "#1e293b"}`, "color:#f8fafc", "padding:10px 14px",
      "border-radius:10px", "box-shadow:0 4px 20px rgba(0,0,0,0.35)",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      "font-size:13px"
    ].join(";");
    box.textContent = text;
    anchor.show(box);
    setTimeout(() => anchor.destroy(), 2500);
  }

  /**
   * Show an editable preview box anchored next to `el`, pre-filled with
   * `suggestedValue`. Returns a promise resolving to
   * `{ action: "accept" | "skip" | "stop", value }` -- `value` is the
   * (possibly user-edited) string, meaningful only when action is "accept".
   * The actual `applyValue` call happens inside the Accept handler so a
   * failed fuzzy-match (unmatched select/radio option) can keep the popup
   * open with an inline error instead of silently resolving as accepted.
   * Pass `existingAnchor` (e.g. from `showFieldLoading`) to reuse an
   * already-highlighted, already-scrolled-to anchor instead of a fresh one.
   */
  function showFieldPreview(el, question, suggestedValue, existingAnchor) {
    return new Promise((resolve) => {
      const anchor = existingAnchor || createFieldAnchor(el);

      const box = document.createElement("div");
      box.id = FIELD_PREVIEW_ID;
      box.style.cssText = [
        "position:fixed", "top:-9999px", "left:-9999px", "visibility:hidden",
        "z-index:2147483647", "width:300px", "max-width:calc(100vw - 16px)",
        "background:#1e293b", "color:#f8fafc", "padding:12px",
        "border-radius:10px", "box-shadow:0 4px 20px rgba(0,0,0,0.35)",
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
        "font-size:13px", "display:flex", "flex-direction:column", "gap:8px"
      ].join(";");

      const labelEl = document.createElement("div");
      labelEl.textContent = question || "Suggested answer";
      labelEl.style.cssText = "font-weight:600;overflow-wrap:break-word;";
      box.appendChild(labelEl);

      const isMultiline = fieldType(el) === "textarea";
      const input = document.createElement(isMultiline ? "textarea" : "input");
      if (!isMultiline) input.type = "text";
      input.value = suggestedValue == null ? "" : String(suggestedValue);
      input.style.cssText =
        "width:100%;box-sizing:border-box;background:#0f172a;color:#f8fafc;" +
        "border:1px solid #334155;border-radius:6px;padding:6px 8px;" +
        "font-size:13px;font-family:inherit;" +
        (isMultiline ? "min-height:56px;resize:vertical;" : "");

      const fieldOptions = optionsFor(el);
      if (fieldOptions && fieldOptions.length) {
        const datalist = document.createElement("datalist");
        datalist.id = FIELD_PREVIEW_OPTIONS_ID;
        for (const opt of fieldOptions) {
          const o = document.createElement("option");
          o.value = opt;
          datalist.appendChild(o);
        }
        box.appendChild(datalist);
        input.setAttribute("list", FIELD_PREVIEW_OPTIONS_ID);
      }
      box.appendChild(input);

      const errorLine = document.createElement("div");
      errorLine.style.cssText = "color:#f87171;font-size:12px;display:none;";
      box.appendChild(errorLine);

      const btnRow = document.createElement("div");
      btnRow.style.cssText = "display:flex;gap:8px;align-items:center;";

      const stopBtn = document.createElement("button");
      stopBtn.textContent = "Stop";
      stopBtn.style.cssText = "background:transparent;color:#94a3b8;border:none;padding:5px 8px;cursor:pointer;font-size:12px;margin-right:auto;";

      const skipBtn = document.createElement("button");
      skipBtn.textContent = "Skip";
      skipBtn.style.cssText = "background:#64748b;color:#fff;border:none;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:13px;";

      const acceptBtn = document.createElement("button");
      acceptBtn.textContent = String.fromCharCode(0x2713) + " Accept";
      acceptBtn.style.cssText = "background:#22c55e;color:#fff;border:none;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:13px;font-weight:600;";

      btnRow.append(stopBtn, skipBtn, acceptBtn);
      box.appendChild(btnRow);

      let settled = false;
      let timeoutId = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        anchor.destroy();
      };

      const settle = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      anchor.setOnDisconnected(() => settle({ action: "skip", value: null }));
      anchor.show(box);

      acceptBtn.addEventListener("click", () => {
        const value = input.value;
        window.__FF_AUTOFILLING = true;
        let ok;
        try {
          ok = applyValue(el, value);
        } finally {
          window.__FF_AUTOFILLING = false;
        }
        if (ok) {
          settle({ action: "accept", value });
        } else {
          errorLine.textContent = "Couldn't match that to one of this field's options -- edit it or Skip.";
          errorLine.style.display = "block";
        }
      });

      skipBtn.addEventListener("click", () => settle({ action: "skip", value: null }));
      stopBtn.addEventListener("click", () => settle({ action: "stop", value: null }));

      box.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          settle({ action: "skip", value: null });
        } else if (e.key === "Enter" && e.target === input && !isMultiline) {
          e.preventDefault();
          acceptBtn.click();
        }
      });

      timeoutId = setTimeout(() => settle({ action: "skip", value: null }), 30000);

      input.focus();
      input.select();
    });
  }

  /* ── LLM form detection (once per page load) ── */

  /**
   * Determine whether the current page is a fillable form relevant to any
   * saved profile. Runs at most once per page load. If both isForm and
   * relevant come back true, either enables saving immediately (auto mode)
   * or prompts the user first (manual mode, the default).
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
      if (!res.ok || !res.data || !res.data.isForm || !res.data.relevant) return;
      if (state.formDetectionMode === "auto") {
        pageAutoSave = true;
      } else {
        const accepted = await showSaveConfirmation();
        if (accepted) pageAutoSave = true;
      }
    } catch {
      // Silently fail — detection is best-effort
    }
  }

  /**
   * "Suggest with AI" pipeline — reviews every eligible empty field one at a
   * time. For each field, finds a candidate answer (an exact saved-profile
   * match first, an LLM guess otherwise), shows it in an editable preview
   * anchored to the field (see showFieldPreview above), and only fills it
   * in once the user accepts.
   */
  async function suggestAll() {
    await refreshState();
    if (!state.activeProfileId) {
      return { ok: false, error: "No active profile. Create or select one in the autoForm popup." };
    }
    const profile = await getProfile(state.activeProfileId);
    if (!profile) return { ok: false, error: "Active profile could not be loaded." };

    const fields = visibleEligibleFields();
    let accepted = 0;
    let skipped = 0;
    let anyShown = false;

    for (const el of fields) {
      if (!el.isConnected || !isEligible(el)) continue;
      if (hasExistingValue(el) || isTouched(el)) continue;

      const label = fieldQuestion(el);
      const labelKey = normalizeKey(label);
      const nameKey = normalizeKey(el.getAttribute("name") || el.id);
      const key = labelKey || nameKey;
      const question = label || humanize(nameKey);

      const profileAnswer = matchAnswer(profile, labelKey, nameKey);
      let value;
      let source;
      let loadingAnchor = null;

      if (profileAnswer) {
        value = profileAnswer.value;
        source = "profile";
      } else {
        const loading = showFieldLoading(el);
        loadingAnchor = loading.anchor;
        const res = await sendMsg({
          type: "suggestAnswers",
          profileId: state.activeProfileId,
          fields: [{ key, question, fieldType: fieldType(el), options: optionsFor(el) }]
        });
        const item = res.ok && res.data ? res.data[0] : null;
        const errMsg = !res.ok ? res.error : (item && item.error) || null;
        if (errMsg) {
          loading.dismiss();
          // No connection / broken LLM before anything was shown — fail fast with one clear error
          // instead of silently walking through every remaining field showing nothing.
          if (!anyShown) return { ok: false, error: errMsg };
          continue; // isolated failure after a working run — skip this field only
        }
        if (!item || item.suggested == null) {
          loading.dismiss();
          continue; // no suggestion available — skip silently
        }
        value = item.suggested;
        source = "llm";
      }

      if (!el.isConnected) {
        // Field vanished (SPA re-render) while its LLM suggestion was loading
        if (loadingAnchor) loadingAnchor.destroy();
        continue;
      }

      anyShown = true;
      const result = await showFieldPreview(el, question, value, loadingAnchor);
      if (result.action === "stop") break;
      if (result.action === "skip") {
        skipped++;
        continue;
      }

      markTouched(el);
      accepted++;
      if (key) {
        pending.set(key, { key, value: result.value, source, question: question || null });
        scheduleFlush();
      }
    }

    return {
      ok: true,
      accepted,
      skipped,
      message: !anyShown
        ? "No unanswered fields found on this page."
        : `Accepted ${accepted}, skipped ${skipped}.`
    };
  }

  /**
   * Handle a "Suggest AI answer" / "Prefill from profile" right-click on a
   * single field (see the "contextmenu" listener and background.js's
   * context-menu setup). `useAI` true always asks the LLM; false looks up
   * an exact saved-profile match only (no LLM call). Either way the result
   * goes through the same editable, anchored preview as "Suggest with AI",
   * unlike that bulk flow this bypasses the already-filled/already-touched
   * checks, since the user explicitly targeted this one field.
   */
  async function suggestForContextField(useAI) {
    const el = lastContextMenuTarget;
    if (!el || !el.isConnected || !isEligible(el)) {
      return { ok: false, error: "No eligible field was right-clicked." };
    }

    await refreshState();
    if (!state.activeProfileId) {
      return { ok: false, error: "No active profile. Create or select one in the autoForm popup." };
    }
    const profile = await getProfile(state.activeProfileId);
    if (!profile) return { ok: false, error: "Active profile could not be loaded." };

    const label = fieldQuestion(el);
    const labelKey = normalizeKey(label);
    const nameKey = normalizeKey(el.getAttribute("name") || el.id);
    const key = labelKey || nameKey;
    const question = label || humanize(nameKey);

    let value;
    let source;
    let loadingAnchor = null;

    if (!useAI) {
      const profileAnswer = matchAnswer(profile, labelKey, nameKey);
      if (!profileAnswer) {
        showFieldMessage(el, "No saved answer found for this field.", true);
        return { ok: false, error: "No saved answer found for this field." };
      }
      value = profileAnswer.value;
      source = "profile";
    } else {
      const loading = showFieldLoading(el);
      loadingAnchor = loading.anchor;
      const res = await sendMsg({
        type: "suggestAnswers",
        profileId: state.activeProfileId,
        fields: [{ key, question, fieldType: fieldType(el), options: optionsFor(el) }]
      });
      const item = res.ok && res.data ? res.data[0] : null;
      const errMsg = !res.ok ? res.error : (item && item.error) || null;
      if (errMsg) {
        loading.dismiss();
        showFieldMessage(el, errMsg, true);
        return { ok: false, error: errMsg };
      }
      if (!item || item.suggested == null) {
        loading.dismiss();
        showFieldMessage(el, "The AI didn't return a suggestion for this field.", true);
        return { ok: false, error: "No suggestion returned." };
      }
      value = item.suggested;
      source = "llm";
    }

    if (!el.isConnected) {
      if (loadingAnchor) loadingAnchor.destroy();
      return { ok: false, error: "The field is no longer on the page." };
    }

    const result = await showFieldPreview(el, question, value, loadingAnchor);
    if (result.action === "accept") {
      markTouched(el);
      if (key) {
        pending.set(key, { key, value: result.value, source, question: question || null });
        scheduleFlush();
      }
    }
    return { ok: true, action: result.action };
  }

  /* ── Message listener (receives commands from popup) ── */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only handle this extension's own FF_-prefixed commands -- chrome.runtime
    // broadcasts (e.g. the offscreen sign-in bridge, see background.js) reach
    // every tab's content script too, and must not get a response from here.
    if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("FF_")) return false;
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
        case "FF_CONTEXT_SUGGEST":
          return suggestForContextField(!!msg.useAI);
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
    state.formDetectionMode = next.formDetectionMode === "auto" ? "auto" : "manual";
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

  // Track the right-clicked element so the "Suggest AI answer"/"Prefill"
  // context-menu items (background.js) know which field to act on --
  // chrome.contextMenus.onClicked never hands back a DOM reference itself.
  document.addEventListener("contextmenu", (e) => { lastContextMenuTarget = e.target; }, true);

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
