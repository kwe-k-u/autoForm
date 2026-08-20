/**
 * background.js — MV3 Service Worker
 *
 * Central message hub for autoForm. Manages:
 *   - Persistent state in chrome.storage.local (profiles, connections, settings)
 *   - CRUD for profiles and their saved answer maps
 *   - CRUD for LLM connections (provider presets, API keys, models)
 *   - LLM API calls (suggest answers, semantic matching, connection test)
 *   - Account/plan tracking (local mode or Firebase-backed)
 *
 * All inbound messages arrive via chrome.runtime.onMessage and are dispatched
 * through `handleMessage`. Every handler returns a plain object; the listener
 * wraps it in `{ ok: true, data }` or `{ ok: false, error }`.
 */

/* ── Storage keys ── */
const STORAGE_KEY = "formauto";       // Main state bucket (profiles, connections, etc.)
const ACCOUNT_KEY = "formautoAccount"; // Signed-in account object

/* ── Shared modules (loaded via importScripts in service worker context) ── */
const _importScripts = typeof importScripts === "function" ? importScripts : () => { };
_importScripts("shared/account.js");   // FFAccount: plan definitions & helpers
_importScripts("shared/providers.js"); // FFProviders: LLM provider presets
_importScripts("shared/matching.js");  // FFMatching: normalizeKey & answer matching
_importScripts("shared/crypto.js");    // FFCrypto: at-rest encryption for API keys
try {
  _importScripts("firebase-config.js"); // Optional; sets globalThis.FIREBASE_CONFIG
} catch (e) {
  globalThis.FIREBASE_CONFIG_AVAILABLE = false;
}

/* ── Account helpers ── */

/** Return the stored account, or a default local account if none exists */
function defaultAccount() {
  return { mode: "local", signedIn: false, tier: "free", planExpiresAt: null };
}

async function getAccount() {
  const data = await chrome.storage.local.get(ACCOUNT_KEY);
  const account = data[ACCOUNT_KEY] || defaultAccount();
  if (typeof FFAccount === "undefined" || !FFAccount.planFor) return defaultAccount();
  return account;
}

/** Resolve the applicable plan object for an account (Free/Paid/Local) */
function planFor(account) {
  if (typeof FFAccount !== "undefined" && FFAccount.planFor) return FFAccount.planFor(account);
  return { key: "free", label: "Free", maxProfiles: Infinity, maxAnswers: Infinity };
}

/** True only when firebase-config.js was loaded successfully */
function accountAvailable() {
  return globalThis.FIREBASE_CONFIG_AVAILABLE === true;
}

/* ── Provider / connection helpers ── */

const PROVIDER_PRESETS =
  (typeof FFProviders !== "undefined" && FFProviders.PRESETS) || {};

/** True for Ollama / LM Studio (local providers that don't need an API key) */
function isLocalProvider(provider) {
  if (typeof FFProviders !== "undefined" && FFProviders.isLocalProvider) {
    return FFProviders.isLocalProvider(provider);
  }
  return /^(Ollama|LM Studio)$/.test(String(provider || ""));
}

/* ── ID generation ── */

/** Create a prefixed unique ID (e.g. "p_abc123_def456") */
function makeId(prefix) {
  return prefix + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

/* ── Default object factories ── */

function defaultConnection() {
  return {
    id: null,
    name: "",
    provider: "Custom",
    baseUrl: "",
    apiKeyEnc: null, // { iv, data } — encrypted at rest, see shared/crypto.js
    model: "",
    temperature: 0.3,
    maxTokens: 256
  };
}

/** Encrypt a plaintext API key for storage, falling back to plaintext if FFCrypto isn't loaded */
async function encryptApiKey(plainText) {
  if (typeof FFCrypto === "undefined" || !FFCrypto.encryptApiKey) return plainText || null;
  return FFCrypto.encryptApiKey(plainText);
}

/** Decrypt a stored API key blob, falling back to a legacy plaintext field if present */
async function decryptApiKey(conn) {
  if (conn.apiKeyEnc && typeof FFCrypto !== "undefined" && FFCrypto.decryptApiKey) {
    return FFCrypto.decryptApiKey(conn.apiKeyEnc);
  }
  return conn.apiKey || "";
}

function defaultState() {
  return {
    profiles: {},              // Map of profileId → profile object
    activeProfileId: null,     // Currently selected profile
    autofillEnabled: true,     // Whether auto-triggered autofill is on
    autoSaveTyping: false,     // Whether to learn answers while user types (off by default)
    autoSaveDetection: false,  // Use LLM to auto-detect forms and enable saving per page
    formDetectionMode: "manual", // "manual" (confirm before saving) or "auto" (save immediately)
    connections: [],           // Array of LLM connection objects
    activeConnectionId: null   // Currently selected LLM connection
  };
}

/* ── State migrations ── */

/**
 * Migrate legacy state shapes to the current format.
 * Handles: `settings` → `connections[]` migration, and plaintext
 * `apiKey` → encrypted `apiKeyEnc` for any connection that still has one
 * (from before at-rest encryption was added, including connections that
 * just came through the `settings` migration above).
 * Returns true if any migration was applied.
 */
async function applyMigrations(state) {
  let changed = false;

  // Legacy: single "settings" object → first entry in connections array
  if (state.settings) {
    const s = state.settings;
    const id = makeId("c_");
    state.connections = state.connections || [];
    state.connections.push({
      id,
      name: "Default",
      provider: "Custom",
      baseUrl: s.baseUrl || "",
      apiKey: s.apiKey || "",
      model: s.model || "",
      temperature: s.temperature ?? 0.3,
      maxTokens: s.maxTokens ?? 256
    });
    state.activeConnectionId = id;
    delete state.settings;
    changed = true;
  }

  if (!Array.isArray(state.connections)) {
    state.connections = [];
    changed = true;
  }

  // Legacy: plaintext apiKey on a connection → encrypted apiKeyEnc
  for (const conn of state.connections) {
    if (conn.apiKey) {
      conn.apiKeyEnc = await encryptApiKey(conn.apiKey);
      delete conn.apiKey;
      changed = true;
    }
  }

  return changed;
}

/* ── State accessors ── */

/** Load state from storage, apply migrations, merge with defaults */
async function getState() {
  let data;
  try {
    data = await chrome.storage.local.get(STORAGE_KEY);
  } catch (e) {
    throw new Error(`Failed to load extension data: ${(e && e.message) || e}`);
  }
  const state = Object.assign(defaultState(), data[STORAGE_KEY] || {});
  if (await applyMigrations(state)) {
    await persistState(state);
  }
  return state;
}

/** Write the full state object to chrome.storage.local */
async function persistState(state) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  } catch (e) {
    throw new Error(`Failed to save extension data: ${(e && e.message) || e}`);
  }
}

/** Merge a partial patch into the current state and persist */
async function setState(patch) {
  const state = await getState();
  const next = Object.assign(state, patch);
  await persistState(next);
  return next;
}

/* ── Profile helpers ── */

function makeProfile(name) {
  const id = makeId("p_");
  const now = Date.now();
  return { id, name, createdAt: now, updatedAt: now, answers: {} };
}

function answerCount(profile) {
  return Object.keys(profile.answers || {}).length;
}

function profileSummary(profile) {
  return { id: profile.id, name: profile.name, answerCount: answerCount(profile) };
}

function connectionSummary(conn) {
  return { id: conn.id, name: conn.name, provider: conn.provider };
}

/**
 * Ensure there's a valid active profile selected.
 * Falls back to the first available profile if the current one is missing.
 */
async function ensureActiveProfile(state) {
  let active = state.activeProfileId && state.profiles[state.activeProfileId];
  if (!active) {
    const ids = Object.keys(state.profiles);
    if (ids.length > 0) {
      state.activeProfileId = ids[0];
      active = state.profiles[ids[0]];
    }
  }
  return active;
}

/** Same as above but for LLM connections */
async function ensureActiveConnection(state) {
  let active = state.connections.find((c) => c.id === state.activeConnectionId);
  if (!active && state.connections.length > 0) {
    state.activeConnectionId = state.connections[0].id;
    active = state.connections[0];
  }
  return active;
}

function getActiveConnection(state) {
  return state.connections.find((c) => c.id === state.activeConnectionId) || null;
}

/* ── Answer storage ── */

/** Normalise a key the same way the content-script does (shared/matching.js) */
function normalizeKey(input) {
  if (typeof FFMatching !== "undefined" && FFMatching.normalizeKey) return FFMatching.normalizeKey(input);
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "_");
}

/**
 * Append a site hostname to an answer's site list (max 20, FIFO).
 * Returns a new array (does not mutate the input).
 */
function appendSite(sites, site) {
  if (!site) return sites || [];
  const list = Array.isArray(sites) ? sites.slice() : [];
  if (!list.includes(site)) {
    list.push(site);
    if (list.length > 20) list.shift();
  }
  return list;
}

/**
 * Save answer pairs to a profile.
 * Handles: creation, updates, deletions (empty value), site tracking,
 * and per-plan answer limits (if the plan has a finite maxAnswers).
 */
async function saveAnswers(profileId, pairs) {
  const state = await getState();
  const profile = state.profiles[profileId];
  if (!profile) throw new Error("Profile not found");
  const account = await getAccount();
  const plan = planFor(account);

  // Enforce answer limit if the plan has a finite cap
  if (Number.isFinite(plan.maxAnswers)) {
    const existing = new Set(Object.keys(profile.answers));
    const delKeys = new Set();
    for (const p of pairs) {
      if (p.value === undefined || p.value === null || p.value === "") {
        delKeys.add(normalizeKey(p.key));
      }
    }
    const addKeys = new Set();
    for (const p of pairs) {
      const k = normalizeKey(p.key);
      if (p.value !== undefined && p.value !== null && p.value !== "" && !existing.has(k) && !delKeys.has(k)) {
        addKeys.add(k);
      }
    }
    const removedExisting = Object.keys(profile.answers).filter((k) => delKeys.has(k)).length;
    if (answerCount(profile) - removedExisting + addKeys.size > plan.maxAnswers) {
      throw new Error(
        `Free plan limit reached (${plan.maxAnswers} answers). Delete some answers or upgrade to Pro to keep saving.`
      );
    }
  }

  let changed = false;
  for (const pair of pairs) {
    const key = normalizeKey(pair.key);
    if (!key) continue;
    const value = typeof pair.value === "string" ? pair.value.trim() : pair.value;
    const site = pair.site ? String(pair.site).slice(0, 255) : null;

    // Empty value → delete the answer
    if (value === undefined || value === null || value === "") {
      delete profile.answers[key];
      changed = true;
      continue;
    }

    const existing = profile.answers[key];
    if (!existing || existing.value !== value) {
      // New or changed value → upsert
      const question = pair.question
        ? String(pair.question).trim()
        : (existing?.question || null);
      profile.answers[key] = {
        value,
        source: pair.source || existing?.source || "learned",
        updatedAt: Date.now(),
        firstSeenOn: existing?.firstSeenOn || site,
        lastSeenOn: site || existing?.lastSeenOn || null,
        sites: appendSite(existing?.sites, site)
      };
      if (question) profile.answers[key].question = question;
      changed = true;
    } else if (site && !(existing.sites || []).includes(site)) {
      // Same value but new site → just update site tracking
      existing.lastSeenOn = site;
      existing.sites = appendSite(existing.sites, site);
      changed = true;
    }
  }
  if (changed) {
    profile.updatedAt = Date.now();
    await setState(state);
  }
  return { saved: changed };
}

/** Delete a single answer by key from a profile */
async function deleteAnswer(profileId, key) {
  const state = await getState();
  const profile = state.profiles[profileId];
  if (!profile) throw new Error("Profile not found");
  delete profile.answers[normalizeKey(key)];
  profile.updatedAt = Date.now();
  await setState(state);
  return { ok: true };
}

/**
 * Delete all answers associated with a specific site.
 * If site is "unknown", deletes answers with no firstSeenOn.
 * Also removes the site from answers' site lists without deleting them.
 */
async function deleteSiteCollection(profileId, site) {
  const state = await getState();
  const profile = state.profiles[profileId];
  if (!profile) throw new Error("Profile not found");
  const target = String(site || "").toLowerCase();
  let deleted = 0;
  let changed = false;
  for (const key of Object.keys(profile.answers)) {
    const a = profile.answers[key];
    if (target === "unknown") {
      if (!a.firstSeenOn) {
        delete profile.answers[key];
        deleted++;
        changed = true;
      }
      continue;
    }
    const origin = (a.firstSeenOn || "").toLowerCase();
    if (origin === target) {
      delete profile.answers[key];
      deleted++;
      changed = true;
    } else if ((a.sites || []).some((s) => s.toLowerCase() === target)) {
      a.sites = a.sites.filter((s) => s.toLowerCase() !== target);
      changed = true;
    }
  }
  if (changed) {
    profile.updatedAt = Date.now();
    await setState(state);
  }
  return { ok: true, deleted };
}

async function listProfiles() {
  const state = await getState();
  await ensureActiveProfile(state);
  return {
    profiles: Object.values(state.profiles).map(profileSummary),
    activeProfileId: state.activeProfileId,
    autofillEnabled: state.autofillEnabled
  };
}

/** Return a deep clone of a profile (never expose the live reference) */
async function getProfile(id) {
  const state = await getState();
  const profile = state.profiles[id];
  if (!profile) throw new Error("Profile not found");
  return JSON.parse(JSON.stringify(profile));
}

/* ── LLM prompt builders ── */

/**
 * Build the system prompt that gives the LLM context about the user's
 * saved answers (up to 60 key-value pairs).
 */
function buildSystemPrompt(profile) {
  const lines = Object.entries(profile.answers || {})
    .map(([k, a]) => `- ${normalizeKey(k)}: ${JSON.stringify(String(a.value))}`)
    .slice(0, 60);
  return [
    "You are an application assistant that helps users fill out forms quickly",
    "You will be provided with a list of questions and corresponding answers that the user has previously filled on other applications",
    "If you don't have enough information for a field do not provide an answer, especially for questions where the answer requires fact. Eg: Age, Date of birth, GPA, Salary expectations",
    "Profile answers:",
    lines.length ? lines.join("\n") : "(none yet)"
  ].join("\n");
}

/**
 * Build a per-field user prompt for one-by-one LLM calls.
 * Instructs the LLM to return only the answer value, nothing else.
 */
function buildAnswerPrompt(question, fieldType, options) {
  const parts = [`The form question/label is: "${question}".`, `Field type: ${fieldType}.`];
  if (options && options.length) {
    const optList = options.map((o) => `- ${JSON.stringify(o)}`).join("\n");
    parts.push("The field must be one of the following allowed values:", optList);
  }
  parts.push(
    "Instructions:",
    "1. If the profile answers contain a matching answer, return exactly that value.",
    "2. If an allowed list is given, pick the best single option value and return it verbatim.",
    "3. Do not provide an answer if you genuinely cannot infer a value.",
    "4. Reply with ONLY the value. No quotes, no explanations, no markdown, no JSON."
  );
  return parts.join("\n");
}

/* ── LLM API caller ── */

/**
 * Send a chat-completion request to the active LLM connection.
 * Handles: URL normalisation, auth headers (skipped for local providers
 * without a key), error parsing, and Ollama 403 guidance.
 */
async function callLLM(messages) {
  const state = await getState();
  const conn = getActiveConnection(state);
  if (!conn) {
    throw new Error("No AI connection configured. Add one in Settings.");
  }
  const apiKey = await decryptApiKey(conn);
  if (!apiKey && !isLocalProvider(conn.provider)) {
    throw new Error(`No API key for "${conn.name}". Add it in Settings.`);
  }
  let url = (conn.baseUrl || "").trim().replace(/\/+$/, "");
  if (!url) throw new Error(`"${conn.name}" has no base URL set.`);
  if (!/\/chat\/completions$/.test(url)) url += "/chat/completions";

  const headers = { "Content-Type": "application/json" };
  // Only attach Authorization header when an API key is present
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: conn.model,
      messages,
      temperature: conn.temperature,
      max_tokens: conn.maxTokens
    })
  });

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.text();
      try {
        const err = JSON.parse(body);
        detail = err.error?.message || JSON.stringify(err);
      } catch {
        detail = body || res.statusText || "";
      }
    } catch {
      detail = res.statusText || "";
    }
    // Special case: Ollama/LM Studio returning 403 due to Origin header blocking
    if (res.status === 403 && isLocalProvider(conn.provider)) {
      throw new Error(
        `LLM request failed (403): ${conn.provider} is blocking requests from browser extensions. ` +
        `Set the OLLAMA_ORIGINS environment variable to "*" and restart ${conn.provider}. ` +
        `On Windows: setx OLLAMA_ORIGINS "*"  then restart the app. (${detail})`
      );
    }
    throw new Error(`LLM request failed (${res.status}): ${detail}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("LLM returned no content");
  return text.trim();
}

/* ── LLM features ── */

/**
 * Batch suggest answers for multiple form fields via a single LLM call.
 * Falls back to one-by-one calls if the batch response is unparseable.
 * Returns an array of { suggested, error } objects aligned with the input.
 */
async function suggestAnswers(profileId, fields) {
  const state = await getState();
  const profile = state.profiles[profileId];
  if (!profile) throw new Error("Profile not found");
  if (!fields || fields.length === 0) return [];

  const system = buildSystemPrompt(profile);
  const user = [
    "Answer the following form fields. Respond as a JSON object where each key is the field identifier and the value is the answer string.",
    "Example: {\"field_1\": \"John Doe\", \"field_2\": \"male\"}",
    "Return ONLY the JSON object.",
    "",
    ...fields.map((f, i) => {
      const id = `field_${i}`;
      const q = f.question || f.key || "(no label)";
      let line = `"${id}": question="${q}", type=${f.fieldType || "text"}`;
      if (f.options && f.options.length) line += `, allowed=[${f.options.join(", ")}]`;
      return line;
    })
  ].join("\n");

  let raw;
  try {
    raw = await callLLM([{ role: "system", content: system }, { role: "user", content: user }]);
  } catch (e) {
    // Batch failed — fall back to individual calls with simpler prompts
    const results = [];
    for (const f of fields) {
      try {
        const answer = await callLLM([
          { role: "system", content: system },
          {
            role: "user",
            content: buildAnswerPrompt(f.question || f.key, f.fieldType || "text", f.options)
          }
        ]);
        results.push({ ...f, suggested: answer });
      } catch (err) {
        results.push({ ...f, error: err.message });
      }
    }
    return results;
  }

  // Parse the batch JSON response (handle markdown code fences)
  let parsed;
  try {
    const cleaned = raw.replace(/```json\s*/i, "").replace(/```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error("LLM returned an unparseable response");
  }

  return fields.map((f, i) => {
    const value = parsed[`field_${i}`];
    if (value === undefined) return { ...f, error: "No suggestion returned for this field" };
    return { ...f, suggested: String(value).trim() };
  });
}

/**
 * Semantic answer matching via LLM.
 * Sends the user's saved answer inventory + current page questions to the LLM,
 * which maps each question to a saved-answer index (or null if none fit).
 * The LLM never invents values — it only selects from the saved list.
 */
async function matchSavedAnswers(profileId, fields) {
  const state = await getState();
  const profile = state.profiles[profileId];
  if (!profile) throw new Error("Profile not found");
  if (!fields || fields.length === 0) return [];
  const answers = profile.answers || {};
  const keys = Object.keys(answers);
  if (!keys.length) return fields.map(() => ({ answerKey: null }));

  // Build a numbered inventory of saved answers (max 80 to stay within context limits)
  const inventory = keys.slice(0, 80).map((k, i) => {
    const a = answers[k];
    const label = (a.question && String(a.question).trim()) || k;
    return { id: i, label, value: String(a.value) };
  });
  const byId = new Map(inventory.map((a) => [a.id, a]));

  const system = [
    "You help fill web forms by matching the current questions to a user's previously saved answers.",
    "Only choose answers from the provided saved list — never invent a value.",
    "Match by meaning, not just wording (e.g. \"Full legal name\" matches \"What is your full name?\").",
    "If no saved answer fits a question, return null for it.",
    "Reply with ONLY a JSON object mapping each question index to a saved-answer index or null, e.g. {\"0\":2,\"1\":null}."
  ].join("\n");

  const user = [
    "Saved answers:",
    ...inventory.map((a) => `  ${a.id}: ${a.label} -> ${a.value}`),
    "",
    "Questions:",
    ...fields.map((f, i) => `  ${i}: ${f.question || f.key || "(untitled field)"}`)
  ].join("\n");

  let raw;
  try {
    raw = await callLLM([{ role: "system", content: system }, { role: "user", content: user }]);
  } catch (e) {
    return fields.map(() => ({ error: e.message }));
  }

  let parsed;
  try {
    const cleaned = raw.replace(/```json\s*/i, "").replace(/```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return fields.map(() => ({ error: "LLM returned an unparseable response" }));
  }

  return fields.map((f, i) => {
    const id = parsed[String(i)];
    if (id == null || !byId.has(id)) return { answerKey: null };
    const a = byId.get(id);
    return { answerKey: keys[a.id], label: a.label, value: a.value };
  });
}

/** Send a minimal "Say OK" prompt to verify the LLM connection works */
async function testLLMConnection() {
  const messages = [
    { role: "system", content: "Reply with exactly: OK" },
    { role: "user", content: "Say OK" }
  ];
  const text = await callLLM(messages);
  return { ok: true, reply: text };
}

/* ── LLM form detection (runs once per hostname per session) ── */

const _formDetectionCache = new Map();

/** Minimum number of fields that must map to a profile's saved answers */
const RELEVANCE_MIN_MATCHES = 2;
/** Minimum fraction of collected fields that must map to a profile's saved answers */
const RELEVANCE_MIN_RATIO = 0.25;

/**
 * Score how well a single profile's saved answers explain a page's field
 * labels, using the same Dice-token matching FFMatching.matchAnswer uses
 * for individual fields (shared/matching.js). A profile with no saved
 * answers can never match.
 */
function scoreProfileRelevance(profile, fieldLabels) {
  const answers = (profile && profile.answers) || {};
  const keys = Object.keys(answers);
  if (!keys.length || !fieldLabels.length) return { score: 0, matches: 0 };
  const keyTokenSets = keys.map((k) => FFMatching.tokenSet(k));
  let matches = 0;
  for (const label of fieldLabels) {
    const labelToks = FFMatching.tokenSet(label);
    if (!labelToks.size) continue;
    let best = 0;
    for (const kt of keyTokenSets) {
      if (!kt.size) continue;
      const s = FFMatching.diceScore(kt, labelToks);
      if (s > best) best = s;
    }
    if (best >= 0.5) matches++;
  }
  return { score: matches / fieldLabels.length, matches };
}

/**
 * Determine whether a page's field labels are relevant to ANY of the
 * user's profiles (cheap local heuristic — no LLM call). Returns the
 * single best-matching profile, if any clears both thresholds.
 */
function checkFormRelevance(fieldLabels, profiles) {
  let best = { profileId: null, score: 0, matches: 0 };
  for (const profile of profiles) {
    const r = scoreProfileRelevance(profile, fieldLabels);
    if (r.matches > best.matches || (r.matches === best.matches && r.score > best.score)) {
      best = { profileId: profile.id, score: r.score, matches: r.matches };
    }
  }
  const relevant = best.matches >= RELEVANCE_MIN_MATCHES && best.score >= RELEVANCE_MIN_RATIO;
  return { relevant, matchedProfileId: relevant ? best.profileId : null };
}

/**
 * Use the LLM to determine if a page is a fillable form (application,
 * registration, survey, checkout, etc.), and separately (via a local
 * heuristic, not the LLM) whether it's relevant to any saved profile.
 * The "isForm" result is cached per hostname so the LLM is only called
 * once per site per browser session; relevance is always recomputed since
 * saved profile answers can change between calls.
 */
async function detectFormPage(url, title, fieldLabels) {
  let hostname = "";
  try { hostname = new URL(url).hostname; } catch { hostname = url; }
  const state = await getState();
  const relevance = checkFormRelevance(fieldLabels || [], Object.values(state.profiles));

  if (_formDetectionCache.has(hostname)) {
    return { isForm: _formDetectionCache.get(hostname), ...relevance };
  }
  // No LLM connection → skip detection, default to not a form
  if (!getActiveConnection(state)) {
    _formDetectionCache.set(hostname, false);
    return { isForm: false, ...relevance };
  }

  const labels = (fieldLabels || []).slice(0, 25).join(", ");
  const system = [
    "You are a page classifier. Determine if the given web page is an application form,",
    "job application, survey, registration form, sign-up form, or checkout page that a",
    "user would want to auto-fill with personal information.",
    "Reply with ONLY 'true' or 'false'."
  ].join("\n");

  const user = [
    `URL: ${url}`,
    `Title: ${title}`,
    `Field labels: ${labels || "(none detected)"}`,
    "",
    "Is this a fillable form or application?",
    "Examples of true: job applications, registration forms, surveys, contact forms, checkout pages.",
    "Examples of false: blog posts, documentation, dashboards, search results, settings pages, articles.",
    "Reply with ONLY 'true' or 'false'."
  ].join("\n");

  try {
    const reply = await callLLM([
      { role: "system", content: system },
      { role: "user", content: user }
    ]);
    const isForm = /\btrue\b/i.test(reply) && !/\bfalse\b/i.test(reply);
    _formDetectionCache.set(hostname, isForm);
    return { isForm, ...relevance };
  } catch {
    _formDetectionCache.set(hostname, false);
    return { isForm: false, ...relevance };
  }
}

/* ── Connection management ── */

/**
 * Merge user input with an existing connection, applying provider preset
 * defaults when the provider changes or fields are left blank.
 *
 * `input.apiKey`, if present and non-empty, is encrypted into `apiKeyEnc`.
 * If `input.apiKey` is omitted (the UI leaves the field blank to mean
 * "keep the current key"), the existing `apiKeyEnc` is left untouched.
 * A raw `apiKey` field is never copied onto the merged connection.
 */
async function mergeConnection(base, input) {
  const preset = PROVIDER_PRESETS[input.provider] || {};
  const { apiKey, ...rest } = input;
  const c = Object.assign({}, base, rest);
  delete c.apiKey;
  if (apiKey) c.apiKeyEnc = await encryptApiKey(apiKey);
  if (input.provider && input.provider !== base.provider && !input.baseUrl) {
    c.baseUrl = preset.baseUrl || "";
  }
  if (!c.model && preset.model) c.model = preset.model;
  if (typeof c.temperature !== "number") c.temperature = preset.temperature ?? 0.3;
  if (typeof c.maxTokens !== "number") c.maxTokens = preset.maxTokens ?? 256;
  return c;
}

/* ── Message router ── */

/**
 * Central message handler. Every message type maps to a handler that
 * returns a plain data object. Errors are caught by the listener wrapper.
 */
async function handleMessage(msg) {
  switch (msg.type) {

    /* ── State & settings ── */

    case "getState": {
      const state = await getState();
      await ensureActiveProfile(state);
      await ensureActiveConnection(state);
      return {
        activeProfileId: state.activeProfileId,
        autofillEnabled: state.autofillEnabled,
        autoSaveTyping: state.autoSaveTyping !== false,
        autoSaveDetection: state.autoSaveDetection === true,
        formDetectionMode: state.formDetectionMode === "auto" ? "auto" : "manual",
        profiles: Object.values(state.profiles).map(profileSummary),
        connections: state.connections.map(connectionSummary),
        activeConnectionId: state.activeConnectionId
      };
    }

    case "setAutofillEnabled": {
      const state = await getState();
      state.autofillEnabled = !!msg.enabled;
      await setState(state);
      return { ok: true };
    }

    case "setAutoSaveTyping": {
      const state = await getState();
      state.autoSaveTyping = !!msg.enabled;
      await setState(state);
      return { ok: true };
    }

    case "setAutoSaveDetection": {
      const state = await getState();
      state.autoSaveDetection = !!msg.enabled;
      await setState(state);
      return { ok: true };
    }

    case "setFormDetectionMode": {
      const state = await getState();
      state.formDetectionMode = msg.mode === "auto" ? "auto" : "manual";
      await setState(state);
      return { ok: true };
    }

    case "detectFormPage": {
      return detectFormPage(msg.url || "", msg.title || "", msg.fieldLabels || []);
    }

    /* ── Profile CRUD ── */

    case "listProfiles":
      return listProfiles();

    case "getProfile":
      return getProfile(msg.profileId);

    case "createProfile": {
      const state = await getState();
      const account = await getAccount();
      const plan = planFor(account);
      if (Number.isFinite(plan.maxProfiles) && Object.keys(state.profiles).length >= plan.maxProfiles) {
        throw new Error(
          `Free plan is limited to ${plan.maxProfiles} profile. Delete it or upgrade to Pro to create more.`
        );
      }
      const profile = makeProfile(String(msg.name || "New Profile"));
      state.profiles[profile.id] = profile;
      state.activeProfileId = profile.id;
      await setState(state);
      return { profile: profileSummary(profile) };
    }

    case "renameProfile": {
      const state = await getState();
      const profile = state.profiles[msg.profileId];
      if (!profile) throw new Error("Profile not found");
      profile.name = String(msg.name || profile.name);
      profile.updatedAt = Date.now();
      await setState(state);
      return { ok: true };
    }

    case "deleteProfile": {
      const state = await getState();
      delete state.profiles[msg.profileId];
      if (state.activeProfileId === msg.profileId) state.activeProfileId = null;
      await ensureActiveProfile(state);
      await setState(state);
      return { ok: true };
    }

    case "setActiveProfile": {
      const state = await getState();
      if (!state.profiles[msg.profileId]) throw new Error("Profile not found");
      state.activeProfileId = msg.profileId;
      await setState(state);
      return { ok: true };
    }

    /* ── Answer CRUD ── */

    case "saveAnswers":
      return saveAnswers(msg.profileId, msg.pairs || []);

    case "deleteAnswer":
      return deleteAnswer(msg.profileId, msg.key);

    case "deleteSiteCollection":
      return deleteSiteCollection(msg.profileId, msg.site);

    /* ── Account ── */

    case "getAccount": {
      const account = await getAccount();
      return { account, plan: planFor(account), available: accountAvailable() };
    }

    case "signOutAccount": {
      await chrome.storage.local.remove(ACCOUNT_KEY);
      return { ok: true };
    }

    /* ── LLM connection CRUD ── */

    case "listConnections": {
      const state = await getState();
      await ensureActiveConnection(state);
      return {
        connections: state.connections.map(connectionSummary),
        activeConnectionId: state.activeConnectionId
      };
    }

    case "getConnection": {
      const state = await getState();
      const conn = state.connections.find((c) => c.id === msg.connectionId);
      if (!conn) throw new Error("Connection not found");
      // Never send the encrypted key blob (or a decrypted key) back to a UI page —
      // callers only need to know whether one is set.
      const { apiKeyEnc, ...safe } = JSON.parse(JSON.stringify(conn));
      return { connection: { ...safe, hasApiKey: !!apiKeyEnc } };
    }

    case "createConnection": {
      const state = await getState();
      const provider = Object.prototype.hasOwnProperty.call(PROVIDER_PRESETS, msg.provider)
        ? msg.provider
        : "Custom";
      const preset = PROVIDER_PRESETS[provider] || {};
      const conn = Object.assign(defaultConnection(), {
        id: makeId("c_"),
        name: String(msg.name || provider || "New Connection"),
        provider,
        baseUrl: msg.baseUrl ?? preset.baseUrl,
        apiKeyEnc: msg.apiKey ? await encryptApiKey(msg.apiKey) : null,
        model: msg.model ?? preset.model,
        temperature: msg.temperature ?? preset.temperature ?? 0.3,
        maxTokens: msg.maxTokens ?? preset.maxTokens ?? 256
      });
      state.connections.push(conn);
      state.activeConnectionId = conn.id;
      await setState(state);
      return { connection: connectionSummary(conn) };
    }

    case "updateConnection": {
      const state = await getState();
      const idx = state.connections.findIndex((c) => c.id === msg.connectionId);
      if (idx === -1) throw new Error("Connection not found");
      state.connections[idx] = await mergeConnection(state.connections[idx], msg.connection || {});
      await setState(state);
      return { ok: true };
    }

    case "deleteConnection": {
      const state = await getState();
      const idx = state.connections.findIndex((c) => c.id === msg.connectionId);
      if (idx === -1) throw new Error("Connection not found");
      state.connections.splice(idx, 1);
      if (state.activeConnectionId === msg.connectionId) state.activeConnectionId = null;
      await ensureActiveConnection(state);
      await setState(state);
      return { ok: true };
    }

    case "setActiveConnection": {
      const state = await getState();
      if (!state.connections.some((c) => c.id === msg.connectionId)) {
        throw new Error("Connection not found");
      }
      state.activeConnectionId = msg.connectionId;
      await setState(state);
      return { ok: true };
    }

    /* ── LLM features ── */

    case "suggestAnswers":
      return suggestAnswers(msg.profileId, msg.fields || []);

    case "matchSavedAnswers":
      return matchSavedAnswers(msg.profileId, msg.fields || []);

    case "testLLM":
      return testLLMConnection();

    default:
      throw new Error("Unknown message type: " + msg.type);
  }
}

/* ── Message listener ── */

/**
 * Catch-all listener. Delegates to handleMessage and wraps the result
 * in the standard `{ ok: true/false, data/error }` envelope.
 * `return true` keeps the message channel open for the async response.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg)
    .then((result) => sendResponse({ ok: true, data: result }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});

/* ── Right-click context menu: "Suggest AI answer" / "Prefill" on form fields ── */

const CONTEXT_MENU_SUGGEST_ID = "ff-suggest-ai";
const CONTEXT_MENU_PREFILL_ID = "ff-prefill";

// (Re)create the menu items on install/update so edits to their titles take effect.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_SUGGEST_ID,
      title: "Suggest AI answer",
      contexts: ["editable"]
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_PREFILL_ID,
      title: "Prefill from profile",
      contexts: ["editable"]
    });
  });
});

/**
 * Forward a context-menu click to the content script of the exact tab/frame
 * that was right-clicked. The content script tracks which field triggered
 * the native context menu (see its "contextmenu" listener) and applies the
 * suggestion there. `chrome.tabs.sendMessage` fails with no receiver on
 * pages without a content script (e.g. chrome:// pages) — ignored, since
 * the field couldn't have been eligible there anyway.
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId !== CONTEXT_MENU_SUGGEST_ID && info.menuItemId !== CONTEXT_MENU_PREFILL_ID) return;
  chrome.tabs.sendMessage(
    tab.id,
    { type: "FF_CONTEXT_SUGGEST", useAI: info.menuItemId === CONTEXT_MENU_SUGGEST_ID },
    { frameId: info.frameId },
    () => { void chrome.runtime.lastError; }
  );
});

/* ── Test hook ──
 * `module` only exists under Node/Jest, never in the service worker, so this
 * has no effect on the running extension — it just lets the test suite
 * reach the otherwise-private functions above. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    getState,
    setState,
    persistState,
    saveAnswers,
    deleteAnswer,
    deleteSiteCollection,
    applyMigrations,
    mergeConnection,
    defaultConnection,
    defaultState,
    appendSite,
    makeId,
    normalizeKey,
    handleMessage,
    encryptApiKey,
    decryptApiKey,
    scoreProfileRelevance,
    checkFormRelevance
  };
}
