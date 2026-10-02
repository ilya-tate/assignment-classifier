import {serverSettings} from './server-settings.js';
const url = document.querySelector('#url'), key = document.querySelector('#key'), status = document.querySelector('#server-settings-status');
document.querySelector('#origin').textContent = `Allowed origin: chrome-extension://${chrome.runtime.id}`;
chrome.storage.local.get('serverSettings').then(({serverSettings: saved}) => {
  if (saved) {url.value=saved.url;key.value=saved.accessKey || '';}
});
document.querySelector('#settings').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const settings=serverSettings({url:url.value.trim(),accessKey:key.value});
    if (settings.url.startsWith('https:') && !await chrome.permissions.request({origins:[`${settings.url}/*`]})) throw new Error('Server permission was denied.');
    await chrome.storage.local.set({serverSettings:settings});
    status.textContent='Saved. Your next sync will use these server settings.';
  } catch (error) {status.textContent=error.message;}
});
