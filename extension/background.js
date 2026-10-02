const API = 'http://localhost:8787';

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

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  let work;
  if (message.type === 'HEALTH') work = callServer('/health', {}, 5000);
  else if (message.type === 'ESTIMATE') work = callServer('/api/estimate', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({assignments: message.assignments})
  }, 60000);
  else return;
  work.then(data => reply({ok: true, ...data})).catch(error => {
    console.error(`[${message.type}]`, error.message);
    reply({ok: false, error: error.message});
  });
  return true;
});
