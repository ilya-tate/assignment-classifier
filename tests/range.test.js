import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SETTINGS, halfYear, resolveWindow, isVisible, collectorOptions, priorityOf, DAY} from '../extension/range.js';

const at = text => new Date(text).getTime();   // local time
const settings = overrides => ({...structuredClone(DEFAULT_SETTINGS), ...overrides});
const item = (dueAt, extra = {}) => ({course: 'BIO 201', points: 10, dueAt: dueAt && new Date(dueAt).toISOString(), ...extra});

test('default window is the current half of the year', () => {
  assert.deepEqual(halfYear(at('2026-03-15T12:00')), {from: '2026-01-01', to: '2026-05-31', label: 'Jan – May 2026'});
  assert.deepEqual(halfYear(at('2026-05-31T23:00')).to, '2026-05-31');
  assert.deepEqual(halfYear(at('2026-06-01T00:30')), {from: '2026-06-01', to: '2026-12-31', label: 'Jun – Dec 2026'});
  const win = resolveWindow(settings(), at('2026-10-02T12:00'));
  assert.equal(win.start, at('2026-06-01T00:00'));
  assert.equal(win.end, at('2027-01-01T00:00') - 1);
});

test('custom dates replace the half-year window', () => {
  const win = resolveWindow(settings({preset: 'custom', from: '2026-09-01', to: '2026-09-30'}), at('2026-10-02T12:00'));
  assert.deepEqual([win.from, win.to], ['2026-09-01', '2026-09-30']);
});

test('visibility follows the window, late, undated, 0-point, and course options', () => {
  const now = at('2026-10-02T12:00');
  assert.equal(isVisible(item('2026-10-20T23:59'), settings(), now), true);
  assert.equal(isVisible(item('2027-01-05T23:59'), settings(), now), false, 'after the half-year');
  assert.equal(isVisible(item('2026-09-01T23:59'), settings(), now), true, 'late, inside the window');
  assert.equal(isVisible(item('2026-09-01T23:59'), settings({includeLate: false}), now), false);
  assert.equal(isVisible(item('2026-05-20T23:59'), settings(), now), false, 'late, before the window');
  assert.equal(isVisible(item(null), settings(), now), true);
  assert.equal(isVisible(item(null), settings({includeUndated: false}), now), false);
  assert.equal(isVisible(item('2026-10-20T23:59', {points: 0}), settings({hideZeroPoint: true}), now), false);
  assert.equal(isVisible(item('2026-10-20T23:59'), settings({hiddenCourses: ['BIO 201']}), now), false);
});

test('priority flags late work and work due by the end of tomorrow by default', () => {
  const now = at('2026-10-02T12:00');
  assert.equal(priorityOf(item('2026-10-01T23:59'), settings(), now), 'late');
  assert.equal(priorityOf(item('2026-10-02T23:59'), settings(), now), 'soon');
  assert.equal(priorityOf(item('2026-10-03T23:59'), settings(), now), 'soon');
  assert.equal(priorityOf(item('2026-10-04T00:01'), settings(), now), null);
  assert.equal(priorityOf(item('2026-10-03T23:59'), settings({urgentDays: 0}), now), null);
  assert.equal(priorityOf(item('2026-10-05T23:59'), settings({urgentDays: 2}), now), null);
  assert.equal(priorityOf(item('2026-10-04T23:59'), settings({urgentDays: 2}), now), 'soon');
  assert.equal(priorityOf(item('2026-10-02T23:59'), settings({urgentDays: -1}), now), null);
  assert.equal(priorityOf(item(null), settings(), now), null);
});

test('sync asks the collector for the whole window, and files only in developer mode', () => {
  const now = at('2026-10-02T12:00');
  const options = collectorOptions(settings(), now);
  assert.equal(options.overdueDays, Math.ceil((now - at('2026-06-01T00:00')) / DAY));
  assert.equal(options.daysAhead, Math.ceil((at('2027-01-01T00:00') - 1 - now) / DAY));
  assert.equal(options.readFiles, false);
  assert.equal(collectorOptions(settings({includeLate: false}), now).overdueDays, 0);
  assert.equal(collectorOptions(settings({readFiles: true}), now).readFiles, false);
  assert.equal(collectorOptions(settings({readFiles: true, devMode: true}), now).readFiles, true);
});
