const { createFakeIndexedDB } = require("./helpers/indexedDbMock");

global.indexedDB = createFakeIndexedDB();
require("../shared/crypto.js");

const { encryptApiKey, decryptApiKey } = global.FFCrypto;

test("encryptApiKey returns null for empty input", async () => {
  expect(await encryptApiKey("")).toBeNull();
  expect(await encryptApiKey(null)).toBeNull();
  expect(await encryptApiKey(undefined)).toBeNull();
});

test("decryptApiKey returns '' for empty/missing input", async () => {
  expect(await decryptApiKey(null)).toBe("");
  expect(await decryptApiKey(undefined)).toBe("");
  expect(await decryptApiKey({})).toBe("");
});

test("round-trips a plaintext API key through encrypt then decrypt", async () => {
  const enc = await encryptApiKey("sk-test-1234567890");
  expect(enc).toEqual({ iv: expect.any(String), data: expect.any(String) });
  expect(await decryptApiKey(enc)).toBe("sk-test-1234567890");
});

test("the encrypted blob never contains the plaintext key", async () => {
  const enc = await encryptApiKey("sk-super-secret-value");
  expect(enc.data).not.toContain("sk-super-secret-value");
  expect(JSON.stringify(enc)).not.toContain("sk-super-secret-value");
});

test("two encryptions of the same key produce different ciphertext (random IV)", async () => {
  const a = await encryptApiKey("sk-same-key");
  const b = await encryptApiKey("sk-same-key");
  expect(a.iv).not.toBe(b.iv);
  expect(a.data).not.toBe(b.data);
  expect(await decryptApiKey(a)).toBe("sk-same-key");
  expect(await decryptApiKey(b)).toBe("sk-same-key");
});

test("decryptApiKey resolves to '' (never throws) for tampered ciphertext", async () => {
  const enc = await encryptApiKey("sk-original");
  const tampered = { iv: enc.iv, data: Buffer.from("not-real-ciphertext-bytes!!").toString("base64") };
  await expect(decryptApiKey(tampered)).resolves.toBe("");
});
