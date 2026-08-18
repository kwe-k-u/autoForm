const { createChromeMock } = require("./helpers/chromeMock");
const { createFakeIndexedDB } = require("./helpers/indexedDbMock");
const { installImportScripts } = require("./helpers/importScriptsShim");

global.chrome = createChromeMock();
global.indexedDB = createFakeIndexedDB();
installImportScripts();

const background = require("../background.js");

async function seedProfile(profileId) {
  const state = await background.getState();
  state.profiles[profileId] = { id: profileId, name: "Test", createdAt: 1, updatedAt: 1, answers: {} };
  await background.persistState(state);
}

/** Temporarily force FFAccount.planFor to return a finite-limit plan */
async function withFinitePlan(maxAnswers, fn) {
  const original = global.FFAccount.planFor;
  global.FFAccount.planFor = () => ({ key: "free", label: "Free", maxProfiles: 1, maxAnswers });
  try {
    await fn();
  } finally {
    global.FFAccount.planFor = original;
  }
}

describe("saveAnswers plan-limit enforcement", () => {
  test("throws once a finite plan's answer cap would be exceeded", async () => {
    await withFinitePlan(2, async () => {
      await seedProfile("cap-1");
      await background.saveAnswers("cap-1", [
        { key: "email", value: "a@b.com" },
        { key: "name", value: "Jane" }
      ]);
      await expect(
        background.saveAnswers("cap-1", [{ key: "phone", value: "12345" }])
      ).rejects.toThrow(/Free plan limit reached/);
    });
  });

  test("updating an existing key doesn't count against the cap", async () => {
    await withFinitePlan(2, async () => {
      await seedProfile("cap-2");
      await background.saveAnswers("cap-2", [
        { key: "email", value: "a@b.com" },
        { key: "name", value: "Jane" }
      ]);
      await expect(
        background.saveAnswers("cap-2", [{ key: "email", value: "updated@b.com" }])
      ).resolves.toEqual({ saved: true });
    });
  });

  test("deleting a key (empty value) frees up room under the cap", async () => {
    await withFinitePlan(2, async () => {
      await seedProfile("cap-3");
      await background.saveAnswers("cap-3", [
        { key: "email", value: "a@b.com" },
        { key: "name", value: "Jane" }
      ]);
      await background.saveAnswers("cap-3", [{ key: "name", value: "" }]);
      await expect(
        background.saveAnswers("cap-3", [{ key: "phone", value: "12345" }])
      ).resolves.toEqual({ saved: true });
    });
  });

  test("throws for an unknown profile", async () => {
    await expect(
      background.saveAnswers("does-not-exist", [{ key: "a", value: "b" }])
    ).rejects.toThrow("Profile not found");
  });

  test("no cap is enforced under the real Infinity-limit plans", async () => {
    await seedProfile("nocap");
    const pairs = Array.from({ length: 50 }, (_, i) => ({ key: `field_${i}`, value: `v${i}` }));
    await expect(background.saveAnswers("nocap", pairs)).resolves.toEqual({ saved: true });
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
