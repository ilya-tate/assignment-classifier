import {filesFor, clearFiles} from './files-db.js';
const status = document.querySelector('#status');
// Live per-course sync progress; cleared when a sync starts and finishes.
const progressList = document.querySelector('#progress');
const courseProgress = new Map();
let lastProgressAt = 0;
function resetProgress() { courseProgress.clear(); progressList.replaceChildren(); lastProgressAt = Date.now(); }
const list = document.querySelector('#assignments');
const buttons = [...document.querySelectorAll('button')];
const MAX_BATCH = 100;
// Assignment range chosen in the popup, remembered in chrome.storage.local. daysAhead null = no upper limit.
const DAY = 86400000;
const DEFAULT_RANGE = {includeCatchUp: true, overdueDays: 14, daysAhead: null};
let range = {...DEFAULT_RANGE};
let shown = [];
const rangeInputs = {
  includeCatchUp: document.querySelector('#include-catch-up'),
  overdueDays: document.querySelector('#overdue-days'),
  daysAhead: document.querySelector('#days-ahead')
};
const days = (input, fallback) => {
  const value = Number.parseInt(input.value, 10);
  return Number.isFinite(value) && value >= 1 ? Math.min(value, 365) : fallback;
};
// Past-due work only when Catch Up is on and within overdueDays; upcoming work within daysAhead; undated always.
function inRange(a, now = Date.now()) {
  if (!a.dueAt) return true;
  const due = Date.parse(a.dueAt);
  if (due < now) return range.includeCatchUp && due >= now - range.overdueDays * DAY;
  return range.daysAhead === null || due <= now + range.daysAhead * DAY;
}
function showRange() {
  rangeInputs.includeCatchUp.checked = range.includeCatchUp;
  rangeInputs.overdueDays.value = range.overdueDays;
  rangeInputs.overdueDays.disabled = !range.includeCatchUp;
  rangeInputs.daysAhead.value = range.daysAhead ?? '';
}
async function updateRange() {
  range = {
    includeCatchUp: rangeInputs.includeCatchUp.checked,
    overdueDays: days(rangeInputs.overdueDays, DEFAULT_RANGE.overdueDays),
    daysAhead: rangeInputs.daysAhead.value.trim() === '' ? null : days(rangeInputs.daysAhead, null)
  };
  showRange();
  try { await chrome.storage.local.set({range}); } catch (error) { console.error('[Range]', error); }
  render(shown);
  document.querySelector('#range-note').textContent = 'Narrowing applies now; widening the range needs a new Sync.';
}
Object.values(rangeInputs).forEach(input => input.addEventListener('change', updateRange));
// Linked-file reading during sync. Off: files are left for the AI step to handle later.
const READ_FILES = false;
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
  card.append(title, details);
  if (a.attachments?.length) {
    const files = document.createElement('p'); files.className = 'files';
    files.textContent = `Attachments: ${a.attachments.map(f => f.name).join(', ')}`;
    card.append(files);
  }
  card.append(reason);
  showSavedFiles(card, a.id);
  return card;
}
// Saved documents load asynchronously from IndexedDB; each link downloads the stored copy.
function fileLink(file) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file.blob); link.download = file.name; link.textContent = file.name;
  return link;
}
async function showSavedFiles(card, assignmentId) {
  let saved;
  try { saved = await filesFor(assignmentId); } catch (error) { console.error('[Saved files]', error); return; }
  if (!saved.length) return;
  const line = document.createElement('p'); line.className = 'files'; line.append('Saved: ');
  saved.forEach((file, i) => line.append(...(i ? [', ', fileLink(file)] : [fileLink(file)])));
  card.querySelector('small').before(line);
}
function section(name, items, overdue) {
  const wrapper = document.createElement('section');
  const heading = document.createElement('h2'); heading.textContent = `${name} (${items.length})`;
  wrapper.append(heading, ...items.map(a => card(a, overdue)));
  return wrapper;
}
// Categories are computed at render time so assignments move to Catch Up as their deadlines pass.
function render(data) {
  shown = data;
  list.replaceChildren();
  const now = Date.now();
  // Catch Up shows the oldest overdue first; Upcoming shows the soonest first, then undated.
  const sorted = data.filter(a => inRange(a, now)).sort((a,b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity) || 0);
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
  if (assignments.length > MAX_BATCH) throw new Error(`Found ${assignments.length} unsubmitted assignments; the server accepts at most ${MAX_BATCH}. Narrow the assignment range and sync again.`);
  const response = await step(`Estimating ${assignments.length} assignments`, 65000, () => ask({type:'ESTIMATE', assignments}));
  await chrome.storage.local.set({assignments: response.assignments});
  render(response.assignments); status.textContent = `${response.assignments.length} assignments · Estimates are approximate; start times include a 25% buffer and do not resolve overlaps.`;
}
document.querySelector('#sync').onclick = () => run(async () => {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab?.id || !/^https:/.test(tab.url || '')) throw new Error('Switch to your signed-in Canvas tab (an https:// page) before syncing.');
  resetProgress();
  // Large file syncs can legitimately take a while, so fail on 2 minutes without progress rather than a short fixed limit.
  let watchdog;
  const stalled = new Promise((_, reject) => { watchdog = setInterval(() => {
    if (Date.now() - lastProgressAt > 120000) reject(new Error('Canvas sync stalled: no progress for 2 minutes. The last line in the list shows where it stopped.'));
  }, 5000); });
  const result = await step('Reading Canvas', 1800000, () => Promise.race([stalled, (async () => {
    const [injection] = await chrome.scripting.executeScript({target:{tabId:tab.id},func:collectCanvasAssignments,args:[{overdueDays:range.includeCatchUp ? range.overdueDays : 0,daysAhead:range.daysAhead,readFiles:READ_FILES}]});
    if (!injection?.result) throw new Error('The Canvas tab returned nothing. Reload the Canvas page and try again.');
    if (!injection.result.ok) throw new Error(injection.result.error);
    return injection.result;
  })()])).finally(() => clearInterval(watchdog));
  // Keep the list after a failure so it shows where sync stopped; clear it on success.
  resetProgress();
  await estimate(result.assignments);
  console.info('Skipped courses:', result.skipped.endedCourseNames);
  if (result.skipped.files.length) console.info('Skipped attachments:', result.skipped.files);
  const attached = result.assignments.reduce((n, a) => n + a.attachments.length, 0);
  document.querySelector('#range-note').textContent = '';
  const fileSummary = READ_FILES ? ` Read ${attached} attachments, saved ${result.documents.saved} new documents (${result.documents.current} already saved, linked to assignments ${result.documents.links} times), ${result.skipped.files.length} files skipped (see console).` : '';
  status.textContent += ` Courses: ${result.courses.join(', ') || 'none'}. Skipped ${result.skipped.endedCourses} ended courses, ${result.skipped.completed} completed, ${result.skipped.pastDue} ${range.includeCatchUp ? `more than ${range.overdueDays} days past due` : 'past due (Catch Up off)'}${range.daysAhead === null ? '' : `, ${result.skipped.tooFar} due more than ${range.daysAhead} days out`}.` + fileSummary;
});
document.querySelector('#demo').onclick = () => run(() => estimate([
  {id:'demo:1',title:'Research essay',course:'Writing',description:'Write a 1500 word essay with citations.',dueAt:new Date(Date.now()+86400000).toISOString(),points:100,submissionTypes:['online_upload']},
  {id:'demo:2',title:'Weekly quiz',course:'Biology',description:'Review notes and complete ten questions.',dueAt:new Date(Date.now()+172800000).toISOString(),points:10,submissionTypes:['online_quiz']},
  {id:'demo:3',title:'Lab report',course:'Chemistry',description:'Write up the titration lab with data tables.',dueAt:new Date(Date.now()-86400000).toISOString(),points:20,submissionTypes:['online_upload']}
]));
// Clears synced data and saved documents but keeps the chosen range.
document.querySelector('#clear').onclick = () => run(async () => {await chrome.storage.local.remove('assignments');await clearFiles();render([]);status.textContent='Local data and saved documents cleared.';});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type !== 'CANVAS_PROGRESS' || !status.textContent.startsWith('Reading Canvas')) return;
  lastProgressAt = Date.now();
  if (!message.course) { status.textContent = `Reading Canvas… ${message.text}`; return; }
  courseProgress.set(message.course, message.text);
  progressList.replaceChildren(...[...courseProgress].map(([course, text]) => {
    const line = document.createElement('li'); line.textContent = `${course}: ${text}`; return line;
  }));
});
chrome.storage.local.get(['assignments', 'range']).then(({assignments = [], range: saved}) => {
  range = {...DEFAULT_RANGE, ...saved};
  showRange();
  render(assignments);
});
