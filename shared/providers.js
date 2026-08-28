/**
 * shared/providers.js
 *
 * Single source of truth for LLM provider presets.
 * Loaded by background.js (service worker) and options.html (settings page).
 * Provides default baseUrl, model, API key hints, and temperature/maxTokens
 * for each supported provider. The options page auto-fills these when the
 * user selects a provider, and background.js uses them when creating or
 * merging connections.
 */
(function (root) {
  "use strict";

  /** Preset configuration for every supported LLM provider. */
  var PROVIDER_PRESETS = {
    "AutoForm AI": {
      baseUrl: "",
      model: "",
      apiKeyHint: "not required",
      apiKeyOptional: true,
      temperature: 0.3,
      maxTokens: 512,
      // Built-in, hosted provider: no base URL or API key to fill in — every
      // call runs through AutoForm's own Cloud Function using AutoForm's own
      // provider key, gated by the signed-in user's tier and daily quota.
      builtin: true,
      requiresSignIn: true
    },
    OpenAI: {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKeyHint: "sk-...",
      apiKeyOptional: false,
      temperature: 0.3,
      maxTokens: 256
    },
    OpenRouter: {
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openrouter/auto",
      apiKeyHint: "sk-or-...",
      apiKeyOptional: false,
      temperature: 0.3,
      maxTokens: 256
    },
    Groq: {
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
      apiKeyHint: "gsk_...",
      apiKeyOptional: false,
      temperature: 0.3,
      maxTokens: 256
    },
    "Google Gemini": {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-2.0-flash",
      apiKeyHint: "AIza...",
      apiKeyOptional: false,
      temperature: 0.3,
      maxTokens: 256
    },
    Ollama: {
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.1",
      apiKeyHint: "not required",
      apiKeyOptional: true,
      temperature: 0.3,
      maxTokens: 256
    },
    "LM Studio": {
      baseUrl: "http://localhost:1234/v1",
      model: "",
      apiKeyHint: "not required",
      apiKeyOptional: true,
      temperature: 0.3,
      maxTokens: 256
    },
    Custom: {
      baseUrl: "",
      model: "",
      apiKeyHint: "...",
      apiKeyOptional: false,
      temperature: 0.3,
      maxTokens: 256
    }
  };

  /** Return the preset for a provider name, or {} if unknown. */
  function preset(provider) {
    return PROVIDER_PRESETS[provider] || {};
  }

  /** Return true for providers that run locally and don't need an API key. */
  function isLocalProvider(provider) {
    var name = String(provider || "");
    return name === "Ollama" || name === "LM Studio";
  }

  /** Return true for AutoForm's own hosted/built-in provider. */
  function isAutoFormAIProvider(provider) {
    return !!(PROVIDER_PRESETS[provider] && PROVIDER_PRESETS[provider].builtin);
  }

  root.FFProviders = {
    PRESETS: PROVIDER_PRESETS,
    preset: preset,
    names: function () {
      return Object.keys(PROVIDER_PRESETS);
    },
    isLocalProvider: isLocalProvider,
    isAutoFormAIProvider: isAutoFormAIProvider
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
