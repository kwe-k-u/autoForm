/**
 * account/account.js
 *
 * Account management page. Opened in a popup window from the popup or options.
 * Provides:
 *   - Google sign-in (via Firebase Auth)
 *   - Apple sign-in (via Firebase OAuth provider)
 *   - Local-only mode (no cloud account)
 *   - Sign-out (clears stored account, keeps local data)
 *   - Plan display (Free/Pro/Local with limits text)
 *
 * signInWithPopup can't complete its handshake with Google from this page's
 * chrome-extension:// origin (fails with auth/internal-error), so sign-in is
 * delegated to background.js, which bridges it through an offscreen document
 * to a hosted https:// page. See background.js's firebaseAuthSignIn() and
 * offscreen.js. This page only needs `firebase-config.js` to know whether
 * sign-in is configured at all -- it never calls the Firebase SDK directly.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const ACCOUNT_KEY = "formautoAccount";

  /* ── Firebase helpers ── */

  /** True only when firebase-config.js was loaded and has a valid apiKey */
  function firebaseAvailable() {
    return (
      typeof globalThis.FIREBASE_CONFIG !== "undefined" &&
      globalThis.FIREBASE_CONFIG_AVAILABLE !== false &&
      !!globalThis.FIREBASE_CONFIG &&
      !!globalThis.FIREBASE_CONFIG.apiKey
    );
  }

  /* ── Account persistence ── */

  async function saveAccount(account) {
    await chrome.storage.local.set({ [ACCOUNT_KEY]: account });
  }

  async function removeAccount() {
    await chrome.storage.local.remove(ACCOUNT_KEY);
  }

  /* ── Plan display ── */

  /**
   * Build a human-readable description of the user's current plan.
   * Handles both unlimited plans ("unlimited profiles and answers")
   * and finite-cap plans ("up to N profiles and M answers").
   */
  function planDetailText(account, plan) {
    if (FFAccount.isPaidActive(account)) {
      const until = new Date(account.planExpiresAt).toLocaleDateString();
      return `Pro plan active until ${until}. Unlimited profiles and answers.`;
    }
    if (!Number.isFinite(plan.maxProfiles)) {
      return `${plan.label} plan: unlimited profiles and answers.`;
    }
    const p = plan.maxProfiles;
    return `${plan.label} plan: up to ${p === 1 ? "1 profile" : p + " profiles"} and ${plan.maxAnswers} answers.`;
  }

  /* ── UI rendering ── */

  /**
   * Render the signed-in or signed-out state of the account page.
   * Shows avatar, name, email, plan badge, and appropriate buttons.
   */
  function render(account) {
    const signedIn = !!(account && account.signedIn);
    $("signedOut").classList.toggle("hidden", signedIn);
    $("signedIn").classList.toggle("hidden", !signedIn);
    if (!signedIn) return;
    $("accName").textContent = account.name || account.email || "Account";
    $("accEmail").textContent = account.email || account.uid || "";
    const avatar = $("avatar");
    if (account.photoURL) {
      avatar.src = account.photoURL;
      avatar.classList.remove("hidden");
    } else {
      avatar.classList.add("hidden");
    }
    const plan = FFAccount.planFor(account);
    $("planBadge").textContent = plan.label;
    $("planDetail").textContent = planDetailText(account, plan);
  }

  function setStatus(text, isError) {
    const el = $("authStatus");
    el.textContent = text || "";
    el.className = "status" + (isError ? " error" : "");
  }

  /* ── Sign-in flow ── */

  /**
   * Perform sign-in for "google" or "apple" by asking background.js to run
   * it through the offscreen-document bridge (see the file header comment).
   * Saves the resulting account to storage and updates the UI.
   */
  async function signIn(providerName) {
    setStatus("Signing in…");
    try {
      const res = await chrome.runtime.sendMessage({ type: "firebaseAuthSignIn", provider: providerName });
      console.log("res",res);
      if (!res || !res.ok) throw new Error((res && res.error) || "Sign-in failed.");
      const u = res.data;
      const account = FFAccount.signedInAccount(
        {
          uid: u.uid,
          email: u.email,
          displayName: u.displayName,
          photoURL: u.photoURL
        },
        { provider: providerName === "apple" ? "apple.com" : "google.com" }
      );
      await saveAccount(account);
      render(account);
      setStatus("Signed in.");
    } catch (err) {
      setStatus((err && err.message) || "Sign-in failed.", true);
    }
  }

  /* ── Setup & bootstrap ── */

  function setup() {
    const configured = firebaseAvailable();

    // If Firebase isn't configured, show the warning and disable sign-in buttons
    if (!configured) {
      $("notConfigured").classList.remove("hidden");
      $("googleBtn").disabled = true;
      $("appleBtn").disabled = true;
    }

    if (!configured) {
      $("googleBtn").addEventListener("click", () => setStatus("Sign-in isn't configured.", true));
      $("appleBtn").addEventListener("click", () => setStatus("Sign-in isn't configured.", true));
    } else {
      $("googleBtn").addEventListener("click", () => signIn("google"));
      $("appleBtn").addEventListener("click", () => signIn("apple"));
    }

    // "Use locally" — creates a local (non-signed-in) account object
    $("localBtn").addEventListener("click", async () => {
      try {
        await saveAccount(FFAccount.localAccount());
        render(FFAccount.localAccount());
        setStatus("Using autoForm locally on this device.");
      } catch (err) {
        setStatus((err && err.message) || "Failed to switch to local mode.", true);
      }
    });

    // Sign out — the sign-in session lives only briefly in the hosted auth
    // page, not in this page, so there's nothing to sign out of here beyond
    // clearing the stored account.
    $("signOutBtn").addEventListener("click", async () => {
      setStatus("Signing out…");
      try {
        await removeAccount();
        render(FFAccount.localAccount());
        setStatus("Signed out. Data stays on this device.");
      } catch (err) {
        setStatus((err && err.message) || "Failed to sign out.", true);
      }
    });

    $("closeBtn").addEventListener("click", () => window.close());
  }

  /* ── Bootstrap ── */
  (async () => {
    setup();
    try {
      const data = await chrome.storage.local.get(ACCOUNT_KEY);
      render(data[ACCOUNT_KEY] || FFAccount.localAccount());
    } catch (err) {
      render(FFAccount.localAccount());
      setStatus((err && err.message) || "Failed to load account state.", true);
    }
  })();
})();
