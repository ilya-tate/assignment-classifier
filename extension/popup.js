const status = document.querySelector('#status');
const list = document.querySelector('#assignments');
const buttons = [...document.querySelectorAll('button')];
function render(data) {
  list.replaceChildren();
  for (const a of [...data].sort((a,b) => (a.dueAt || '9999').localeCompare(b.dueAt || '9999'))) {
    const card = document.createElement('article');
    if (a.startAt && new Date(a.startAt) < new Date()) card.className = 'late';
    const title = document.createElement('h2'); title.textContent = `${a.course} · ${a.title}`;
    const details = document.createElement('p');
    details.textContent = `${a.estimatedMinutes} min (${a.provider}) · Due: ${a.dueAt ? new Date(a.dueAt).toLocaleString() : 'No deadline'} · Start by: ${a.startAt ? new Date(a.startAt).toLocaleString() : 'Choose a date'}`;
    const reason = document.createElement('small'); reason.textContent = a.reason;
    card.append(title, details, reason); list.append(card);
  }
}
async function run(work) {
  buttons.forEach(b => b.disabled = true); status.textContent = 'Working…';
  try { await work(); } catch(e) { status.textContent = e.message; }
  finally { buttons.forEach(b => b.disabled = false); }
}
async function estimate(assignments) {
  const response = await chrome.runtime.sendMessage({type:'ESTIMATE', assignments});
  if (!response?.ok) throw new Error(response?.error || 'Server unavailable');
  await chrome.storage.local.set({assignments: response.assignments});
  render(response.assignments); status.textContent = `${response.assignments.length} assignments · Estimates are approximate; start times include a 25% buffer and do not resolve overlaps.`;
}
document.querySelector('#sync').onclick = () => run(async () => {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  const [{result}] = await chrome.scripting.executeScript({target:{tabId:tab.id},func:collectCanvasAssignments});
  if (!result?.ok) throw new Error(result?.error || 'Unable to read Canvas');
  await estimate(result.assignments);
});
document.querySelector('#demo').onclick = () => run(() => estimate([
  {id:'demo:1',title:'Research essay',course:'Writing',description:'Write a 1500 word essay with citations.',dueAt:new Date(Date.now()+86400000).toISOString(),points:100,submissionTypes:['online_upload']},
  {id:'demo:2',title:'Weekly quiz',course:'Biology',description:'Review notes and complete ten questions.',dueAt:new Date(Date.now()+172800000).toISOString(),points:10,submissionTypes:['online_quiz']}
]));
document.querySelector('#clear').onclick = () => run(async () => {await chrome.storage.local.clear();render([]);status.textContent='Local data cleared.';});
chrome.storage.local.get('assignments').then(({assignments=[]}) => render(assignments));
