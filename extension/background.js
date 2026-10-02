chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.type !== 'ESTIMATE') return;
  fetch('http://localhost:8787/api/estimate', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({assignments: message.assignments}),
    signal: AbortSignal.timeout(60000)
  }).then(async response => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Inference request failed');
    reply({ok: true, ...data});
  }).catch(error => reply({ok: false, error: error.message}));
  return true;
});
