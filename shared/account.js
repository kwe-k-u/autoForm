/**
 * shared/account.js
 *
 * Shared account/plan logic used by background.js, popup, options, and
 * account pages. Defines the plan tiers (Free, Paid/Pro, Local) and helper
 * functions for creating local or signed-in account objects.
 *
 * Loaded via <script> in extension pages and via importScripts in the
 * service worker. Exports `FFAccount` on `globalThis`.
 */
(function (root) {
  "use strict";

  /**
   * Plan tiers. All currently unlimited — the Free/Paid/Local split exists so
   * per-plan limits (maxProfiles, maxAnswers) can be enabled later by changing
   * these values without touching the rest of the codebase.
   */
  var FREE_PLAN = { key: "free", label: "Free", maxProfiles: Infinity, maxAnswers: Infinity };
  var PAID_PLAN = { key: "paid", label: "Pro", maxProfiles: Infinity, maxAnswers: Infinity };
  var LOCAL_PLAN = { key: "local", label: "Local", maxProfiles: Infinity, maxAnswers: Infinity };

  /** Duration of a paid plan cycle (90 days in milliseconds). */
  var THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

  /** Create a default local (not signed-in) account object. */
  function localAccount() {
    return { mode: "local", signedIn: false, tier: "free", planExpiresAt: null };
  }

  /**
   * Create a signed-in account from a Firebase (or other) user object.
   * Defaults to the free tier; override via `extra` (e.g. { tier: "paid" }).
   */
  function signedInAccount(user, extra) {
    var account = {
      mode: "cloud",
      signedIn: true,
      uid: (user && user.uid) || null,
      email: (user && user.email) || null,
      name: (user && (user.displayName || user.email)) || null,
      photoURL: (user && user.photoURL) || null,
      provider: (extra && extra.provider) || null,
      tier: "free",
      planExpiresAt: null
    };
    return Object.assign(account, extra || {});
  }

  /** Return true only for signed-in accounts on an active paid plan. */
  function isPaidActive(account) {
    if (!account || !account.signedIn) return false;
    if (account.tier !== "paid") return false;
    var exp = Number(account.planExpiresAt || 0);
    return exp > Date.now();
  }

  /**
   * Return the plan object that applies to the given account.
   * Local (not signed in) → LOCAL_PLAN, active paid → PAID_PLAN, else FREE_PLAN.
   */
  function planFor(account) {
    if (!account || !account.signedIn) return LOCAL_PLAN;
    return isPaidActive(account) ? PAID_PLAN : FREE_PLAN;
  }

  root.FFAccount = {
    FREE_PLAN: FREE_PLAN,
    PAID_PLAN: PAID_PLAN,
    LOCAL_PLAN: LOCAL_PLAN,
    THREE_MONTHS_MS: THREE_MONTHS_MS,
    localAccount: localAccount,
    signedInAccount: signedInAccount,
    isPaidActive: isPaidActive,
    planFor: planFor
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
