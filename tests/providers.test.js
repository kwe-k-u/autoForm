require("../shared/providers.js");

const { PRESETS, preset, isLocalProvider, names } = global.FFProviders;

test("preset returns the known config for a provider", () => {
  expect(preset("OpenAI")).toMatchObject({
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKeyOptional: false
  });
});

test("preset returns {} for an unknown provider", () => {
  expect(preset("NotAProvider")).toEqual({});
  expect(preset(undefined)).toEqual({});
});

test("isLocalProvider is true only for Ollama and LM Studio", () => {
  expect(isLocalProvider("Ollama")).toBe(true);
  expect(isLocalProvider("LM Studio")).toBe(true);
  expect(isLocalProvider("OpenAI")).toBe(false);
  expect(isLocalProvider("")).toBe(false);
  expect(isLocalProvider(undefined)).toBe(false);
});

test("Ollama and LM Studio presets mark the API key optional", () => {
  expect(preset("Ollama").apiKeyOptional).toBe(true);
  expect(preset("LM Studio").apiKeyOptional).toBe(true);
});

test("names lists every preset key", () => {
  expect(names().sort()).toEqual(Object.keys(PRESETS).sort());
});
