// The latest capture's PNG, kept as a Blob in the extension's IndexedDB:
// written by the service worker, read by the editor tab (and the test
// harness). Chrome stores a large Blob on disk, so a capture of several
// hundred MB travels without a copy in memory; the manifest's
// unlimitedStorage covers the quota. Each capture replaces the last.

(function (root) {
  const DB = 'captures', STORE = 'png', KEY = 'latest';

  function open() {
    return new Promise((resolve, reject) => {
      const q = indexedDB.open(DB, 1);
      q.onupgradeneeded = () => q.result.createObjectStore(STORE);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  }

  async function run(mode, fn) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
      });
    } finally {
      db.close();
    }
  }

  root.CaptureStore = {
    put: (blob) => run('readwrite', (s) => s.put(blob, KEY)),
    get: () => run('readonly', (s) => s.get(KEY))
  };
})(typeof self !== 'undefined' ? self : globalThis);
