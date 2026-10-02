import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createMockCanvas, EXPECTED_CURRENT_COURSES, EXPECTED_SKIPPED_COURSES} from '../harness/mock-canvas.js';
import {demoAssignments} from '../extension/demo-data.js';
import {validateAssignments} from '../shared/contracts.js';

const collectorSource = await readFile(new URL('../extension/canvas.js', import.meta.url), 'utf8');

async function startMock(t) {
  const server = createMockCanvas({delayMs: 0, slowCourseDelayMs: 0});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

// Runs the extension's collector as if injected into a mock Canvas tab, over real HTTP.
async function scrape(origin, {signedIn = true, options = {overdueDays: 14}} = {}) {
  const store = new Map(), requested = [];
  const cookieFetch = (input, init = {}) => {
    requested.push(new URL(String(input)));
    return fetch(input, {...init, headers: {...init.headers, ...(signedIn ? {Cookie: 'mock_canvas_session=demo-student'} : {})}});
  };
  const chrome = {runtime: {sendMessage: async message => {
    if (message.type === 'FILE_HAS') return {ok: true, has: false};
    if (message.type === 'FILE_SAVE') { store.set(message.file.key, message.file); return {ok: true}; }
    if (message.type === 'FILE_LINK') return {ok: true, linked: true};
  }}};
  const DOMParser = class { parseFromString(html) { return {body: {textContent: html.replace(/<[^>]+>/g, '')}}; } };
  const context = vm.createContext({fetch: cookieFetch, chrome, DOMParser, location: new URL(`${origin}/courses`), URL, Response, TextDecoder, AbortSignal, Blob, btoa});
  vm.runInContext(collectorSource, context);
  return {result: JSON.parse(JSON.stringify(await context.collectCanvasAssignments(options))), store, requested};
}

test('sync against mock Canvas keeps current courses and open work, skipping ended courses and finished work', async (t) => {
  const {result} = await scrape(await startMock(t));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual([...result.courses].sort(), [...EXPECTED_CURRENT_COURSES].sort());
  assert.deepEqual([...result.skipped.endedCourseNames].sort(), [...EXPECTED_SKIPPED_COURSES].sort());
  // Expected: the Load demo set minus work more than 14 days past due.
  const expected = demoAssignments().filter(a => !a.dueAt || Date.parse(a.dueAt) >= Date.now() - 14 * 86400000).map(a => a.title).sort();
  assert.deepEqual(result.assignments.map(a => a.title).sort(), expected);
  assert.equal(validateAssignments(result.assignments).length, expected.length);
  // Bucketed requests never download Capstone 1's graded history; submitted-but-future work is still filtered locally.
  const capstone = result.diagnostics.courses.find(c => c.course === 'Capstone 1');
  assert.ok(capstone.assignments < 10, `Capstone 1 downloaded ${capstone.assignments} assignments`);
  assert.equal(capstone.pages, 3, 'one page per bucket');
  assert.ok(result.skipped.completed >= 5, 'submitted and excused future work is skipped');
  assert.deepEqual(result.assignments.map(a => a.attachments), result.assignments.map(() => []));
});

test('assignment requests ask only for open work and keep rubrics', async (t) => {
  const {requested} = await scrape(await startMock(t));
  const lists = requested.filter(u => /\/assignments$/.test(u.pathname));
  assert.ok(lists.length > 0);
  for (const u of lists) {
    assert.ok(['future', 'overdue', 'undated'].includes(u.searchParams.get('bucket')), u.href);
    assert.deepEqual(u.searchParams.getAll('exclude_response_fields[]'), [], 'rubrics must not be excluded');
  }
  const off = (await scrape(await startMock(t), {options: {overdueDays: 0}})).requested;
  assert.ok(off.filter(u => /\/assignments$/.test(u.pathname)).every(u => u.searchParams.get('bucket') !== 'overdue'), 'no overdue bucket with Catch Up off');
});

test('Capstone 1 transfers far less with bucketed requests than one unfiltered listing', async (t) => {
  const origin = await startMock(t);
  const get = async query => (await (await fetch(`${origin}/api/v1/courses/106/assignments?per_page=100&include[]=submission${query}`,
    {headers: {Cookie: 'mock_canvas_session=demo-student'}})).text()).length;
  const before = await get('') + await get('&page=2') + await get('&page=3');
  let after = 0;
  for (const bucket of ['future', 'overdue', 'undated']) after += await get(`&bucket=${bucket}`);
  assert.ok(after * 20 < before, `expected over 95% less data, got ${after} vs ${before} bytes`);
});

test('mock Canvas linked files are read and saved when file reading is on', async (t) => {
  const {result, store} = await scrape(await startMock(t), {options: {overdueDays: 14, readFiles: true}});
  const sprint = result.assignments.find(a => a.title.startsWith('Sprint 2'));
  assert.equal(sprint.attachments[0].name, 'starter_auth.py');
  assert.match(sprint.attachments[0].text, /def login/);
  assert.deepEqual([...store.values()].map(f => f.name), ['essay_rubric.pdf']);
});

test('mock Canvas rejects signed-out syncs with the collector\'s sign-in error', async (t) => {
  const {result} = await scrape(await startMock(t), {signedIn: false});
  assert.equal(result.ok, false);
  assert.match(result.error, /401.*signed in/);
  assert.equal(result.diagnostics.requestCount,1);
  assert.equal(result.diagnostics.requests[0].status,401);
  assert.equal(result.diagnostics.requests[0].outcome,'http_or_parse_error');
  assert.ok(result.diagnostics.requests[0].ms>=0);
});
