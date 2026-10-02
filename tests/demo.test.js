import test from 'node:test';
import assert from 'node:assert/strict';
import {demoAssignments} from '../extension/demo-data.js';
import {validateAssignments} from '../shared/contracts.js';
import {createServer, summarize} from '../server/index.js';

const DAY = 86400000;
const now = Date.parse('2026-10-02T18:00:00Z');
const demo = demoAssignments(now);
const offset = a => a.dueAt && (Date.parse(a.dueAt) - now) / DAY;

test('demo data passes the assignment contract', () => {
  assert.equal(validateAssignments(demo).length, demo.length);
  assert.ok(demo.length >= 12 && demo.length <= 100);
});

test('demo data covers both sections, range edges, and sparse input', () => {
  const {catchUp, upcoming} = summarize(demo, now);
  assert.ok(catchUp.length >= 3 && upcoming.length >= 8);
  assert.ok(demo.some(a => offset(a) < -14), 'past due beyond the default 14-day Catch Up window');
  assert.ok(demo.some(a => offset(a) < 0 && offset(a) > -14), 'past due inside the default window');
  assert.ok(demo.some(a => offset(a) > 0 && offset(a) < 1), 'due within a day');
  assert.ok(demo.some(a => offset(a) > 30), 'due more than 30 days out');
  assert.ok(demo.some(a => a.dueAt === null), 'undated');
  assert.ok(demo.some(a => a.description === ''), 'empty description');
  assert.ok(new Set(demo.map(a => a.course)).size >= 5, 'several courses');
});

test('demo data is estimated end to end in mock mode with varied effort', async (t) => {
  const server = createServer({env: {}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/estimate`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({assignments: demoAssignments()})
  });
  assert.equal(response.status, 200);
  const {assignments} = await response.json();
  assert.equal(assignments.length, demo.length);
  assert.ok(new Set(assignments.map(a => a.estimatedMinutes)).size >= 3, 'mock estimates should vary across the demo');
  assert.ok(assignments.filter(a => a.dueAt).every(a => a.startAt), 'dated work gets a start time');
});
