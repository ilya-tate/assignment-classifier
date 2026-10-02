import {filesFor, clearFiles} from './files-db.js';
import {demoAssignments} from './demo-data.js';
import {workSpan, weekDays, layoutWeek, dayOf} from './schedule.js';
import {DAY, DEFAULT_SETTINGS, halfYear, resolveWindow, isVisible, collectorOptions, priorityOf} from './range.js';
// Planner settings (date window, filters, priority, Canvas address, developer mode), remembered in chrome.storage.local.
let settings = structuredClone(DEFAULT_SETTINGS);
let syncing = false;
const status = document.querySelector('#status');
// The Canvas tab Sync reads: the tab the toolbar icon was clicked on (passed in the URL or by the service worker).
let sourceTab = null;
const hostOf = url => { try { return new URL(url).host; } catch { return ''; } };
function setSource(source) {
  sourceTab = source?.tabId ? {id: Number(source.tabId), url: source.url || ''} : null;
  showSource();
}
// Header line naming the Canvas site Sync will read.
// Time of the last successful Canvas sync (stored), shown in the header and used to label the button.
let lastSync = null;
function syncedAgo() {
  if (!lastSync) return '';
  const minutes = Math.round((Date.now() - lastSync) / 60000);
  if (minutes < 1) return 'synced just now';
  if (minutes < 60) return `synced ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `synced ${hours} h ago` : `synced ${new Date(lastSync).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})}`;
}
function showSource() {
  const known = settings.canvasUrl ? hostOf(settings.canvasUrl) : '';
  const fromTab = sourceTab && /^https?:/.test(sourceTab.url) ? hostOf(sourceTab.url) : '';
  const host = known || fromTab, ago = syncedAgo();
  document.querySelector('#source').textContent = host
    ? `Canvas: ${host}${ago ? ` · ${ago}` : ''}`
    : 'Canvas: click the CanPlan icon while on Canvas to connect, or add your Canvas address in Advanced options.';
}
// First sync happens automatically when the icon is clicked; after that the button offers a resync.
function showSyncButton() {
  const button = document.querySelector('#sync');
  // Phones get the short first-sync label; "Sync with Canvas" doesn't fit their narrower button.
  button.textContent = syncing ? 'Syncing…' : lastSync ? 'Resync' : narrow.matches ? 'Sync' : 'Sync with Canvas';
}
const narrow = matchMedia('(max-width: 640px)');
narrow.addEventListener('change', () => showSyncButton());
setInterval(showSource, 60000);
{
  const params = new URLSearchParams(location.search);
  setSource(params.get('source') ? {tabId: params.get('source'), url: params.get('url')} : null);
}
// Live per-course sync progress; cleared when a sync starts and finishes.
const progressList = document.querySelector('#progress');
const courseProgress = new Map();
let lastProgressAt = 0;
function resetProgress() { courseProgress.clear(); progressList.replaceChildren(); lastProgressAt = Date.now(); }
// Bottleneck report for the current sync: phase durations and a timestamped progress timeline, saved by the server.
let phases = [], timeline = [], syncStartedAt = 0, readingCanvas = false;
let inferenceJobId=null, lastCanvasDiagnostics=null;
const canvasRequests=[];
const list = document.querySelector('#assignments');
const buttons = [...document.querySelectorAll('#sync, #demo, #clear')];
const MAX_BATCH = 100;
let shown = [];
const $ = selector => document.querySelector(selector);
const inputs = {
  half: $('#preset-half'), custom: $('#preset-custom'), from: $('#range-from'), to: $('#range-to'),
  includeLate: $('#include-late'), includeUndated: $('#include-undated'), hideZero: $('#hide-zero'),
  urgentDays: $('#urgent-days'), devMode: $('#dev-mode'), readFiles: $('#read-files'),
  dailyHours: $('#daily-hours'), weekStart: $('#week-start'), canvasUrl: $('#canvas-url')
};
// Canvas origin from a typed address ('canvas.school.edu' or a full URL); '' when it isn't a usable address.
function canvasOrigin(text) {
  const value = (text || '').trim();
  if (!value) return '';
  try {
    const url = new URL(/^https?:\/\//.test(value) ? value : `https://${value}`);
    const loopback = url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
    return url.protocol === 'https:' || loopback ? url.origin : '';
  } catch { return ''; }
}
const shortDate = text => new Date(`${text}T00:00`).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
// Copies settings into the controls and refreshes everything that depends on them.
function showSettings() {
  const win = resolveWindow(settings);
  inputs.half.checked = settings.preset !== 'custom';
  inputs.custom.checked = settings.preset === 'custom';
  inputs.from.value = win.from; inputs.to.value = win.to;
  inputs.from.disabled = inputs.to.disabled = settings.preset !== 'custom';
  $('#half-label').textContent = `(${halfYear().label})`;
  inputs.includeLate.checked = settings.includeLate;
  inputs.includeUndated.checked = settings.includeUndated;
  inputs.hideZero.checked = settings.hideZeroPoint;
  inputs.urgentDays.value = String(settings.urgentDays);
  inputs.devMode.checked = settings.devMode;
  inputs.readFiles.checked = settings.readFiles;
  inputs.dailyHours.value = String(settings.dailyHours);
  inputs.weekStart.value = String(settings.weekStart);
  if (document.activeElement !== inputs.canvasUrl) inputs.canvasUrl.value = settings.canvasUrl;
  showSource();
  $('#week-view').hidden = settings.view !== 'week';
  $('#list-view').hidden = settings.view === 'week';
  $('#view-week').setAttribute('aria-pressed', String(settings.view === 'week'));
  $('#view-list').setAttribute('aria-pressed', String(settings.view !== 'week'));
  $('#dev-tools').hidden = !settings.devMode;
  $('#window-summary').textContent = `Showing ${shortDate(win.from)} – ${shortDate(win.to)}${settings.includeLate ? ', including late work' : ', late work hidden'}. Change this in Advanced options.`;
  if (settings.devMode) refreshServerInfo();
}
async function saveSettings() {
  try { await chrome.storage.local.set({settings}); } catch (error) { console.error('[Settings]', error); }
  showSettings();
  render(shown);
}
function readControls() {
  settings = {...settings,
    preset: inputs.custom.checked ? 'custom' : 'half-year',
    from: inputs.custom.checked ? inputs.from.value || settings.from : settings.from,
    to: inputs.custom.checked ? inputs.to.value || settings.to : settings.to,
    includeLate: inputs.includeLate.checked, includeUndated: inputs.includeUndated.checked, hideZeroPoint: inputs.hideZero.checked,
    urgentDays: Number(inputs.urgentDays.value), devMode: inputs.devMode.checked, readFiles: inputs.readFiles.checked,
    dailyHours: Number(inputs.dailyHours.value), weekStart: Number(inputs.weekStart.value),
    canvasUrl: canvasOrigin(inputs.canvasUrl.value) || (inputs.canvasUrl.value.trim() ? settings.canvasUrl : '')};
  // Switching to custom starts from the current half-year so the date fields are never empty.
  if (settings.preset === 'custom' && (!settings.from || !settings.to)) ({from: settings.from, to: settings.to} = halfYear());
  saveSettings();
}
Object.values(inputs).forEach(input => input.addEventListener('change', readControls));
$('#reset-options').onclick = () => { settings = structuredClone(DEFAULT_SETTINGS); saveSettings(); };
// Course checkboxes are built from the synced assignments; unchecked courses are hidden from the list.
function renderCourseFilters(data) {
  const box = $('#course-filters');
  const courses = [...new Set(data.map(a => a.course))].sort();
  if (!courses.length) { box.replaceChildren(el('p', 'hint', 'Courses appear here after a sync.')); return; }
  box.replaceChildren(...courses.map(course => {
    const label = el('label', 'check'), input = el('input');
    input.type = 'checkbox'; input.checked = !settings.hiddenCourses.includes(course);
    input.addEventListener('change', () => {
      settings = {...settings, hiddenCourses: input.checked ? settings.hiddenCourses.filter(c => c !== course) : [...settings.hiddenCourses, course]};
      saveSettings();
    });
    const count = data.filter(a => a.course === course).length;
    label.append(input, ` ${course} `, el('span', 'small-text', `(${count})`));
    label.style.setProperty('--course', courseColor(course));
    return label;
  }));
}
// Header loading bar. fraction null = indeterminate. Detailed progress goes to the dev toolbar instead.
const loadbar = $('#loadbar'), loadFill = $('#loadbar-fill');
function setLoading(fraction, label) {
  loadbar.classList.remove('idle');
  loadbar.parentElement.classList.add('busy');
  loadbar.classList.toggle('indeterminate', fraction === null);
  if (fraction !== null) {
    loadFill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    loadbar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  }
  $('#loadbar-label').textContent = label;
}
function stopLoading() { loadbar.classList.add('idle'); loadbar.parentElement.classList.remove('busy'); loadFill.style.width = '0%'; }
const devStatus = text => { $('#dev-status').textContent = text; };
// Week view navigation: 0 = the current week.
let weekOffset = 0;
$('#week-prev').onclick = () => { weekOffset--; render(shown); };
$('#week-next').onclick = () => { weekOffset++; render(shown); };
$('#week-today').onclick = () => { weekOffset = 0; render(shown); };
$('#view-week').onclick = () => { settings = {...settings, view: 'week'}; saveSettings(); };
$('#view-list').onclick = () => { settings = {...settings, view: 'list'}; saveSettings(); };
// Tabs: Assignments, Advanced options, and Server settings.
const tabs = [...document.querySelectorAll('[role=tab]')];
function selectTab(tab) {
  for (const t of tabs) {
    const selected = t === tab;
    t.setAttribute('aria-selected', String(selected)); t.tabIndex = selected ? 0 : -1;
    $(`#${t.getAttribute('aria-controls')}`).hidden = !selected;
  }
}
tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    const next = {ArrowRight: 1, ArrowLeft: -1}[event.key];
    if (next) { const target = tabs[(i + next + tabs.length) % tabs.length]; selectTab(target); target.focus(); }
  });
});
// Developer toolbar: server provider and the latest sync report path.
async function refreshServerInfo() {
  try {
    const health = await ask({type: 'HEALTH'});
    $('#server-info').textContent = `Server: ${health.provider}`;
  } catch { $('#server-info').textContent = 'Server: not running'; }
}
const HOUR = 3600000;
// "in 6 h", "tomorrow", "in 3 days", "2 days late" relative to now.
function relative(dueAt, now = Date.now()) {
  const diff = Date.parse(dueAt) - now, abs = Math.abs(diff);
  const amount = abs < DAY ? `${Math.max(1, Math.round(abs / HOUR))} h` : `${Math.round(abs / DAY)} day${Math.round(abs / DAY) === 1 ? '' : 's'}`;
  return diff < 0 ? `${amount} late` : `in ${amount}`;
}
const when = iso => new Date(iso).toLocaleString(undefined, {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
// Day-only formats for the week view, which never shows times.
const whenDay = iso => new Date(iso).toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'});
const dayLabel = text => new Date(`${text}T00:00`).toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'});
function relativeDay(iso, now = Date.now()) {
  const diff = Math.round((new Date(`${dayOf(Date.parse(iso))}T00:00`) - new Date(`${dayOf(now)}T00:00`)) / DAY);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return '1 day late';
  return diff < 0 ? `${-diff} days late` : `in ${diff} days`;
}
function effort(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 30) / 2;
  return `${hours} h`;
}
// Stable color per course name so the same course looks the same everywhere.
// Course colors from Cobalt Next's syntax palette (themes/CobaltNext.json). Its red and yellow are left out
// because they mark late and due-soon work.
const COURSE_COLORS = ['#5A9BCF', '#99C794', '#C5A5C5', '#EB9A6D', '#BB80B3', '#AB7967', '#CDD3DE'];
const courseColor = name => COURSE_COLORS[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 997, 7) % COURSE_COLORS.length];
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
// Cards the user expanded, kept open when the list re-renders (range changes, re-sync).
const expanded = new Set();
const SUBMISSION_LABELS = {online_upload: 'File upload', online_text_entry: 'Text entry', online_url: 'Website URL', online_quiz: 'Quiz',
  discussion_topic: 'Discussion', on_paper: 'On paper', external_tool: 'External tool', media_recording: 'Media recording', none: 'No submission'};
// Expandable card: the summary shows course, effort, title, and due time; the body holds the details.
// daysOnly: show dates without times (used by the week view).
function card(a, overdue, {daysOnly = false} = {}) {
  const fmt = daysOnly ? whenDay : when, rel = daysOnly ? relativeDay : relative;
  const card = el('details', 'card');
  card.open = expanded.has(a.id);
  card.addEventListener('toggle', () => { card.open ? expanded.add(a.id) : expanded.delete(a.id); });
  if (overdue) card.classList.add('late');
  else if (a.startAt && new Date(a.startAt) < new Date()) card.classList.add('behind');
  card.style.setProperty('--course', courseColor(a.course));

  const summary = el('summary');
  const top = el('div', 'card-top');
  const flag = priorityOf(a, settings);
  const badges = el('span', 'badges');
  if (flag) {
    badges.append(el('span', `flag flag-${flag}`, flag === 'late' ? 'Late' : 'Due soon'));
    card.classList.add(`priority-${flag}`);
  }
  badges.append(el('span', 'estimate', `~${effort(a.estimatedMinutes)}`));
  top.append(el('span', 'course', a.course), badges);
  badges.lastChild.title = `Estimated active work (${a.provider})`;
  const due = el('p', 'due', !a.dueAt ? 'No deadline' : overdue ? `${rel(a.dueAt)} · was due ${fmt(a.dueAt)}` : `Due ${rel(a.dueAt)} · ${fmt(a.dueAt)}`);
  if (a.dueAt && !daysOnly) due.title = new Date(a.dueAt).toLocaleString();
  summary.append(top, el('h3', '', a.title), due);

  const body = el('div', 'card-body');
  const meta = el('dl', 'meta');
  const row = (label, value, title) => { const d = el('div'); const dd = el('dd', '', value); if (title) dd.title = title; d.append(el('dt', '', label), dd); meta.append(d); };
  if (overdue) row('Start', 'Now');
  else if (daysOnly) { const span = workSpan(a, settings); if (span) row('Work on', span.start === span.end ? dayLabel(span.start) : `${dayLabel(span.start)} – ${dayLabel(span.end)}`); }
  else row('Start by', a.startAt ? `${when(a.startAt)} (${relative(a.startAt)})` : 'Choose a date');
  row('Estimate', `${effort(a.estimatedMinutes)} of active work (${a.provider})`);
  row('Points', String(a.points ?? 0));
  if (a.submissionTypes?.length) row('Submit as', a.submissionTypes.map(t => SUBMISSION_LABELS[t] || t.replaceAll('_', ' ')).join(', '));
  body.append(meta);
  body.append(a.description ? el('p', 'description', a.description) : el('p', 'description empty-text', 'No description in Canvas.'));
  if (a.attachments?.length) body.append(el('p', 'files', `Attachments: ${a.attachments.map(f => f.name).join(', ')}`));
  const why = el('p', 'reason');
  why.append(el('strong', '', 'Why this estimate: '), a.reason);
  body.append(why, el('small', 'saved-anchor'));
  card.append(summary, body);
  showSavedFiles(card, a.id);
  return card;
}
function setAllExpanded(open) {
  for (const details of list.querySelectorAll('details.card')) details.open = open;
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
  card.querySelector('.saved-anchor').before(line);
}
// Week view: 7 day columns; each assignment is a bar across the days to work on it (see schedule.js).
let selectedId = null;
const shortCourse = name => name.split(/[:(]/)[0].trim().split(/\s+/).slice(0, 2).join(' ');
function showWeekDetail(a, now) {
  selectedId = a?.id ?? null;
  const box = $('#week-detail');
  if (!a) { box.replaceChildren(); return; }
  const detail = card(a, Boolean(a.dueAt && Date.parse(a.dueAt) < now), {daysOnly: true});
  detail.open = true;
  const close = el('button', 'quiet small week-detail-close', 'Close');
  close.type = 'button';
  close.onclick = event => { event.preventDefault(); showWeekDetail(null); render(shown); };
  detail.querySelector('.badges').append(close);
  box.replaceChildren(detail);
}
function renderWeek(visible, now) {
  const days = weekDays(now, settings.weekStart, weekOffset), today = dayOf(now);
  $('#week-label').textContent = `${weekOffset === 0 ? 'This week' : weekOffset === 1 ? 'Next week' : weekOffset === -1 ? 'Last week' : 'Week of'} · ${dayLabel(days[0])} – ${dayLabel(days[6])}`;
  const {bars, lanes} = layoutWeek(visible.map(a => ({a, span: workSpan(a, settings, now)})), days);
  const grid = $('#week');
  grid.style.setProperty('--lanes', String(Math.max(lanes, 1)));
  const cells = days.map((day, i) => {
    const head = el('div', `day-head${day === today ? ' today' : ''}${day < today ? ' past' : ''}`);
    head.setAttribute('role', 'columnheader');
    const date = new Date(`${day}T00:00`);
    head.append(el('span', 'day-name', date.toLocaleDateString(undefined, {weekday: 'short'})), el('span', 'day-num', String(date.getDate())));
    head.style.setProperty('--i', String(i + 1));
    const column = el('div', `day-col${day === today ? ' today' : ''}`);
    column.style.setProperty('--i', String(i + 1));
    return [column, head];
  }).flat();
  const barEls = bars.map(({a, span, startCol, endCol, lane, continuesBefore, continuesAfter}) => {
    const flag = priorityOf(a, settings, now);
    const bar = el('button', `bar${flag ? ` bar-${flag}` : ''}${span.behind ? ' bar-behind' : ''}${continuesBefore ? ' cont-before' : ''}${continuesAfter ? ' cont-after' : ''}${a.id === selectedId ? ' selected' : ''}`);
    bar.type = 'button';
    for (const [name, value] of Object.entries({'--s': startCol + 1, '--e': endCol + 2, '--lane': lane + 2})) bar.style.setProperty(name, String(value));
    bar.style.setProperty('--course', courseColor(a.course));
    // Bars show only course and title; late and due-soon work is marked by color. Details open below on click.
    bar.title = `${a.course}: ${a.title}`;
    if (flag) bar.setAttribute('aria-label', `${a.course}: ${a.title} (${flag === 'late' ? 'late' : 'due soon'})`);
    bar.append(el('span', 'bar-course', shortCourse(a.course)), el('span', 'bar-title', a.title));
    bar.onclick = () => { showWeekDetail(a, now); render(shown); };
    return bar;
  });
  grid.replaceChildren(...cells, ...barEls);
  if (!barEls.length) {
    const empty = el('p', 'week-empty', visible.length ? 'Nothing to work on this week.' : 'No assignments yet. Sync from Canvas to fill your week.');
    grid.append(empty);
  }
  const selected = visible.find(a => a.id === selectedId);
  showWeekDetail(selected, now);
}
function section(name, items, overdue) {
  const wrapper = el('section', overdue ? 'catch-up' : 'upcoming');
  const heading = el('h2', '', name);
  heading.append(el('span', 'count', String(items.length)));
  const grid = el('div', 'cards');
  grid.append(...items.map(a => card(a, overdue)));
  wrapper.append(heading, grid);
  return wrapper;
}
// Categories are computed at render time so assignments move to Catch Up as their deadlines pass.
function render(data) {
  shown = data;
  list.replaceChildren();
  const now = Date.now();
  // Catch Up shows the oldest overdue first; Upcoming shows the soonest first, then undated.
  renderCourseFilters(data);
  const sorted = data.filter(a => isVisible(a, settings, now)).sort((a,b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity) || 0);
  const catchUp = sorted.filter(a => a.dueAt && Date.parse(a.dueAt) < now);
  const upcoming = sorted.filter(a => !catchUp.includes(a));
  renderWeek(sorted, now);
  if (catchUp.length) list.append(section('Catch Up', catchUp, true));
  if (upcoming.length) list.append(section('Upcoming', upcoming, false));
  const late = sorted.filter(a => priorityOf(a, settings, now) === 'late').length;
  const soon = sorted.filter(a => priorityOf(a, settings, now) === 'soon').length;
  const soonLabel = {0: 'due today', 1: 'due by tomorrow', 2: 'due within 3 days'}[settings.urgentDays];
  const summary = $('#priority-summary');
  summary.replaceChildren();
  if (late) summary.append(el('span', 'flag flag-late', `${late} late`));
  if (soon && soonLabel) summary.append(el('span', 'flag flag-soon', `${soon} ${soonLabel}`));
  if (!sorted.length) list.append(el('p', 'empty', data.length
    ? `All ${data.length} assignments are hidden by the current options. Check Advanced options.`
    : 'No assignments yet. Click the toolbar icon on your Canvas tab and Sync, or try Load demo.'));
}
// Each step gets a label and a deadline so a hang reports where it happened instead of spinning forever.
async function step(label, ms, work) {
  devStatus(`${label}…`);
  const started = Date.now(), phase = {phase: label, ms: 0, ok: false};
  phases.push(phase);
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${ms / 1000}s while ${label.toLowerCase()}.`)), ms); });
  try { const value = await Promise.race([work(), timeout]); phase.ok = true; return value; }
  catch (error) { console.error(`[${label}]`, error); throw error.message.startsWith('Timed out') ? error : new Error(`${label} failed: ${error.message}`); }
  finally { clearTimeout(timer); phase.ms = Date.now() - started; }
}
async function run(work) {
  buttons.forEach(b => b.disabled = true); status.className = ''; status.textContent = ''; status.title = '';
  try { await work(); } catch(e) { status.className = 'error'; status.textContent = e.message; status.title = e.message; devStatus(e.message); }
  finally { buttons.forEach(b => b.disabled = false); stopLoading(); }
}
async function ask(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response === undefined) throw new Error('The extension service worker did not reply. Reload the extension at chrome://extensions.');
  if (!response.ok) throw new Error(response.error || 'Unknown error');
  return response;
}
async function estimate(assignments) {
  setLoading(0.45, 'Checking server');
  await step('Checking server', 6000, () => ask({type:'HEALTH'}));
  if (!assignments.length) throw new Error('No unsubmitted assignments found in your active Canvas courses.');
  if (assignments.length > MAX_BATCH) throw new Error(`Found ${assignments.length} unsubmitted assignments; the server accepts at most ${MAX_BATCH}. Narrow the date range in Advanced options and sync again.`);
  let response;
  const phase={phase:`Estimating ${assignments.length} assignments`,ms:0,ok:false};
  const started=Date.now();phases.push(phase);
  try {
    setLoading(0.5, `Estimating 0/${assignments.length}`);
   const job=await ask({type:'INFERENCE_START',assignments});inferenceJobId=job.jobId;
    console.info('[Inference started]',{jobId:job.jobId,count:assignments.length,logFile:job.logFile});
    while(true) {
      response=await ask({type:'INFERENCE_POLL',jobId:job.jobId});
      setLoading(0.5 + 0.5 * response.completed / Math.max(1, response.total), `Estimating ${response.completed}/${response.total}`);
      status.textContent=`Estimating… ${response.completed}/${response.total} complete (${Math.round(response.elapsedMs/1000)}s).`;
      if(response.status==='complete') {phase.ok=true;break;}
      if(response.status!=='running') throw new Error(response.error || 'Inference stopped');
      if(Date.now()-started>600000) throw new Error('Inference exceeded 10 minutes.');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  } catch(error) {
    if(inferenceJobId) await ask({type:'INFERENCE_CANCEL',jobId:inferenceJobId}).catch(()=>{});
    throw error;
  } finally {phase.ms=Date.now()-started;}
  setLoading(1, 'Done');
  await chrome.storage.local.set({assignments: response.assignments});
  render(response.assignments); status.textContent = `${response.assignments.length} assignments up to date.`;
}
async function saveSyncReport(result, error) {
  const report = {startedAt: new Date(syncStartedAt).toISOString(), totalMs: Date.now() - syncStartedAt, ok: !error, error: error?.message || null,
    settings, window: resolveWindow(settings), readFiles: settings.readFiles && settings.devMode, phases, inferenceJobId, canvas: result?.diagnostics || lastCanvasDiagnostics || {requests:canvasRequests,requestCount:canvasRequests.length},
    counts: result ? {assignments: result.assignments.length, courses: result.courses.length, skipped: {...result.skipped, files: result.skipped.files.length}} : null,
    timeline};
  try {
    const {file} = await ask({type: 'SYNC_REPORT', report});
    console.info('Sync report saved:', file);
    return file;
  } catch (reportError) { console.error('[Sync report]', reportError); return null; }
}
// Clicking the toolbar icon (on Canvas or anywhere) opens or focuses this page and syncs right away.
function autoSync() { if (!syncing) $('#sync').click(); }
document.querySelector('#sync').onclick = () => syncing || run(async () => {
  syncing = true; showSyncButton();
  try { await syncOnce(); } finally { syncing = false; showSyncButton(); }
});
async function syncOnce() {
  phases = []; timeline = []; syncStartedAt = Date.now();inferenceJobId=null;lastCanvasDiagnostics=null;canvasRequests.length=0;
  let result, failure;
  try { result = await syncCanvas(); }
  catch (error) { failure = error; }
  const file = await saveSyncReport(result, failure);
  if (failure) throw new Error(failure.message);
  if (file) $('#last-report').textContent = `Last report: ${file}`;
}
// Waits until a tab finishes loading (or 30 s pass).
function tabLoaded(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error('Canvas took more than 30 seconds to load.')); }, 30000);
    const listener = (id, change) => {
      if (id === tabId && change.status === 'complete') { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(tab => { if (tab.status === 'complete') listener(tabId, {status: 'complete'}); }).catch(() => {});
  });
}
const runCollector = tabId => chrome.scripting.executeScript({target: {tabId}, func: collectCanvasAssignments, args: [collectorOptions(settings)]});
const accessDenied = error => /cannot access|permission|cannot be scripted|host/i.test(error.message);
// Finds a Canvas tab Sync may read, in order: the tab the icon was clicked on (activeTab access), an open tab on the
// saved Canvas address, or a new background tab on it. Reading any tab but the clicked one needs host permission,
// which Chrome asks for once. Returns {tabId, opened} where opened means Sync created the tab and should close it.
async function canvasTab() {
  // The clicked tab counts only if it is on the saved Canvas site (or no site is saved yet).
  const clickedOnCanvas = sourceTab && (!settings.canvasUrl || !sourceTab.url || hostOf(sourceTab.url) === hostOf(settings.canvasUrl));
  if (clickedOnCanvas && await chrome.tabs.get(sourceTab.id).catch(() => null)) return {tabId: sourceTab.id, opened: false, viaClick: true};
  const origin = settings.canvasUrl;
  if (!origin) throw new Error('Click the CanPlan icon while on your Canvas page once, or add your Canvas address in Advanced options.');
  const pattern = `${origin}/*`;
  let granted = await chrome.permissions.contains({origins: [pattern]});
  if (!granted) {
    try { granted = await chrome.permissions.request({origins: [pattern]}); } catch { granted = false; }
  }
  if (!granted) throw new Error(`Allow access to ${hostOf(origin)} when Chrome asks, then Sync again. Or click the CanPlan icon while on Canvas.`);
  const [open] = (await chrome.tabs.query({url: pattern})).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  if (open) { await tabLoaded(open.id); return {tabId: open.id, opened: false}; }
  setLoading(0.04, 'Opening Canvas');
  const created = await chrome.tabs.create({url: `${origin}/`, active: false});
  await tabLoaded(created.id);
  return {tabId: created.id, opened: true};
}
async function syncCanvas() {
  resetProgress();
  setLoading(0.02, 'Connecting');
  let target = await canvasTab();
  readingCanvas = true;
  setLoading(0.03, 'Connecting');
  // Large file syncs can legitimately take a while, so fail on 2 minutes without progress rather than a short fixed limit.
  let watchdog;
  const stalled = new Promise((_, reject) => { watchdog = setInterval(() => {
    if (Date.now() - lastProgressAt > 120000) reject(new Error('Canvas sync stalled: no progress for 2 minutes. The last line in the list shows where it stopped.'));
  }, 5000); });
  let result;
  try {
    result = await step('Reading Canvas', 1800000, () => Promise.race([stalled, (async () => {
      let injection;
      try { [injection] = await runCollector(target.tabId); }
      catch (error) {
        // activeTab access to the clicked tab ends when it reloads or navigates; fall back to the saved Canvas address.
        if (!target.viaClick || !accessDenied(error) || !settings.canvasUrl) throw error;
        setSource(null);
        target = await canvasTab();
        [injection] = await runCollector(target.tabId);
      }
      if (!injection?.result) throw new Error('The Canvas tab returned nothing. Reload the Canvas page and try again.');
      lastCanvasDiagnostics=injection.result.diagnostics || null;
      if (!injection.result.ok) {
        // Signed out: show the tab Sync opened so the user can sign in there.
        if (target.opened && /signed in|401|not a Canvas site/i.test(injection.result.error)) {
          await chrome.tabs.update(target.tabId, {active: true});
          target.opened = false;
          throw new Error('Sign in to Canvas in the tab that just opened, then Sync again.');
        }
        throw new Error(injection.result.error);
      }
      return injection.result;
    })()]));
  } finally {
    clearInterval(watchdog); readingCanvas = false;
    if (target.opened) chrome.tabs.remove(target.tabId).catch(() => {});
  }
  // Remember the Canvas address so later syncs work without clicking the icon on Canvas.
  if (result.origin && result.origin !== settings.canvasUrl) { settings = {...settings, canvasUrl: result.origin}; saveSettings(); }
  lastSync = Date.now();
  chrome.storage.local.set({lastSync}).catch(() => {});
  showSource();
  // Keep the list after a failure so it shows where sync stopped; clear it on success.
  resetProgress();
  await estimate(result.assignments);
  console.info('Skipped courses:', result.skipped.endedCourseNames);
  if (result.skipped.files.length) console.info('Skipped attachments:', result.skipped.files);
  const attached = result.assignments.reduce((n, a) => n + a.attachments.length, 0);
  const fileSummary = settings.readFiles && settings.devMode ? ` Read ${attached} attachments, saved ${result.documents.saved} new documents (${result.documents.current} already saved, linked to assignments ${result.documents.links} times), ${result.skipped.files.length} files skipped (see console).` : '';
  devStatus(`${result.assignments.length} assignments from ${result.courses.length} courses.`);
  $('#dev-status').textContent += ` Courses: ${result.courses.join(', ') || 'none'}. Skipped ${result.skipped.endedCourses} ended courses, ${result.skipped.completed} completed, ${result.skipped.pastDue} ${settings.includeLate ? 'due before the range' : 'late (hidden in options)'}, and ${result.skipped.tooFar} due after the range.` + fileSummary;
  return result;
}
document.querySelector('#expand-all').onclick = () => setAllExpanded(true);
document.querySelector('#collapse-all').onclick = () => setAllExpanded(false);
document.querySelector('#demo').onclick = () => run(() => estimate(demoAssignments()));
// Clears synced data and saved documents but keeps the chosen range.
document.querySelector('#clear').onclick = () => run(async () => {await chrome.storage.local.remove(['assignments', 'lastSync']);await clearFiles();lastSync = null;showSource();showSyncButton();render([]);status.textContent='Local data and saved documents cleared.';});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if(message?.type==='CANVAS_DIAGNOSTIC' && readingCanvas) {canvasRequests.push(message.timing);return;}
  if (message?.type === 'ICON_CLICKED') { if (message.source) setSource(message.source); autoSync(); return; }
  if (message?.type !== 'CANVAS_PROGRESS' || !readingCanvas) return;
  lastProgressAt = Date.now();
  timeline.push({atMs: lastProgressAt - syncStartedAt, course: message.course || null, text: message.text});
  if (!message.course) {
    devStatus(`Reading Canvas… ${message.text}`);
    const read = message.text.match(/^(\d+)\/(\d+) courses read/), found = message.text.match(/^found (\d+) current courses/);
    if (read) setLoading(0.1 + 0.3 * Number(read[1]) / Math.max(1, Number(read[2])), 'Reading courses');
    else if (found) setLoading(0.1, 'Reading courses');
    else setLoading(0.05, 'Reading courses');
    return;
  }
  courseProgress.set(message.course, message.text);
  progressList.replaceChildren(...[...courseProgress].map(([course, text]) => {
    const line = document.createElement('li'); line.textContent = `${course}: ${text}`; return line;
  }));
});
chrome.storage.local.get(['assignments', 'settings', 'lastSync']).then(({assignments = [], settings: saved, lastSync: stored}) => {
  settings = {...structuredClone(DEFAULT_SETTINGS), ...saved};
  lastSync = stored || null;
  showSettings();
  showSyncButton();
  render(assignments);
  // Opened from the toolbar icon: sync immediately.
  if (new URLSearchParams(location.search).has('opened')) autoSync();
});
