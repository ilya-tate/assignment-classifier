const status = document.querySelector('#status');
const list = document.querySelector('#assignments');
const buttons = [...document.querySelectorAll('button')];
const MAX_BATCH = 100;
// Days past due an unsubmitted assignment is still synced into Catch Up. 0 skips all past-due work.
const OVERDUE_DAYS = 14;
function card(a, overdue) {
  const card = document.createElement('article');
  if (overdue || (a.startAt && new Date(a.startAt) < new Date())) card.className = 'late';
  const title = document.createElement('h3'); title.textContent = `${a.course} · ${a.title}`;
  const details = document.createElement('p');
  const due = a.dueAt ? new Date(a.dueAt).toLocaleString() : 'No deadline';
  details.textContent = overdue
    ? `${a.estimatedMinutes} min (${a.provider}) · Was due: ${due} · Start now`
    : `${a.estimatedMinutes} min (${a.provider}) · Due: ${due} · Start by: ${a.startAt ? new Date(a.startAt).toLocaleString() : 'Choose a date'}`;
  const reason = document.createElement('small'); reason.textContent = a.reason;
  card.append(title, details, reason);
  return card;
}
function section(name, items, overdue) {
  const wrapper = document.createElement('section');
  const heading = document.createElement('h2'); heading.textContent = `${name} (${items.length})`;
  wrapper.append(heading, ...items.map(a => card(a, overdue)));
  return wrapper;
}
// Categories are computed at render time so assignments move to Catch Up as their deadlines pass.
function render(data) {
  list.replaceChildren();
  const now = Date.now();
  // Catch Up shows the oldest overdue first; Upcoming shows the soonest first, then undated.
  const sorted = [...data].sort((a,b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity) || 0);
  const catchUp = sorted.filter(a => a.dueAt && Date.parse(a.dueAt) < now);
  const upcoming = sorted.filter(a => !catchUp.includes(a));
  if (catchUp.length) list.append(section('Catch Up', catchUp, true));
  if (upcoming.length) list.append(section('Upcoming', upcoming, false));
}
// Each step gets a label and a deadline so a hang reports where it happened instead of spinning forever.
async function step(label, ms, work) {
  status.textContent = `${label}…`;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${ms / 1000}s while ${label.toLowerCase()}.`)), ms); });
  try { return await Promise.race([work(), timeout]); }
  catch (error) { console.error(`[${label}]`, error); throw error.message.startsWith('Timed out') ? error : new Error(`${label} failed: ${error.message}`); }
  finally { clearTimeout(timer); }
}
async function run(work) {
  buttons.forEach(b => b.disabled = true); status.className = '';
  try { await work(); } catch(e) { status.className = 'error'; status.textContent = e.message; }
  finally { buttons.forEach(b => b.disabled = false); }
}
async function ask(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response === undefined) throw new Error('The extension service worker did not reply. Reload the extension at chrome://extensions.');
  if (!response.ok) throw new Error(response.error || 'Unknown error');
  return response;
}
async function estimate(assignments) {
  await step('Checking local server', 6000, () => ask({type:'HEALTH'}));
  if (!assignments.length) throw new Error('No unsubmitted assignments found in your active Canvas courses.');
  if (assignments.length > MAX_BATCH) throw new Error(`Found ${assignments.length} unsubmitted assignments; the server accepts at most ${MAX_BATCH}. Past-due filtering is needed.`);
  const response = await step(`Estimating ${assignments.length} assignments`, 65000, () => ask({type:'ESTIMATE', assignments}));
  await chrome.storage.local.set({assignments: response.assignments});
  render(response.assignments); status.textContent = `${response.assignments.length} assignments · Estimates are approximate; start times include a 25% buffer and do not resolve overlaps.`;
}
document.querySelector('#sync').onclick = () => run(async () => {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab?.id || !/^https:/.test(tab.url || '')) throw new Error('Switch to your signed-in Canvas tab (an https:// page) before syncing.');
  const result = await step('Reading Canvas', 120000, async () => {
    const [injection] = await chrome.scripting.executeScript({target:{tabId:tab.id},func:collectCanvasAssignments,args:[{overdueDays:OVERDUE_DAYS}]});
    if (!injection?.result) throw new Error('The Canvas tab returned nothing. Reload the Canvas page and try again.');
    if (!injection.result.ok) throw new Error(injection.result.error);
    return injection.result;
  });
  await estimate(result.assignments);
  console.info('Skipped courses:', result.skipped.endedCourseNames);
  status.textContent += ` Courses: ${result.courses.join(', ') || 'none'}. Skipped ${result.skipped.endedCourses} ended courses, ${result.skipped.completed} completed, and ${result.skipped.pastDue} more than ${OVERDUE_DAYS} days past due.`;
});
document.querySelector('#demo').onclick = () => run(() => estimate([
  {id:'demo:1',title:'Research essay',course:'Writing',description:'Write a 1500 word essay with citations.',dueAt:new Date(Date.now()+86400000).toISOString(),points:100,submissionTypes:['online_upload']},
  {id:'demo:2',title:'Weekly quiz',course:'Biology',description:'Review notes and complete ten questions.',dueAt:new Date(Date.now()+172800000).toISOString(),points:10,submissionTypes:['online_quiz']},
  {id:'demo:3',title:'Lab report',course:'Chemistry',description:'Write up the titration lab with data tables.',dueAt:new Date(Date.now()-86400000).toISOString(),points:20,submissionTypes:['online_upload']}
]));
document.querySelector('#clear').onclick = () => run(async () => {await chrome.storage.local.clear();render([]);status.textContent='Local data cleared.';});
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'CANVAS_PROGRESS' && status.textContent.startsWith('Reading Canvas')) status.textContent = `Reading Canvas… ${message.text}`;
});
chrome.storage.local.get('assignments').then(({assignments=[]}) => render(assignments));
