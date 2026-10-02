// Planner settings and the date window they describe. Pure functions so they can be tested in Node.
// The default window is the current half of the year: January–May or June–December (local time).
export const DAY = 86400000;

export const DEFAULT_SETTINGS = {
  preset: 'half-year',   // 'half-year' (auto) or 'custom'
  from: null,            // custom window start, 'YYYY-MM-DD'
  to: null,              // custom window end, 'YYYY-MM-DD' (inclusive)
  includeLate: true,     // past-due, unsubmitted work (the Catch Up section)
  includeUndated: true,
  hideZeroPoint: false,  // optional or ungraded work worth 0 points
  urgentDays: 1,         // flag as due soon through the end of today + N days (0 = today, 1 = tomorrow, -1 = off)
  hiddenCourses: [],
  view: 'week',          // 'week' (7-day bars) or 'list' (cards)
  weekStart: 1,          // 0 = Sunday, 1 = Monday
  dailyHours: 2,         // assumed hours per day on one assignment; sets how many days a week-view bar spans
  canvasUrl: '',          // Canvas origin, learned after the first successful sync or entered in Advanced options
  devMode: false,
  readFiles: false       // dev: read files linked from descriptions during sync
};

const pad = n => String(n).padStart(2, '0');
export const isoDate = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const localDate = text => { const [y, m, d] = text.split('-').map(Number); return new Date(y, m - 1, d); };

// January–May or June–December of the year containing `now`.
export function halfYear(now = Date.now()) {
  const date = new Date(now), year = date.getFullYear();
  return date.getMonth() <= 4
    ? {from: `${year}-01-01`, to: `${year}-05-31`, label: `Jan – May ${year}`}
    : {from: `${year}-06-01`, to: `${year}-12-31`, label: `Jun – Dec ${year}`};
}

// The window as timestamps: start of the first day through the end of the last day.
export function resolveWindow(settings, now = Date.now()) {
  const custom = settings.preset === 'custom' && settings.from && settings.to;
  const {from, to} = custom ? settings : halfYear(now);
  const start = localDate(from).getTime();
  const end = localDate(to).getTime() + DAY - 1;
  return {from, to, start: Math.min(start, end), end: Math.max(start, end)};
}

// Whether an assignment shows in the list under the current settings.
export function isVisible(a, settings, now = Date.now()) {
  if (settings.hiddenCourses.includes(a.course)) return false;
  if (settings.hideZeroPoint && !a.points) return false;
  if (!a.dueAt) return settings.includeUndated;
  const due = Date.parse(a.dueAt), {start, end} = resolveWindow(settings, now);
  if (due < start || due > end) return false;
  return due >= now || settings.includeLate;
}

// What Sync asks the collector for, in its days-relative-to-now terms.
export function collectorOptions(settings, now = Date.now()) {
  const {start, end} = resolveWindow(settings, now);
  return {
    overdueDays: settings.includeLate ? Math.max(0, Math.ceil((now - start) / DAY)) : 0,
    daysAhead: Math.max(0, Math.ceil((end - now) / DAY)),
    readFiles: Boolean(settings.devMode && settings.readFiles)
  };
}

// Priority flag for an assignment: 'late' (past due), 'soon' (due by the end of today + urgentDays), or null.
export function priorityOf(a, settings, now = Date.now()) {
  if (!a.dueAt) return null;
  const due = Date.parse(a.dueAt);
  if (due < now) return 'late';
  if (settings.urgentDays < 0) return null;
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() + settings.urgentDays + 1);
  return due < cutoff.getTime() ? 'soon' : null;
}
