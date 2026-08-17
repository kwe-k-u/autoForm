/**
 * popup/popup.js
 *
 * Main popup UI controller. Rendered when the user clicks the autoForm
 * toolbar icon. Responsibilities:
 *   - Profile selector (switch, create)
 *   - Connection selector (switch)
 *   - Auto-fill toggle & auto-save-while-typing toggle
 *   - "Autofill now" button (heuristic + LLM semantic match)
 *   - "Suggest with AI" button (LLM generates answers for empty fields)
 *   - "Save this page's answers" button (snapshot current page values)
 *   - Account bar (sign in/out, plan badge)
 *
 * All page-facing commands are sent via `broadcastToTab`, which iterates
 * every frame in the active tab and delivers the message. If no content
 * script is present (tab predates extension install), it injects one
 * automatically and retries.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /** Currently active browser tab (refreshed on each popup open) */
  let currentTab = null;

  /* ── Messaging helpers ── */

  /** Send a message to background.js. Always resolves with { ok, data/error }. */
  function sendMsg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(res || { ok: false, error: "No response" });
      });
    });
  }

  /** Get the currently active tab in the current window */
  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  /** Get all frame IDs for a tab (main frame + any iframes) */
  async function frameIdsFor(tabId) {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      if (frames && frames.length) return frames.map((f) => f.frameId);
    } catch {
      /* fall through */
    }
    return [0];
  }

  /** Send a message to a specific frame within a tab */
  function sendToFrame(tabId, frameId, msg) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, msg, { frameId }, (r) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({
            ok: false,
            error: err.message,
            noReceiver: /Receiving end does not exist/.test(err.message)
          });
        } else {
          resolve(r || { ok: false, error: "No response" });
        }
      });
    });
  }

  /**
   * Inject content-script.js into a tab if it hasn't been loaded yet.
   * Used when `broadcastToTab` finds no receiver (tab predates extension).
   */
  async function ensureContentScript(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["content-script.js"]
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Broadcast a message to every frame in the current tab.
   * If no content script responds, injects one and retries.
   * Returns an error if the page is privileged (chrome://, Web Store, etc.).
   */
  async function broadcastToTab(msg) {
    if (!currentTab || currentTab.id == null) return { ok: false, error: "No active tab" };
    const frames = await frameIdsFor(currentTab.id);

    let results = [];
    for (const frameId of frames) {
      results.push(await sendToFrame(currentTab.id, frameId, msg));
    }
    let anyOk = results.some((r) => r && r.ok);

    if (!anyOk) {
      const scriptMissing = results.some((r) => r && r.noReceiver);
      if (scriptMissing) {
        // Inject content script and retry (tab was open before extension loaded)
        const injected = await ensureContentScript(currentTab.id);
        if (injected) {
          results = [];
          for (const frameId of frames) {
            results.push(await sendToFrame(currentTab.id, frameId, msg));
          }
          anyOk = results.some((r) => r && r.ok);
        }
      }
      if (!anyOk) {
        const stillMissing = results.every((r) => r && r.noReceiver);
        if (stillMissing) {
          return {
            ok: false,
            error: "autoForm can't run on this page (e.g. chrome:// pages, the Chrome Web Store, or a PDF). Try it on a regular website."
          };
        }
        return {
          ok: false,
          error: results.find((r) => r && r.error)?.error || "No content script responded."
        };
      }
    }
    return { ok: true, results };
  }

  /* ── Status bar ── */

  function setStatus(text, isError) {
    const el = $("status");
    el.textContent = text || "";
    el.className = "hint status" + (isError ? " error" : "");
  }

  /* ── Account bar ── */

  /** Render the account avatar, name, plan badge, and sign-in/out buttons */
  function renderAccount(account, plan, available) {
    const signedIn = !!(account && account.signedIn);
    const planKey = plan ? plan.key : "free";
    const badge = $("accBadge");
    badge.textContent = plan ? plan.label : "Free";
    badge.style.background = planKey === "paid" ? "#d1fae5" : "#e0e7ff";
    badge.style.color = planKey === "paid" ? "#065f46" : "#3730a3";

    const signInBtn = $("signInBtn");
    const signOutBtn = $("signOutBtn");
    if (signedIn) {
      const name = account.name || account.email || "Account";
      $("accAvatar").textContent = name.trim().charAt(0).toUpperCase() || "A";
      $("accName").textContent = name;
      $("accDetail").textContent = account.email || account.provider || "Signed in";
      signInBtn.classList.add("hidden");
      signOutBtn.classList.remove("hidden");
    } else {
      $("accAvatar").textContent = "L";
      $("accName").textContent = "Local";
      $("accDetail").textContent = available
        ? "Sign in to save on an account"
        : "Using autoForm on this device";
      signOutBtn.classList.add("hidden");
      signInBtn.classList.remove("hidden");
      signInBtn.disabled = !available;
      signInBtn.title = available
        ? "Create or sign in to your account"
        : "Sign-in isn't available (Firebase not configured)";
    }
  }

  /** Fetch the current account from background and render */
  async function loadAccount() {
    const res = await sendMsg({ type: "getAccount" });
    if (!res.ok) return;
    renderAccount(res.data.account, res.data.plan, res.data.available);
  }

  /** Open the account page in a popup window */
  function openAccountPage() {
    const url = chrome.runtime.getURL("account/account.html");
    try {
      chrome.windows.create({ url, type: "popup", width: 460, height: 660, focused: true });
    } catch {
      chrome.tabs.create({ url });
    }
  }

  /* ── Initial load ── */

  async function load() {
    currentTab = await getActiveTab();
    if (currentTab?.url) {
      try {
        $("pageHost").textContent = new URL(currentTab.url).hostname;
      } catch {
        $("pageHost").textContent = "—";
      }
    }

    const res = await sendMsg({ type: "getState" });
    if (!res.ok) {
      setStatus(res.error, true);
      return;
    }
    const state = res.data;

    // Populate profile selector
    const select = $("profileSelect");
    select.innerHTML = "";
    for (const p of state.profiles) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      select.appendChild(opt);
    }
    if (state.profiles.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No profiles yet";
      opt.disabled = true;
      select.appendChild(opt);
    } else {
      select.value = state.activeProfileId || state.profiles[0].id;
    }

    renderConnections(state);

    $("autofillToggle").checked = !!state.autofillEnabled;
    updateAnswerCount(state.profiles, state.activeProfileId);
    loadAccount();

    // Load per-page auto-save state from content script
    loadPageAutoSaveState();
  }

  /* ── Connection selector ── */

  function renderConnections(state) {
    const select = $("connectionSelect");
    select.innerHTML = "";
    for (const c of state.connections) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name + (c.provider && c.provider !== "Custom" ? ` (${c.provider})` : "");
      select.appendChild(opt);
    }
    if (state.connections.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No AI connection configured";
      opt.disabled = true;
      select.appendChild(opt);
    } else {
      select.value = state.activeConnectionId || state.connections[0].id;
    }
    $("connectionHint").textContent =
      state.connections.length === 0
        ? "Add one in Settings to use AI suggestions."
        : "Used by the ✨ Suggest button.";
  }

  /* ── Answer count display ── */

  function updateAnswerCount(profiles, activeId) {
    const p = profiles.find((x) => x.id === activeId);
    $("answerCount").textContent = p
      ? `${p.answerCount} saved answers in "${p.name}"`
      : "No profile selected";
  }

  async function refreshSummary() {
    const res = await sendMsg({ type: "getState" });
    if (res.ok) updateAnswerCount(res.data.profiles, res.data.activeProfileId);
  }

  /* ── Event listeners ── */

  // Switch active profile
  $("profileSelect").addEventListener("change", async (e) => {
    const id = e.target.value;
    if (!id) return;
    const res = await sendMsg({ type: "setActiveProfile", profileId: id });
    if (!res.ok) setStatus(res.error, true);
    else {
      setStatus("");
      await refreshSummary();
    }
  });

  // Switch active LLM connection
  $("connectionSelect").addEventListener("change", async (e) => {
    const id = e.target.value;
    if (!id) return;
    const res = await sendMsg({ type: "setActiveConnection", connectionId: id });
    if (!res.ok) setStatus(res.error, true);
    else setStatus("");
  });

  $("manageConnBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());

  $("signInBtn").addEventListener("click", openAccountPage);

  // Sign out and reset to local mode
  $("signOutBtn").addEventListener("click", async () => {
    const res = await sendMsg({ type: "signOutAccount" });
    if (!res.ok) setStatus(res.error, true);
    else {
      setStatus("Signed out.");
      loadAccount();
    }
  });

  // Create a new profile
  $("newProfileBtn").addEventListener("click", async () => {
    const name = prompt("New profile name:", "My Profile");
    if (!name) return;
    const res = await sendMsg({ type: "createProfile", name });
    if (!res.ok) {
      setStatus(res.error, true);
      return;
    }
    const opt = document.createElement("option");
    opt.value = res.data.profile.id;
    opt.textContent = res.data.profile.name;
    const select = $("profileSelect");
    select.appendChild(opt);
    select.value = res.data.profile.id;
    select.querySelectorAll("option[disabled]").forEach((o) => o.remove());
    setStatus(`Created profile "${res.data.profile.name}".`);
    await refreshSummary();
  });

  // Auto-fill toggle
  $("autofillToggle").addEventListener("change", async (e) => {
    const res = await sendMsg({ type: "setAutofillEnabled", enabled: e.target.checked });
    if (!res.ok) {
      setStatus(res.error, true);
      e.target.checked = !e.target.checked;
    } else {
      setStatus("");
    }
  });

  // Per-page auto-save toggle
  $("pageAutoSaveToggle").addEventListener("change", async (e) => {
    const res = await broadcastToTab({ type: "FF_TOGGLE_PAGE_AUTOSAVE", enabled: e.target.checked });
    if (!res.ok) {
      setStatus(res.error, true);
      e.target.checked = !e.target.checked;
    } else {
      setStatus(e.target.checked ? "Answer saving enabled for this page." : "Answer saving disabled for this page.");
    }
  });

  /** Query the content script for the current per-page auto-save state */
  async function loadPageAutoSaveState() {
    const res = await broadcastToTab({ type: "FF_GET_PAGE_AUTOSAVE" });
    if (res.ok && res.results) {
      const mainResult = res.results.find((r) => r && r.ok);
      if (mainResult) {
        $("pageAutoSaveToggle").checked = !!mainResult.pageAutoSave;
      }
    }
  }

  /* ── Page action buttons ── */

  /**
   * Generic helper for page-action buttons (autofill, suggest, capture).
   * Disables the button, sends the message, shows the result in the status bar.
   */
  async function runPageAction(btn, msg, successText) {
    btn.disabled = true;
    setStatus("Working…");
    const res = await broadcastToTab(msg);
    if (!res.ok) {
      setStatus(res.error, true);
    } else {
      let extra = "";
      if (msg.type === "FF_SUGGEST") {
        const ok = res.results.filter((r) => r && r.ok);
        const counts = ok.map((r) => `${r.count ?? 0}+${r.autofilled ?? 0}`).join(", ");
        extra = ok.length ? ` (${counts})` : "";
      } else if (msg.type === "FF_AUTOFILL") {
        const ok = res.results.filter((r) => r && r.ok);
        const total = ok.reduce((n, r) => n + (r.count ?? 0), 0);
        extra = ` (${total} filled)`;
      }
      setStatus(successText + extra);
    }
    btn.disabled = false;
  }

  // "Autofill now" — heuristic + LLM semantic match
  $("autofillNowBtn").addEventListener("click", () => {
    runPageAction($("autofillNowBtn"), { type: "FF_AUTOFILL" }, "Autofilled");
  });

  // "Suggest with AI" — LLM generates answers for empty fields
  $("suggestBtn").addEventListener("click", () => {
    runPageAction($("suggestBtn"), { type: "FF_SUGGEST" }, "Done");
  });

  // "Save this page's answers" — snapshot current values
  $("captureBtn").addEventListener("click", () => {
    runPageAction($("captureBtn"), { type: "FF_CAPTURE" }, "Saved this page's answers.");
  });

  $("settingsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());

  /* ── Bootstrap ── */
  load();
})();
