const { createChromeMock } = require("./helpers/chromeMock");
const { createFakeIndexedDB } = require("./helpers/indexedDbMock");
const { installImportScripts } = require("./helpers/importScriptsShim");

global.chrome = createChromeMock();
global.indexedDB = createFakeIndexedDB();
installImportScripts();

const background = require("../background.js");

async function seedApplication(applicationId) {
  const state = await background.getState();
  state.applications[applicationId] = { id: applicationId, name: "Test", createdAt: 1, updatedAt: 1, answers: {} };
  await background.persistState(state);
}

/** Temporarily force FFAccount.planFor to return a finite-limit plan */
async function withFinitePlan(maxAnswers, fn) {
  const original = global.FFAccount.planFor;
  global.FFAccount.planFor = () => ({ key: "free", label: "Free", maxApplications: 1, maxAnswers });
  try {
    await fn();
  } finally {
    global.FFAccount.planFor = original;
  }
}

describe("saveApplicationAnswers plan-limit enforcement", () => {
  test("throws once a finite plan's answer cap would be exceeded", async () => {
    await withFinitePlan(2, async () => {
      await seedApplication("cap-1");
      await background.saveApplicationAnswers("cap-1", [
        { key: "email", value: "a@b.com" },
        { key: "name", value: "Jane" }
      ]);
      await expect(
        background.saveApplicationAnswers("cap-1", [{ key: "phone", value: "12345" }])
      ).rejects.toThrow(/Free plan limit reached/);
    });
  });

  test("updating an existing key doesn't count against the cap", async () => {
    await withFinitePlan(2, async () => {
      await seedApplication("cap-2");
      await background.saveApplicationAnswers("cap-2", [
        { key: "email", value: "a@b.com" },
        { key: "name", value: "Jane" }
      ]);
      await expect(
        background.saveApplicationAnswers("cap-2", [{ key: "email", value: "updated@b.com" }])
      ).resolves.toEqual({ saved: true });
    });
  });

  test("deleting a key (empty value) frees up room under the cap", async () => {
    await withFinitePlan(2, async () => {
      await seedApplication("cap-3");
      await background.saveApplicationAnswers("cap-3", [
        { key: "email", value: "a@b.com" },
        { key: "name", value: "Jane" }
      ]);
      await background.saveApplicationAnswers("cap-3", [{ key: "name", value: "" }]);
      await expect(
        background.saveApplicationAnswers("cap-3", [{ key: "phone", value: "12345" }])
      ).resolves.toEqual({ saved: true });
    });
  });

  test("throws for an unknown application", async () => {
    await expect(
      background.saveApplicationAnswers("does-not-exist", [{ key: "a", value: "b" }])
    ).rejects.toThrow("Application not found");
  });

  test("no cap is enforced under the real Infinity-limit plans", async () => {
    await seedApplication("nocap");
    const pairs = Array.from({ length: 50 }, (_, i) => ({ key: `field_${i}`, value: `v${i}` }));
    await expect(background.saveApplicationAnswers("nocap", pairs)).resolves.toEqual({ saved: true });
  });
});

describe("Profile answers CRUD (shared identity answers)", () => {
  test("getUserProfile starts out empty", async () => {
    await background.persistState(background.defaultState());
    const profile = await background.handleMessage({ type: "getUserProfile" });
    expect(profile.answers).toEqual({});
  });

  test("saveProfileAnswers upserts into the shared Profile, not any Application", async () => {
    await background.persistState(background.defaultState());
    await seedApplication("app-1");
    await background.saveProfileAnswers([{ key: "full_name", value: "Jane Doe" }]);

    const profile = await background.handleMessage({ type: "getUserProfile" });
    expect(profile.answers.full_name.value).toBe("Jane Doe");

    const application = await background.handleMessage({ type: "getApplication", applicationId: "app-1" });
    expect(application.answers.full_name).toBeUndefined();
  });

  test("deleteProfileAnswer removes a single shared answer", async () => {
    await background.persistState(background.defaultState());
    await background.saveProfileAnswers([{ key: "phone", value: "555-1234" }]);
    await background.deleteProfileAnswer("phone");
    const profile = await background.handleMessage({ type: "getUserProfile" });
    expect(profile.answers.phone).toBeUndefined();
  });

  test("saveProfileAnswers respects the plan's finite maxAnswers cap", async () => {
    await withFinitePlan(1, async () => {
      await background.persistState(background.defaultState());
      await background.saveProfileAnswers([{ key: "full_name", value: "Jane Doe" }]);
      await expect(
        background.saveProfileAnswers([{ key: "phone", value: "555-1234" }])
      ).rejects.toThrow(/Free plan limit reached/);
    });
  });
});

describe("getEffectiveApplication (Profile + Application merge)", () => {
  test("an Application with no saved answer still sees the shared Profile's answer", async () => {
    await background.persistState(background.defaultState());
    await seedApplication("merge-1");
    await background.saveProfileAnswers([{ key: "email", value: "shared@example.com" }]);

    const state = await background.getState();
    const effective = background.getEffectiveApplication(state, "merge-1");
    expect(effective.answers.email.value).toBe("shared@example.com");
  });

  test("an Application-owned key wins over a same-named Profile key", async () => {
    await background.persistState(background.defaultState());
    await seedApplication("merge-2");
    await background.saveProfileAnswers([{ key: "email", value: "shared@example.com" }]);
    await background.saveApplicationAnswers("merge-2", [{ key: "email", value: "app-specific@example.com" }]);

    const state = await background.getState();
    const effective = background.getEffectiveApplication(state, "merge-2");
    expect(effective.answers.email.value).toBe("app-specific@example.com");
  });

  test("returns null for an unknown application", async () => {
    await background.persistState(background.defaultState());
    const state = await background.getState();
    expect(background.getEffectiveApplication(state, "nope")).toBeNull();
  });
});

describe("appendSite", () => {
  test("adds a new site to an empty/undefined list", () => {
    expect(background.appendSite(undefined, "example.com")).toEqual(["example.com"]);
  });

  test("does not duplicate an already-tracked site", () => {
    expect(background.appendSite(["a.com", "b.com"], "a.com")).toEqual(["a.com", "b.com"]);
  });

  test("caps the list at 20 entries, dropping the oldest (FIFO)", () => {
    const sites = Array.from({ length: 20 }, (_, i) => `site${i}.com`);
    const result = background.appendSite(sites, "new.com");
    expect(result).toHaveLength(20);
    expect(result[0]).toBe("site1.com"); // site0.com was evicted
    expect(result[result.length - 1]).toBe("new.com");
  });

  test("returns the list unchanged when no site is given", () => {
    expect(background.appendSite(["a.com"], null)).toEqual(["a.com"]);
    expect(background.appendSite(undefined, null)).toEqual([]);
  });
});

describe("applyMigrations", () => {
  test("migrates a legacy `settings` object into a connections[] entry", async () => {
    const state = {
      settings: { baseUrl: "http://x", apiKey: "", model: "gpt", temperature: 0.5, maxTokens: 100 }
    };
    const changed = await background.applyMigrations(state);
    expect(changed).toBe(true);
    expect(state.settings).toBeUndefined();
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]).toMatchObject({ name: "Default", baseUrl: "http://x", model: "gpt" });
    expect(state.activeConnectionId).toBe(state.connections[0].id);
  });

  test("migrates a legacy `settings` object with a real apiKey straight to apiKeyEnc", async () => {
    const state = {
      settings: { baseUrl: "http://x", apiKey: "sk-old-secret", model: "gpt", temperature: 0.5, maxTokens: 100 }
    };
    await background.applyMigrations(state);
    expect(state.connections[0].apiKey).toBeUndefined();
    expect(state.connections[0].apiKeyEnc).toEqual({ iv: expect.any(String), data: expect.any(String) });
    expect(await background.decryptApiKey(state.connections[0])).toBe("sk-old-secret");
  });

  test("encrypts a leftover plaintext apiKey found directly on a connection", async () => {
    const state = { connections: [{ id: "c1", provider: "OpenAI", apiKey: "sk-legacy-secret" }] };
    const changed = await background.applyMigrations(state);
    expect(changed).toBe(true);
    expect(state.connections[0].apiKey).toBeUndefined();
    expect(await background.decryptApiKey(state.connections[0])).toBe("sk-legacy-secret");
  });

  test("defaults a missing connections array to []", async () => {
    const state = { connections: undefined };
    const changed = await background.applyMigrations(state);
    expect(changed).toBe(true);
    expect(state.connections).toEqual([]);
  });

  test("migrates a legacy `profiles`/`activeProfileId` shape into `applications`/`activeApplicationId`", async () => {
    const state = {
      profiles: { "p1": { id: "p1", name: "Old Profile", answers: {} } },
      activeProfileId: "p1"
    };
    const changed = await background.applyMigrations(state);
    expect(changed).toBe(true);
    expect(state.profiles).toBeUndefined();
    expect(state.activeProfileId).toBeUndefined();
    expect(state.applications).toEqual({ "p1": { id: "p1", name: "Old Profile", answers: {} } });
    expect(state.activeApplicationId).toBe("p1");
  });

  test("creates an empty shared Profile when migrating legacy state that never had one", async () => {
    const state = { profiles: {}, activeProfileId: null };
    const changed = await background.applyMigrations(state);
    expect(changed).toBe(true);
    expect(state.profile).toEqual({ answers: {}, updatedAt: null });
  });

  test("is a no-op for already-current state", async () => {
    const state = background.defaultState();
    const changed = await background.applyMigrations(state);
    expect(changed).toBe(false);
  });
});

describe("mergeConnection", () => {
  test("encrypts a newly provided apiKey and never stores it in plaintext", async () => {
    const base = background.defaultConnection();
    const merged = await background.mergeConnection(base, { apiKey: "sk-new-key" });
    expect(merged.apiKey).toBeUndefined();
    expect(merged.apiKeyEnc).toEqual({ iv: expect.any(String), data: expect.any(String) });
    expect(await background.decryptApiKey(merged)).toBe("sk-new-key");
  });

  test("keeps the existing apiKeyEnc untouched when apiKey is omitted", async () => {
    const withKey = await background.mergeConnection(background.defaultConnection(), { apiKey: "sk-keep-me" });
    const renamed = await background.mergeConnection(withKey, { name: "Renamed" });
    expect(renamed.name).toBe("Renamed");
    expect(renamed.apiKeyEnc).toEqual(withKey.apiKeyEnc);
    expect(await background.decryptApiKey(renamed)).toBe("sk-keep-me");
  });

  test("applies provider preset defaults when the provider changes and baseUrl is blank", async () => {
    const base = background.defaultConnection();
    const merged = await background.mergeConnection(base, { provider: "OpenAI" });
    expect(merged.baseUrl).toBe("https://api.openai.com/v1");
    expect(merged.model).toBe("gpt-4o-mini");
  });

  test("does not override an explicitly provided baseUrl with the preset default", async () => {
    const base = background.defaultConnection();
    const merged = await background.mergeConnection(base, { provider: "OpenAI", baseUrl: "https://custom.example/v1" });
    expect(merged.baseUrl).toBe("https://custom.example/v1");
  });
});

describe("connection CRUD via handleMessage (end-to-end apiKey masking)", () => {
  test("createConnection encrypts the apiKey; it's never echoed back by getConnection", async () => {
    const created = await background.handleMessage({
      type: "createConnection",
      provider: "OpenAI",
      name: "My OpenAI",
      apiKey: "sk-abc123"
    });
    expect(created.connection.apiKey).toBeUndefined();
    expect(created.connection.apiKeyEnc).toBeUndefined();

    const fetched = await background.handleMessage({ type: "getConnection", connectionId: created.connection.id });
    expect(fetched.connection.apiKey).toBeUndefined();
    expect(fetched.connection.apiKeyEnc).toBeUndefined();
    expect(fetched.connection.hasApiKey).toBe(true);
  });

  test("a connection created with no apiKey reports hasApiKey: false", async () => {
    const created = await background.handleMessage({ type: "createConnection", provider: "Ollama", name: "Local" });
    const fetched = await background.handleMessage({ type: "getConnection", connectionId: created.connection.id });
    expect(fetched.connection.hasApiKey).toBe(false);
  });

  test("updateConnection with a blank apiKey keeps the previously saved key", async () => {
    const created = await background.handleMessage({
      type: "createConnection",
      provider: "Custom",
      name: "Keep me",
      apiKey: "sk-original"
    });
    const id = created.connection.id;

    await background.handleMessage({
      type: "updateConnection",
      connectionId: id,
      connection: {
        name: "Renamed",
        provider: "Custom",
        baseUrl: "http://x",
        model: "m",
        temperature: 0.3,
        maxTokens: 100
        // no apiKey field — simulates the options.js UI leaving it blank
      }
    });

    const fetched = await background.handleMessage({ type: "getConnection", connectionId: id });
    expect(fetched.connection.name).toBe("Renamed");
    expect(fetched.connection.hasApiKey).toBe(true);
  });

  test("updateConnection with a new apiKey replaces the stored key", async () => {
    const created = await background.handleMessage({
      type: "createConnection",
      provider: "Custom",
      name: "Rotate me",
      apiKey: "sk-first"
    });
    const id = created.connection.id;

    await background.handleMessage({
      type: "updateConnection",
      connectionId: id,
      connection: { name: "Rotate me", provider: "Custom", baseUrl: "http://x", model: "m", temperature: 0.3, maxTokens: 100, apiKey: "sk-second" }
    });

    const state = await background.getState();
    const conn = state.connections.find((c) => c.id === id);
    expect(await background.decryptApiKey(conn)).toBe("sk-second");
  });
});

describe("testLLM uses unsaved form values (regression: pasted key ignored until Save)", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("a freshly-typed apiKey that was never saved is sent, not rejected as missing", async () => {
    const created = await background.handleMessage({
      type: "createConnection",
      provider: "OpenAI",
      name: "OpenAI"
      // no apiKey — matches newConnBtn's blank connection before the user types a key
    });
    let sentAuth;
    global.fetch = jest.fn(async (url, opts) => {
      sentAuth = opts.headers.Authorization;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "OK" } }] }) };
    });

    const res = await background.handleMessage({
      type: "testLLM",
      connection: {
        name: "OpenAI",
        provider: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        temperature: 0.3,
        maxTokens: 256,
        apiKey: "sk-just-pasted" // typed into the form, never sent via updateConnection
      }
    });

    expect(res.ok).toBe(true);
    expect(sentAuth).toBe("Bearer sk-just-pasted");
    // still never persisted in plaintext
    const fetched = await background.handleMessage({ type: "getConnection", connectionId: created.connection.id });
    expect(fetched.connection.hasApiKey).toBe(false);
  });

  test("without connection.apiKey in the request, testLLM falls back to the saved key", async () => {
    const created = await background.handleMessage({
      type: "createConnection",
      provider: "OpenAI",
      name: "OpenAI",
      apiKey: "sk-already-saved"
    });
    let sentAuth;
    global.fetch = jest.fn(async (url, opts) => {
      sentAuth = opts.headers.Authorization;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "OK" } }] }) };
    });

    await background.handleMessage({ type: "setActiveConnection", connectionId: created.connection.id });
    const res = await background.handleMessage({
      type: "testLLM",
      connection: {
        name: "OpenAI",
        provider: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        temperature: 0.3,
        maxTokens: 256
        // no apiKey field — form was left blank, meaning "use the saved key"
      }
    });

    expect(res.ok).toBe(true);
    expect(sentAuth).toBe("Bearer sk-already-saved");
  });
});

describe("inferFieldQuestion (LLM fallback question retrieval)", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("returns null immediately when no HTML snippet was collected", async () => {
    const result = await background.inferFieldQuestion("", { tag: "input" });
    expect(result).toEqual({ question: null });
  });

  test("returns the LLM's guess, trimmed, when a connection is configured", async () => {
    await background.handleMessage({
      type: "createConnection",
      provider: "OpenAI",
      name: "OpenAI",
      apiKey: "sk-test"
    });
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "  What is your phone number?  " } }] })
    }));

    const result = await background.inferFieldQuestion("<div>Phone</div>", {
      tag: "input",
      type: "tel",
      name: "phone1"
    });
    expect(result).toEqual({ question: "What is your phone number?" });
  });

  test("returns null when the LLM replies UNKNOWN", async () => {
    await background.handleMessage({
      type: "createConnection",
      provider: "OpenAI",
      name: "OpenAI",
      apiKey: "sk-test"
    });
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "UNKNOWN" } }] })
    }));

    const result = await background.inferFieldQuestion("<div></div>", { tag: "input" });
    expect(result).toEqual({ question: null });
  });

  test("fails silently (question: null) when no LLM connection is configured", async () => {
    // Fresh state with no connections at all
    await background.persistState(background.defaultState());
    const result = await background.inferFieldQuestion("<div>x</div>", { tag: "input" });
    expect(result).toEqual({ question: null });
  });
});

describe("suggestMaxRetries setting (Suggest with AI retry count)", () => {
  test("defaults to 3 when never set", async () => {
    await background.persistState(background.defaultState());
    const got = await background.handleMessage({ type: "getState" });
    expect(got.suggestMaxRetries).toBe(3);
  });

  test("setSuggestMaxRetries persists and clamps to [1, 10]", async () => {
    await background.handleMessage({ type: "setSuggestMaxRetries", value: 5 });
    expect((await background.handleMessage({ type: "getState" })).suggestMaxRetries).toBe(5);

    await background.handleMessage({ type: "setSuggestMaxRetries", value: 99 });
    expect((await background.handleMessage({ type: "getState" })).suggestMaxRetries).toBe(10);

    await background.handleMessage({ type: "setSuggestMaxRetries", value: 0 });
    expect((await background.handleMessage({ type: "getState" })).suggestMaxRetries).toBe(1);

    await background.handleMessage({ type: "setSuggestMaxRetries", value: "not a number" });
    expect((await background.handleMessage({ type: "getState" })).suggestMaxRetries).toBe(3);
  });
});

describe("suggestAnswers marks a malformed LLM response as retryable", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("throws with retryable:true when the batch reply isn't valid JSON (regression: retry-on-bad-format)", async () => {
    await seedApplication("retry-app");
    await background.handleMessage({
      type: "createConnection",
      provider: "OpenAI",
      name: "OpenAI",
      apiKey: "sk-test"
    });
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "sorry, I can't help with that" } }] })
    }));

    let caught;
    try {
      await background.handleMessage({
        type: "suggestAnswers",
        applicationId: "retry-app",
        fields: [{ key: "name", question: "What is your name?", fieldType: "text" }]
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.retryable).toBe(true);
  });

  test("a well-formed retry succeeds after a malformed first attempt", async () => {
    await seedApplication("retry-app-2");
    await background.handleMessage({
      type: "createConnection",
      provider: "OpenAI",
      name: "OpenAI",
      apiKey: "sk-test"
    });
    const responses = [
      { ok: true, json: async () => ({ choices: [{ message: { content: "not json" } }] }) },
      {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"field_0":"Jane Doe"}' } }] })
      }
    ];
    global.fetch = jest.fn(async () => responses.shift());

    await expect(
      background.handleMessage({
        type: "suggestAnswers",
        applicationId: "retry-app-2",
        fields: [{ key: "name", question: "What is your name?", fieldType: "text" }]
      })
    ).rejects.toThrow();

    const result = await background.handleMessage({
      type: "suggestAnswers",
      applicationId: "retry-app-2",
      fields: [{ key: "name", question: "What is your name?", fieldType: "text" }]
    });
    expect(result[0].suggested).toBe("Jane Doe");
  });

  test("sees the shared Profile's answers merged in, not just the Application's own", async () => {
    await background.persistState(background.defaultState());
    await seedApplication("retry-app-3");
    await background.saveProfileAnswers([{ key: "name", value: "Jane Doe" }]);
    await background.handleMessage({
      type: "createConnection",
      provider: "OpenAI",
      name: "OpenAI",
      apiKey: "sk-test"
    });
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"field_0":"ignored"}' } }] })
    }));

    await background.handleMessage({
      type: "suggestAnswers",
      applicationId: "retry-app-3",
      fields: [{ key: "name", question: "What is your name?", fieldType: "text" }]
    });

    const [, opts] = global.fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    const systemMessage = body.messages.find((m) => m.role === "system").content;
    expect(systemMessage).toContain("Jane Doe");
  });
});

describe("matchSavedAnswers sees merged Profile + Application answers", () => {
  test("matches a field against a Profile-only saved answer via an Application with no such key", async () => {
    await background.persistState(background.defaultState());
    await seedApplication("match-app");
    await background.saveProfileAnswers([{ key: "email", value: "shared@example.com", question: "Email" }]);
    await background.handleMessage({
      type: "createConnection",
      provider: "OpenAI",
      name: "OpenAI",
      apiKey: "sk-test"
    });
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"0":0}' } }] })
    }));

    const result = await background.handleMessage({
      type: "matchSavedAnswers",
      applicationId: "match-app",
      fields: [{ key: "email", question: "Email address" }]
    });
    expect(result[0].value).toBe("shared@example.com");
  });
});

describe("scoreApplicationRelevance", () => {
  const application = {
    id: "p1",
    answers: {
      email_address: { value: "a@b.com" },
      first_name: { value: "Jane" },
      phone_number: { value: "555-1234" }
    }
  };

  test("returns zero for an application with no saved answers", () => {
    expect(background.scoreApplicationRelevance({ id: "empty", answers: {} }, ["Email Address"]))
      .toEqual({ score: 0, matches: 0 });
  });

  test("returns zero for a null/undefined application", () => {
    expect(background.scoreApplicationRelevance(null, ["Email Address"])).toEqual({ score: 0, matches: 0 });
  });

  test("returns zero when there are no field labels to score", () => {
    expect(background.scoreApplicationRelevance(application, [])).toEqual({ score: 0, matches: 0 });
  });

  test("matches field labels against saved answer keys via Dice-token overlap", () => {
    const result = background.scoreApplicationRelevance(application, ["Email Address", "First Name", "Phone Number"]);
    expect(result.matches).toBe(3);
    expect(result.score).toBe(1);
  });

  test("unrelated field labels don't match", () => {
    const result = background.scoreApplicationRelevance(application, ["Favorite Color", "Comments"]);
    expect(result.matches).toBe(0);
    expect(result.score).toBe(0);
  });
});

describe("checkFormRelevance", () => {
  const applicationWithAnswers = {
    id: "match-me",
    answers: {
      email_address: { value: "a@b.com" },
      first_name: { value: "Jane" },
      last_name: { value: "Doe" }
    }
  };
  const emptyApplication = { id: "no-answers", answers: {} };
  const fieldLabels = ["Email Address", "First Name", "Last Name"];

  test("not relevant when there are no applications", () => {
    expect(background.checkFormRelevance(fieldLabels, [])).toEqual({ relevant: false, matchedApplicationId: null });
  });

  test("not relevant when no application clears the match threshold", () => {
    expect(background.checkFormRelevance(["Favorite Color", "Comments"], [applicationWithAnswers, emptyApplication]))
      .toEqual({ relevant: false, matchedApplicationId: null });
  });

  test("relevant and identifies the best-matching application among several", () => {
    expect(background.checkFormRelevance(fieldLabels, [emptyApplication, applicationWithAnswers]))
      .toEqual({ relevant: true, matchedApplicationId: "match-me" });
  });
});

describe("form detection mode setting", () => {
  test("defaults to manual, and setFormDetectionMode persists via getState", async () => {
    const initial = await background.handleMessage({ type: "getState" });
    expect(initial.formDetectionMode).toBe("manual");

    await background.handleMessage({ type: "setFormDetectionMode", mode: "auto" });
    const afterAuto = await background.handleMessage({ type: "getState" });
    expect(afterAuto.formDetectionMode).toBe("auto");

    // Anything other than "auto" coerces back to "manual"
    await background.handleMessage({ type: "setFormDetectionMode", mode: "bogus" });
    const afterBogus = await background.handleMessage({ type: "getState" });
    expect(afterBogus.formDetectionMode).toBe("manual");
  });
});
