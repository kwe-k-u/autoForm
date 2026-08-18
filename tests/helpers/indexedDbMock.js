/**
 * Minimal in-memory fake of the small IndexedDB surface shared/crypto.js
 * uses: `indexedDB.open`, `onupgradeneeded`, `objectStore.get/put`, and
 * transaction `oncomplete`. Good enough to exercise the real encrypt/decrypt
 * code path in tests without a `fake-indexeddb` dependency.
 */
function makeRequest() {
  return { onsuccess: null, onerror: null, onupgradeneeded: null, result: undefined, error: null };
}

function createFakeIndexedDB() {
  const databases = new Map(); // name -> { stores: Map(storeName -> Map(key -> value)) }

  return {
    open(name) {
      const req = makeRequest();
      queueMicrotask(() => {
        let record = databases.get(name);
        const isNew = !record;
        if (!record) {
          record = { stores: new Map() };
          databases.set(name, record);
        }

        const db = {
          objectStoreNames: { contains: (n) => record.stores.has(n) },
          createObjectStore(n) {
            record.stores.set(n, new Map());
          },
          transaction(storeNames) {
            const names = Array.isArray(storeNames) ? storeNames : [storeNames];
            const tx = {
              oncomplete: null,
              onerror: null,
              error: null,
              objectStore(n) {
                if (!names.includes(n)) throw new Error(`Store "${n}" not in transaction scope`);
                const store = record.stores.get(n);
                return {
                  get(key) {
                    const r = makeRequest();
                    queueMicrotask(() => {
                      r.result = store.get(key);
                      if (typeof r.onsuccess === "function") r.onsuccess({ target: r });
                    });
                    return r;
                  },
                  put(value, key) {
                    const r = makeRequest();
                    queueMicrotask(() => {
                      store.set(key, value);
                      r.result = key;
                      if (typeof r.onsuccess === "function") r.onsuccess({ target: r });
                    });
                    return r;
                  }
                };
              }
            };
            queueMicrotask(() => {
              queueMicrotask(() => {
                if (typeof tx.oncomplete === "function") tx.oncomplete({ target: tx });
              });
            });
            return tx;
          }
        };

        req.result = db;
        if (isNew && typeof req.onupgradeneeded === "function") req.onupgradeneeded({ target: req });
        queueMicrotask(() => {
          if (typeof req.onsuccess === "function") req.onsuccess({ target: req });
        });
      });
      return req;
    }
  };
}

module.exports = { createFakeIndexedDB };
