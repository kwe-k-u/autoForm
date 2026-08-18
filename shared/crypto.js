/**
 * shared/crypto.js
 *
 * At-rest encryption for LLM connection API keys. Previously `apiKey` was
 * written straight into `chrome.storage.local` as plaintext; this module
 * encrypts it with AES-GCM before it's persisted.
 *
 * The AES key itself is a non-extractable `CryptoKey` stored in IndexedDB
 * (generated once, reused after). Because it's non-extractable, application
 * code (and anything reading the IndexedDB files on disk) can use it to
 * encrypt/decrypt but can never read out the raw key bytes — only
 * `chrome.storage.local`'s ciphertext and IndexedDB's opaque key handle
 * exist at rest, never the plaintext key.
 *
 * Loaded via importScripts in the service worker. Exports `FFCrypto` on
 * `globalThis`.
 */
(function (root) {
  "use strict";

  var DB_NAME = "autoform-secure";
  var DB_VERSION = 1;
  var STORE_NAME = "keys";
  var KEY_ID = "connectionApiKeyKey";

  /** Encode an ArrayBuffer/TypedArray as base64 */
  function bufToBase64(buf) {
    var bytes = new Uint8Array(buf);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  /** Decode a base64 string to an ArrayBuffer */
  function base64ToBuf(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error || new Error("Failed to open the key store"));
      };
    });
  }

  function idbGet(db, key) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, "readonly");
      var req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error || new Error("Key store read failed"));
      };
    });
  }

  function idbPut(db, key, value) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = function () {
        resolve();
      };
      tx.onerror = function () {
        reject(tx.error || new Error("Key store write failed"));
      };
    });
  }

  /** Memoised so repeated encrypt/decrypt calls in one worker lifetime reuse the same key */
  var _keyPromise = null;

  /** Fetch the persisted AES key, generating and storing one on first use */
  function getOrCreateKey() {
    if (_keyPromise) return _keyPromise;
    _keyPromise = (async function () {
      var db = await openDb();
      var existing = await idbGet(db, KEY_ID);
      if (existing) return existing;
      var key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt"
      ]);
      await idbPut(db, KEY_ID, key);
      return key;
    })();
    // Don't cache a rejected promise — let the next call retry.
    _keyPromise.catch(function () {
      _keyPromise = null;
    });
    return _keyPromise;
  }

  /**
   * Encrypt a plaintext API key for storage.
   * Returns null for empty input, or `{ iv, data }` (both base64) otherwise.
   */
  async function encryptApiKey(plainText) {
    if (!plainText) return null;
    var key = await getOrCreateKey();
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var encoded = new TextEncoder().encode(String(plainText));
    var cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, encoded);
    return { iv: bufToBase64(iv), data: bufToBase64(cipher) };
  }

  /**
   * Decrypt a stored `{ iv, data }` blob back into the plaintext API key.
   * Returns "" for empty/missing input or if decryption fails for any
   * reason (corrupt data, key unavailable) — callers treat "" as "no key".
   */
  async function decryptApiKey(enc) {
    if (!enc || !enc.data || !enc.iv) return "";
    try {
      var key = await getOrCreateKey();
      var iv = new Uint8Array(base64ToBuf(enc.iv));
      var plainBuf = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        key,
        base64ToBuf(enc.data)
      );
      return new TextDecoder().decode(plainBuf);
    } catch (e) {
      console.warn("[autoForm] Failed to decrypt a stored API key:", (e && e.message) || e);
      return "";
    }
  }

  root.FFCrypto = {
    encryptApiKey: encryptApiKey,
    decryptApiKey: decryptApiKey
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
