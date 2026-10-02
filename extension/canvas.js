// Executed only after a user clicks Sync on their active Canvas tab.
// overdueDays: how many days past due an unsubmitted assignment is still kept (0 = drop all past-due work).
async function collectCanvasAssignments({overdueDays = 0} = {}) {
  const cutoff = Date.now() - overdueDays * 86400000;
  const DONE_STATES = new Set(['submitted', 'graded', 'pending_review']);
  const isCompleted = s => Boolean(s && (DONE_STATES.has(s.workflow_state) || s.submitted_at || s.excused));
  const text = html => new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();
  async function pages(path) {
    let next = new URL(path, location.origin).href;
    const rows = [];
    while (next) {
      const url = new URL(next);
      if (url.origin !== location.origin || !url.pathname.startsWith('/api/v1/')) throw new Error('Invalid Canvas pagination URL');
      let response;
      try {
        response = await fetch(url, {credentials: 'same-origin', headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(20000)});
      } catch (error) {
        throw new Error(error.name === 'TimeoutError' ? `Canvas did not respond within 20s (${url.pathname}).` : `Network error contacting Canvas (${url.pathname}).`);
      }
      if (response.status === 401 || response.status === 403) throw new Error(`Canvas returned ${response.status} for ${url.pathname}; check that you are signed in.`);
      if (!response.ok) throw new Error(`Canvas returned ${response.status} for ${url.pathname}.`);
      // Canvas can prefix session-authenticated JSON with "while(1);" to block JSON hijacking.
      const body = (await response.text()).replace(/^while\(1\);/, '');
      let data;
      try { data = JSON.parse(body); } catch { throw new Error('This tab is not a Canvas site (API returned non-JSON).'); }
      if (!Array.isArray(data)) throw new Error('This tab does not expose the Canvas API.');
      rows.push(...data);
      const link = response.headers.get('Link') || '';
      const following = link.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      if (following === next) throw new Error('Canvas pagination repeated the same page.');
      next = following;
      if (rows.length > 5000) throw new Error('Canvas sync exceeded the scaffold limit.');
    }
    return rows;
  }
  // Progress goes to the popup so a slow sync shows where it is. Ignore failures if the popup closed.
  const progress = text => chrome.runtime.sendMessage({type: 'CANVAS_PROGRESS', text}).catch(() => {});
  try {
    if (location.protocol !== 'https:') throw new Error('Open your HTTPS Canvas site first.');
    progress('listing courses');
    // A course is over when Canvas marks it concluded or its own or term end date has passed.
    // Over courses are dropped entirely; courses with no dates at all are treated as ongoing.
    const ended = date => Boolean(date) && Date.parse(date) < Date.now();
    const isOver = c => c.concluded === true || ended(c.end_at) || ended(c.term?.end_at);
    const available = (await pages('/api/v1/courses?enrollment_state=active&include[]=term&include[]=concluded&per_page=100')).filter(c => c.workflow_state === 'available');
    // Many schools never set end dates, so the dashboard (normally just this term's courses) is the main signal.
    // If the dashboard can't be read or is empty, fall back to the date checks alone.
    let dashboard = null;
    try {
      const cards = await pages('/api/v1/dashboard/dashboard_cards');
      if (cards.length) dashboard = new Set(cards.map(card => String(card.id)));
    } catch { /* fall back to date checks */ }
    const courses = available.filter(c => !isOver(c) && (!dashboard || dashboard.has(String(c.id))));
    const assignments = [];
    const skipped = {completed: 0, pastDue: 0, endedCourses: available.length - courses.length, endedCourseNames: available.filter(c => !courses.includes(c)).map(c => c.name)};
    const kept = [];
    // A course whose latest due date is over a semester (~6 months) old is treated as over even if Canvas says otherwise.
    const STALE_MS = 182 * 86400000;
    let done = 0;
    progress(`found ${courses.length} current courses (${skipped.endedCourses} ended)`);
    // Read a few courses at a time; one slow course should not serialize the whole sync.
    const queue = [...courses];
    async function worker() {
      for (let course; (course = queue.shift());) {
        let rows;
        try { rows = await pages(`/api/v1/courses/${course.id}/assignments?per_page=100&include[]=submission`); }
        catch (error) { throw new Error(`${course.name}: ${error.message}`); }
        const lastDue = Math.max(...rows.filter(a => a.due_at).map(a => Date.parse(a.due_at)));
        if (Number.isFinite(lastDue) && lastDue < Date.now() - STALE_MS) {
          skipped.endedCourses++; skipped.endedCourseNames.push(course.name);
          progress(`${++done}/${courses.length} courses read (${course.name}: no recent assignments, skipped)`);
          continue;
        }
        kept.push(course.name);
        for (const a of rows) {
          if (isCompleted(a.submission)) { skipped.completed++; continue; }
          // Undated assignments are kept; the planner shows them without a start time.
          if (a.due_at && Date.parse(a.due_at) < cutoff) { skipped.pastDue++; continue; }
          assignments.push({id: `${location.host}:${course.id}:${a.id}`, title: a.name,
            course: course.name, description: text(a.description).slice(0, 12000),
            dueAt: a.due_at || null, points: a.points_possible || 0,
            submissionTypes: a.submission_types || [], url: a.html_url});
        }
        progress(`${++done}/${courses.length} courses read (${course.name}: ${rows.length} assignments)`);
      }
    }
    await Promise.all(Array.from({length: Math.min(4, courses.length)}, worker));
    return {ok: true, assignments, skipped, courses: kept};
  } catch (error) { return {ok: false, error: error.message}; }
}
