/**
 * shared/matching.js
 *
 * Pure text-normalisation and answer-matching utilities shared between
 * content-script.js (field scanning) and background.js (answer storage
 * keys). Extracted so the logic is defined once and is unit-testable
 * without a DOM.
 *
 * Loaded as a plain content-script file (see manifest.json) and via
 * importScripts in the service worker. Exports `FFMatching` on `globalThis`.
 */
(function (root) {
  "use strict";

  /** Common filler words removed when building a token set for matching */
  var STOPWORDS = new Set(
    "what is are your the a an please enter of to for in on and or at by with do does did how many have has where when why which who i me my we our they their this that it its form field select option choose all any other type".split(" ")
  );

  /** Lowercase, strip non-alphanumeric, collapse whitespace → underscores */
  function normalizeKey(input) {
    return String(input || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, "_");
  }

  /** Trim trailing colons/whitespace and collapse internal whitespace */
  function cleanText(s) {
    return String(s || "").replace(/[:\s]+$/g, "").replace(/\s+/g, " ").trim();
  }

  /** Convert camelCase / snake_case / kebab-case to human-readable sentence case */
  function humanize(s) {
    return String(s || "")
      .replace(/[_-]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Build a normalised token set for a key, filtering out stopwords.
   * Used by `matchAnswer` for Dice-coefficient comparison.
   */
  function tokenSet(s) {
    var out = new Set();
    var parts = normalizeKey(s).split("_");
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i];
      if (t && !STOPWORDS.has(t)) out.add(t);
    }
    return out;
  }

  /** Dice coefficient (token-set similarity) between two token sets, 0..1 */
  function diceScore(a, b) {
    if (!a.size || !b.size) return 0;
    var inter = 0;
    a.forEach(function (t) {
      if (b.has(t)) inter++;
    });
    return (2 * inter) / (a.size + b.size);
  }

  /**
   * Heuristic answer matcher.
   * 1. Exact key match against saved answers.
   * 2. Dice-coefficient token similarity ≥ 0.5.
   * 3. Name-part guard: won't map "first_name" → "full_name" unless a
   *    part-name answer actually exists.
   */
  function matchAnswer(profile, labelKey, nameKey) {
    if (!profile) return null;
    var answers = profile.answers || {};
    var keys = Object.keys(answers);
    if (!keys.length) return null;
    if (labelKey && answers[labelKey]) return answers[labelKey];
    if (nameKey && answers[nameKey]) return answers[nameKey];
    var toks = tokenSet(labelKey || nameKey);
    if (!toks.size) return null;
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var kt = tokenSet(k);
      if (!kt.size) continue;
      var score = diceScore(kt, toks);
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    if (!best || bestScore < 0.5) return null;

    var NAME_PART = /(^|_)(first|last|given|middle|surname)(_|$)/;
    var fieldName = normalizeKey(labelKey || nameKey);
    var isPartNameField = NAME_PART.test(fieldName);
    var isFullName = /(^|_)(full|complete|legal)(_|$)/.test(best) && /(^|_)(name|names)(_|$)/.test(best);
    var hasPartNameAnswer = keys.some(function (k) {
      return NAME_PART.test(k);
    });
    if (isPartNameField && isFullName && !hasPartNameAnswer) return null;

    return answers[best];
  }

  root.FFMatching = {
    normalizeKey: normalizeKey,
    cleanText: cleanText,
    humanize: humanize,
    tokenSet: tokenSet,
    diceScore: diceScore,
    matchAnswer: matchAnswer
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
