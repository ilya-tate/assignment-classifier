// Week view scheduling: which days each assignment is worked on, and how bars pack into a 7-day grid.
// Pure functions (local dates as 'YYYY-MM-DD') so they can be tested in Node. Days only; no times.
import {isoDate} from './range.js';

const parseDay = text => { const [y, m, d] = text.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (text, n) => { const date = parseDay(text); date.setDate(date.getDate() + n); return isoDate(date); };
export const dayOf = timestamp => isoDate(new Date(timestamp));
const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 86400000);

// Work days needed: the estimate plus the planner's 25% buffer, at `dailyHours` per day on this assignment.
export function workDays(estimatedMinutes, dailyHours) {
  return Math.max(1, Math.ceil(estimatedMinutes * 1.25 / (dailyHours * 60)));
}

// The days to work on an assignment. Upcoming work ends on its due day; late work starts today.
// A plan that should already have started is moved to start today and marked `behind`.
export function workSpan(a, {dailyHours}, now = Date.now()) {
  if (!a.dueAt) return null;
  const today = dayOf(now), length = workDays(a.estimatedMinutes, dailyHours);
  const due = Date.parse(a.dueAt);
  if (due < now) return {start: today, end: addDays(today, length - 1), dueDay: dayOf(due), late: true, behind: false};
  const end = dayOf(due), planned = addDays(end, -(length - 1));
  const behind = planned < today;
  return {start: behind ? today : planned, end, dueDay: end, late: false, behind};
}

// The 7 days of the week containing `anchor` (offset by `weekOffset` weeks), starting on `weekStart` (0 Sun, 1 Mon).
export function weekDays(anchor, weekStart = 1, weekOffset = 0) {
  const date = new Date(anchor);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() - weekStart + 7) % 7) + weekOffset * 7);
  const first = isoDate(date);
  return Array.from({length: 7}, (_, i) => addDays(first, i));
}

// Bars for the spans that touch this week, clipped to it and packed into the fewest rows (lanes).
// startCol/endCol are 0-6; continuesBefore/After mark spans cut off by the week's edges.
export function layoutWeek(items, days) {
  const first = days[0], last = days[6];
  const bars = items
    .filter(({span}) => span && span.end >= first && span.start <= last)
    .map(item => ({...item,
      startCol: Math.max(0, daysBetween(first, item.span.start)), endCol: Math.min(6, daysBetween(first, item.span.end)),
      continuesBefore: item.span.start < first, continuesAfter: item.span.end > last}))
    .sort((a, b) => a.startCol - b.startCol || (b.endCol - b.startCol) - (a.endCol - a.startCol) || a.span.dueDay.localeCompare(b.span.dueDay));
  const laneEnds = [];
  for (const bar of bars) {
    let lane = laneEnds.findIndex(end => end < bar.startCol);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(bar.endCol); } else laneEnds[lane] = bar.endCol;
    bar.lane = lane;
  }
  return {bars, lanes: laneEnds.length};
}
