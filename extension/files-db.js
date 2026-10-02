// Persistent document storage (PDF, DOCX, ...) in the extension's IndexedDB.
// Each Canvas file is stored once, keyed by Canvas host and file ID, with the list of assignments that link to it.
// Records live until Clear data or extension removal; they are never sent to the server.
const DB_NAME = 'assignment-files', STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Version 1 stored one copy per assignment; drop it so files are re-saved once each on the next sync.
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE, {keyPath: 'key'}).createIndex('assignmentIds', 'assignmentIds', {multiEntry: true});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function withStore(mode, work) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      let result;
      work(transaction.objectStore(STORE), value => { result = value; });
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
const read = (store, request, done) => { request.onsuccess = () => done(request.result); };
// Adds an owner {assignmentId, course, assignment} to a record's link lists if it is not there yet.
function withOwner(record, owner) {
  if (record.assignmentIds.includes(owner.assignmentId)) return record;
  return {...record, assignmentIds: [...record.assignmentIds, owner.assignmentId], assignments: [...record.assignments, owner]};
}

// record: {key, fileId, name, contentType, version, size, savedAt, blob}. Existing links survive a newer version.
export const saveFile = (record, owner) => withStore('readwrite', (store, done) => read(store, store.get(record.key), existing => {
  const links = existing ? {assignmentIds: existing.assignmentIds, assignments: existing.assignments} : {assignmentIds: [], assignments: []};
  store.put(withOwner({...record, ...links}, owner));
  done();
}));
// Links an already-stored file to another assignment. Returns false if the file is not stored.
export const linkFile = (key, owner) => withStore('readwrite', (store, done) => read(store, store.get(key), existing => {
  if (existing) store.put(withOwner(existing, owner));
  done(Boolean(existing));
}));
export const getFile = key => withStore('readonly', (store, done) => read(store, store.get(key), done));
export const filesFor = assignmentId => withStore('readonly', (store, done) => read(store, store.index('assignmentIds').getAll(assignmentId), done));
export const clearFiles = () => withStore('readwrite', store => { store.clear(); });
// A file is current when the stored copy has the same Canvas version (updated_at), so re-syncs skip the download.
export async function hasCurrentFile(key, version) {
  const existing = await getFile(key);
  return Boolean(existing && existing.version === version);
}
