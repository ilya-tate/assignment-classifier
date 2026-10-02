// Executed only after a user clicks Sync on their active Canvas tab.
async function collectCanvasAssignments() {
  const text = html => new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();
  async function pages(path) {
    let next = new URL(path, location.origin).href;
    const rows = [];
    while (next) {
      const url = new URL(next);
      if (url.origin !== location.origin || !url.pathname.startsWith('/api/v1/')) throw new Error('Invalid Canvas pagination URL');
      const response = await fetch(url, {credentials: 'same-origin'});
      if (!response.ok) throw new Error(`Canvas returned ${response.status}; check that you are signed in.`);
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error('This tab does not expose the Canvas API.');
      rows.push(...data);
      const link = response.headers.get('Link') || '';
      next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      if (rows.length > 5000) throw new Error('Canvas sync exceeded the scaffold limit.');
    }
    return rows;
  }
  try {
    if (location.protocol !== 'https:') throw new Error('Open your HTTPS Canvas site first.');
    const courses = await pages('/api/v1/courses?enrollment_state=active&per_page=100');
    const assignments = [];
    for (const course of courses.filter(c => c.workflow_state === 'available')) {
      const rows = await pages(`/api/v1/courses/${course.id}/assignments?per_page=100&include[]=submission`);
      for (const a of rows) {
        if (a.submission?.workflow_state === 'submitted' || a.submission?.workflow_state === 'graded') continue;
        assignments.push({id: `${location.host}:${course.id}:${a.id}`, title: a.name,
          course: course.name, description: text(a.description).slice(0, 12000),
          dueAt: a.due_at || null, points: a.points_possible || 0,
          submissionTypes: a.submission_types || [], url: a.html_url});
      }
    }
    return {ok: true, assignments};
  } catch (error) { return {ok: false, error: error.message}; }
}
