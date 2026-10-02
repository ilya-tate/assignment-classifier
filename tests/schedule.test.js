import test from 'node:test';
import assert from 'node:assert/strict';
import {workDays, workSpan, weekDays, layoutWeek, addDays} from '../extension/schedule.js';

const at = text => new Date(text).getTime();   // local time
const due = (text, minutes = 60) => ({dueAt: new Date(text).toISOString(), estimatedMinutes: minutes});
const now = at('2026-10-02T12:00');           // a Friday

test('work days come from the estimate plus 25% buffer at the daily pace', () => {
  assert.equal(workDays(60, 2), 1);
  assert.equal(workDays(96, 2), 1);   // 120 minutes with buffer
  assert.equal(workDays(97, 2), 2);
  assert.equal(workDays(480, 2), 5);
  assert.equal(workDays(480, 4), 3);
});

test('upcoming work ends on its due day; late work starts today; overdue plans start today', () => {
  assert.deepEqual(workSpan(due('2026-10-08T23:59', 240), {dailyHours: 2}, now),
    {start: '2026-10-06', end: '2026-10-08', dueDay: '2026-10-08', late: false, behind: false});
  assert.deepEqual(workSpan(due('2026-09-30T23:59', 240), {dailyHours: 2}, now),
    {start: '2026-10-02', end: '2026-10-04', dueDay: '2026-09-30', late: true, behind: false});
  const squeezed = workSpan(due('2026-10-03T23:59', 480), {dailyHours: 2}, now);
  assert.deepEqual([squeezed.start, squeezed.end, squeezed.behind], ['2026-10-02', '2026-10-03', true]);
  assert.equal(workSpan({dueAt: null, estimatedMinutes: 60}, {dailyHours: 2}, now), null);
});

test('weeks start on Monday or Sunday and step by offset', () => {
  assert.deepEqual(weekDays(now, 1), ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  assert.equal(weekDays(now, 0)[0], '2026-09-27');
  assert.equal(weekDays(now, 1, 1)[0], '2026-10-05');
  assert.equal(weekDays(now, 1, -1)[6], '2026-09-27');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('bars clip to the week, mark cut-off edges, and pack into the fewest lanes', () => {
  const days = weekDays(now, 1);
  const item = (start, end) => ({span: {start, end, dueDay: end}});
  const {bars, lanes} = layoutWeek([
    item('2026-09-25', '2026-09-29'),   // starts last week
    item('2026-09-30', '2026-10-01'),   // fits after the first bar in lane 0
    item('2026-09-29', '2026-10-06'),   // overlaps both, runs into next week
    item('2026-10-10', '2026-10-11'),   // outside this week
    {span: null}
  ], days);
  assert.equal(bars.length, 3);
  assert.equal(lanes, 2);
  const first = bars.find(b => b.span.start === '2026-09-25');
  assert.deepEqual([first.startCol, first.endCol, first.continuesBefore, first.continuesAfter, first.lane], [0, 1, true, false, 0]);
  const long = bars.find(b => b.span.end === '2026-10-06');
  assert.deepEqual([long.startCol, long.endCol, long.continuesAfter, long.lane], [1, 6, true, 1]);
  assert.equal(bars.find(b => b.span.start === '2026-09-30').lane, 0);
});
