import {saveFile, linkFile, hasCurrentFile} from './files-db.js';

const API = 'http://localhost:8787';
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

async function callServer(path, options, timeoutMs) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {...options, signal: AbortSignal.timeout(timeoutMs)});
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error(`Local server did not answer ${path} within ${timeoutMs / 1000}s.`);
    throw new Error(`Cannot reach the local server at ${API}. Is \`npm start\` running?`);
  }
  let data;
  try { data = await response.json(); } catch { throw new Error(`Local server returned non-JSON (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error(`Server error ${response.status}: ${data.error || 'unknown error'}`);
  return data;
}

// Documents arrive from the Canvas tab as base64 because extension messages are JSON-only.
async function storeDocument({file, owner}) {
  const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('Document exceeds the size limit');
  const {data, ...meta} = file;
  await saveFile({...meta, size: bytes.length, savedAt: new Date().toISOString(), blob: new Blob([bytes], {type: file.contentType || 'application/octet-stream'})}, owner);
  return {};
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  let work;
  if (message.type === 'HEALTH') work = callServer('/health', {}, 5000);
  else if (message.type === 'ESTIMATE') work = callServer('/api/estimate', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({assignments: message.assignments})
  }, 60000);
  else if (message.type === 'SYNC_REPORT') work = callServer('/api/sync-report', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({report: message.report})
  }, 10000);
  else if (message.type === 'FILE_HAS') work = hasCurrentFile(message.key, message.version).then(has => ({has}));
  else if (message.type === 'FILE_SAVE') work = storeDocument(message);
  else if (message.type === 'FILE_LINK') work = linkFile(message.key, message.owner).then(linked => ({linked}));
  else return;
  work.then(data => reply({ok: true, ...data})).catch(error => {
    console.error(`[${message.type}]`, error.message);
    reply({ok: false, error: error.message});
  });
  return true;
});
