// Tiny IndexedDB wrapper. Everything stays on this device.
const DB_NAME = 'story-app';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('characters')) d.createObjectStore('characters', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('chats')) {
          const chats = d.createObjectStore('chats', { keyPath: 'id' });
          chats.createIndex('charId', 'charId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const req = fn(store);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  all: (s) => run(s, 'readonly', (st) => st.getAll()),
  get: (s, id) => run(s, 'readonly', (st) => st.get(id)),
  put: (s, v) => run(s, 'readwrite', (st) => st.put(v)),
  del: (s, id) => run(s, 'readwrite', (st) => st.delete(id)),
  clear: (s) => run(s, 'readwrite', (st) => st.clear()),
  chatsFor: (charId) => run('chats', 'readonly', (st) => st.index('charId').getAll(charId))
};
