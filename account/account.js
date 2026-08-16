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
 * Firebase is initialised via `firebase-config.js` (auto-generated from .env).
 * The SDK is loaded as a vendored compat UMD bundle in account.html.
 *
 * NOTE: signInWithPopup requires Google Identity Services which MV3 service
 * workers cannot inject. This page runs as a full document in a popup window
 * where the script CAN load. However, if the origin block is encountered,
 * the offscreen-document pattern (not yet implemented) would be needed.
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

  /** True when the vendored Firebase SDK UMD bundles have loaded */
  function sdkLoaded() {
    return typeof firebase !== "undefined" && firebase.auth && firebase.auth.GoogleAuthProvider;
  }

  /**
   * Initialise (or retrieve) the Firebase app named "autoform".
   * Returns the app instance, or null on failure.
   */
  function initAuth() {
    if (!firebaseAvailable() || !sdkLoaded()) return null;
    try {
      return firebase.initializeApp(globalThis.FIREBASE_CONFIG, "autoform");
    } catch (e) {
      try {
        return firebase.app("autoform");
      } catch (e2) {
        return null;
      }
    }
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
   * Perform sign-in using a Firebase Auth provider (Google or Apple).
   * Opens a popup for the OAuth flow, saves the resulting account to
   * storage, and updates the UI. Errors (including auth/internal-error
   * from MV3 origin blocking) are shown in the status bar.
   */
  async function signIn(provider) {
    setStatus("Signing in…");
    try {
      const app = initAuth();
      if (!app) throw new Error("Sign-in isn't configured.");
      const cred = await firebase.auth(app).signInWithPopup(provider);
      const u = cred.user;
      const account = FFAccount.signedInAccount(
        {
          uid: u.uid,
          email: u.email,
          displayName: u.displayName,
          photoURL: u.photoURL
        },
        { provider: provider.providerId }
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

    if (!configured || !sdkLoaded()) {
      $("googleBtn").addEventListener("click", () => setStatus("Firebase SDK not loaded.", true));
      $("appleBtn").addEventListener("click", () => setStatus("Firebase SDK not loaded.", true));
    } else {
      $("googleBtn").addEventListener("click", () =>
        signIn(new firebase.auth.GoogleAuthProvider())
      );
      $("appleBtn").addEventListener("click", () =>
        signIn(new firebase.auth.OAuthProvider("apple.com"))
      );
    }

    // "Use locally" — creates a local (non-signed-in) account object
    $("localBtn").addEventListener("click", async () => {
      await saveAccount(FFAccount.localAccount());
      render(FFAccount.localAccount());
      setStatus("Using autoForm locally on this device.");
    });

    // Sign out — clears Firebase session and stored account
    $("signOutBtn").addEventListener("click", async () => {
      setStatus("Signing out…");
      const app = initAuth();
      if (app) {
        try {
          await firebase.auth(app).signOut();
        } catch {
          /* ignore sign-out errors */
        }
      }
      await removeAccount();
      render(FFAccount.localAccount());
      setStatus("Signed out. Data stays on this device.");
    });

    $("closeBtn").addEventListener("click", () => window.close());
  }

  /* ── Bootstrap ── */
  (async () => {
    setup();
    const data = await chrome.storage.local.get(ACCOUNT_KEY);
    render(data[ACCOUNT_KEY] || FFAccount.localAccount());
  })();
})();
