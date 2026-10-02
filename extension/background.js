import {saveFile, linkFile, hasCurrentFile} from './files-db.js';

import {serverSettings} from './server-settings.js';
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

async function callServer(path, options, timeoutMs) {
  const {url:API, accessKey}=serverSettings((await chrome.storage.local.get('serverSettings')).serverSettings);
  const headers={...options.headers,...(accessKey ? {Authorization:`Bearer ${accessKey}`} : {})};
  let response;
  try {
    response = await fetch(`${API}${path}`, {...options, headers, signal: AbortSignal.timeout(timeoutMs)});
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error(`Server did not answer ${path} within ${timeoutMs / 1000}s.`);
    throw new Error(`Cannot reach the server at ${API}. Check Server settings and that the server is running.`);
  }
  let data;
  try { data = await response.json(); } catch { throw new Error(`Server returned non-JSON (HTTP ${response.status}).`); }
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

// The toolbar icon is greyed out except on Canvas pages. Canvas is recognized by host name (most schools use a
// "canvas" subdomain or instructure.com), the address learned after the first sync, and the local mock Canvas.
// declarativeContent needs no host permission and matches pages without the extension reading tab URLs.
async function updateIconRules() {
  if (!chrome.declarativeContent) return;   // not available (e.g. Firefox): the icon stays enabled
  const {settings} = await chrome.storage.local.get('settings');
  const learned = (() => { try { return new URL(settings?.canvasUrl).hostname; } catch { return ''; } })();
  const {PageStateMatcher, ShowAction} = chrome.declarativeContent;
  const conditions = [
    new PageStateMatcher({pageUrl: {schemes: ['https'], hostContains: 'canvas'}}),
    new PageStateMatcher({pageUrl: {schemes: ['https'], hostSuffix: 'instructure.com'}}),
    new PageStateMatcher({pageUrl: {schemes: ['http'], hostEquals: 'localhost', ports: [8790]}}),
    new PageStateMatcher({pageUrl: {schemes: ['http'], hostEquals: '127.0.0.1', ports: [8790]}}),
    ...(learned ? [new PageStateMatcher({pageUrl: {hostEquals: learned}})] : [])
  ];
  await chrome.action.disable();
  await new Promise(resolve => chrome.declarativeContent.onPageChanged.removeRules(undefined, resolve));
  chrome.declarativeContent.onPageChanged.addRules([{conditions, actions: [new ShowAction()]}]);
}
chrome.runtime.onInstalled.addListener(updateIconRules);
chrome.runtime.onStartup.addListener(updateIconRules);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings && changes.settings.oldValue?.canvasUrl !== changes.settings.newValue?.canvasUrl) updateIconRules();
});

// Clicking the toolbar icon opens the planner as a full tab (or focuses the existing one) and hands it the tab
// the icon was clicked on. activeTab grants access to that tab, which is what Sync scrapes.
const PLANNER = chrome.runtime.getURL('popup.html');
chrome.action.onClicked.addListener(async tab => {
  const source = tab.url?.startsWith(PLANNER) ? null : {tabId: tab.id, url: tab.url || ''};
  // Stored in session storage because service worker globals do not survive suspension.
  const {plannerTabId} = await chrome.storage.session.get('plannerTabId');
  const existing = plannerTabId && await chrome.tabs.get(plannerTabId).catch(() => null);
  if (existing?.url?.startsWith(PLANNER)) {
    await chrome.tabs.update(existing.id, {active: true});
    await chrome.windows.update(existing.windowId, {focused: true});
    // The planner syncs on every icon click; source is the clicked tab (null when clicked on the planner itself).
    chrome.runtime.sendMessage({type: 'ICON_CLICKED', source}).catch(() => {});
    return;
  }
  const query = `?opened=1${source ? `&source=${source.tabId}&url=${encodeURIComponent(source.url)}` : ''}`;
  const created = await chrome.tabs.create({url: `${PLANNER}${query}`, index: tab.index + 1});
  await chrome.storage.session.set({plannerTabId: created.id});
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  let work;
  if (message.type === 'HEALTH') work = callServer('/health', {}, 5000);
  else if (message.type === 'INFERENCE_START') work = callServer('/api/estimate-jobs', {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assignments:message.assignments})
  },10000);
  else if (['INFERENCE_POLL','INFERENCE_CANCEL'].includes(message.type)) {
    if(!/^[a-f0-9-]{36}$/.test(message.jobId || '')) {reply({ok:false,error:'Invalid inference job'});return;}
    work=callServer(`/api/estimate-jobs/${message.jobId}`,{method:message.type==='INFERENCE_CANCEL' ? 'DELETE' : 'GET'},10000);
  }
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
