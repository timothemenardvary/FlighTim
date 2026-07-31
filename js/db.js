const DB_NAME = 'flightim';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('flights')) {
        db.createObjectStore('flights', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllFlights() {
  return withStore('flights', 'readonly', (store) => {
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }).then((p) => p);
}

export async function putFlights(flights) {
  return withStore('flights', 'readwrite', (store) => {
    for (const f of flights) store.put(f);
  });
}

export async function clearFlights() {
  return withStore('flights', 'readwrite', (store) => store.clear());
}

export async function getFlightFileStamps() {
  // returns { filename: lastModified } stored alongside flights for change detection
  const meta = await getMeta('fileStamps');
  return meta || {};
}

export async function setFlightFileStamps(stamps) {
  await setMeta('fileStamps', stamps);
}

export async function getMeta(key) {
  return withStore('meta', 'readonly', (store) => {
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
      req.onerror = () => reject(req.error);
    });
  });
}

export async function setMeta(key, value) {
  return withStore('meta', 'readwrite', (store) => {
    store.put({ key, value });
  });
}
