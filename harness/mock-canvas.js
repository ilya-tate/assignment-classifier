// Mock Canvas LMS for end-to-end demos: serves the API endpoints the extension's collector scrapes, so a real
// Sync runs the real collector against synthetic data. Run `npm run mock-canvas`, open http://localhost:8790
// (which "signs you in"), then click Sync in the extension popup.
//
// Mimics Canvas behavior the collector depends on: session cookie auth, `while(1);` JSON prefix, Link-header
// pagination, include[]=submission, include[]=term/concluded, dashboard cards, and file metadata/downloads.
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {demoAssignments} from '../extension/demo-data.js';

const DAY = 86400000;
const SESSION = 'mock_canvas_session=demo-student';

// Courses: the demo set's six current courses plus four that the collector must skip.
const COURSES = [
  {id: 101, name: 'CS 340 Software Engineering'}, {id: 102, name: 'BIO 201 Genetics'},
  {id: 103, name: 'ENG 102 Composition'}, {id: 104, name: 'MATH 267 Linear Algebra'},
  {id: 105, name: 'HIST 110 World History'}, {id: 106, name: 'Capstone 1'},
  {id: 201, name: 'PSYCH 100 Intro Psychology (last spring)', termEnded: true},
  {id: 202, name: 'CHEM 110 General Chemistry (concluded)', concluded: true},
  {id: 203, name: 'Orientation Seminar (not on dashboard)', offDashboard: true},
  {id: 204, name: 'Study Skills Workshop (stale)', stale: true}
];
export const EXPECTED_CURRENT_COURSES = COURSES.slice(0, 6).map(c => c.name);
export const EXPECTED_SKIPPED_COURSES = COURSES.slice(6).map(c => c.name);
// Capstone 1 is the slow course, like real capstones: hundreds of old, graded daily notes (three pages when
// unfiltered), long HTML instructions, and large rubrics on every assignment.
export const CAPSTONE_EXTRA = 210;
const CAPSTONE_INSTRUCTIONS = `<h3>Submission requirements</h3>${'<p>Follow the capstone documentation template: problem statement, stakeholders, requirements traceability, architecture, risk register, testing strategy, and weekly retrospectives. Use the provided headings and cite team decisions.</p>'.repeat(4)}`;
const capstoneRubric = () => Array.from({length: 6}, (_, n) => ({id: `r${n}`, points: 10, description: `Criterion ${n + 1}`,
  long_description: 'Exceeds expectations: thorough, well organized, and clearly justified. '.repeat(3),
  ratings: [10, 7, 4, 0].map(points => ({points, description: `${points} points`, long_description: 'Rating detail. '.repeat(4)}))}));

function buildData(now, origin) {
  const at = days => new Date(now + days * DAY).toISOString();
  const courseId = name => COURSES.find(c => c.name === name).id;
  const assignments = new Map(COURSES.map(c => [c.id, []]));
  let nextId = 5000;
  const add = (course, {name, description = '', due_at = null, points = 10, types = ['online_upload'], submission = {workflow_state: 'unsubmitted'}}) => {
    const id = nextId++;
    const capstone = course === 106;
    assignments.get(course).push({id, name, description: capstone ? `${description}${CAPSTONE_INSTRUCTIONS}` : description, due_at,
      points_possible: points, submission_types: types, html_url: `${origin}/courses/${course}/assignments/${id}`,
      ...(capstone ? {rubric: capstoneRubric()} : {}), submission: {assignment_id: id, ...submission}});
  };
  // The Load demo set, as Canvas would return it (HTML descriptions; two link course files).
  const links = {'demo:cs-sprint-2': 9001, 'demo:eng-essay-draft': 9002};
  for (const a of demoAssignments(now)) {
    const file = links[a.id] ? ` <a href="${origin}/courses/${courseId(a.course)}/files/${links[a.id]}?wrap=1" data-api-endpoint="${origin}/api/v1/courses/${courseId(a.course)}/files/${links[a.id]}" data-api-returntype="File">attachment</a>` : '';
    add(courseId(a.course), {name: a.title, description: a.description ? `<p>${a.description}</p>${file}` : file,
      due_at: a.dueAt, points: a.points, types: a.submissionTypes});
  }
  // Work the collector must filter out: submitted, graded, pending review, excused.
  for (const course of [101, 102, 103, 104, 105]) {
    add(course, {name: 'Syllabus quiz', due_at: at(-30), submission: {workflow_state: 'graded', submitted_at: at(-31)}});
    add(course, {name: 'Week 2 homework', due_at: at(1), submission: {workflow_state: 'submitted', submitted_at: at(-1)}});
  }
  add(102, {name: 'Lab safety form', due_at: at(3), submission: {workflow_state: 'unsubmitted', excused: true}});
  add(103, {name: 'Reflection journal', due_at: at(-1), submission: {workflow_state: 'pending_review', submitted_at: at(-2)}});
  for (let n = 1; n <= CAPSTONE_EXTRA; n++) {
    add(106, {name: `Daily standup note ${n}`, due_at: at(-n - 3), points: 1, types: ['online_text_entry'],
      submission: {workflow_state: 'graded', submitted_at: at(-n - 3)}});
  }
  // Skipped courses still have open work, so a filtering bug would show up in the popup.
  for (const course of [201, 202, 203]) add(course, {name: 'Final paper', due_at: at(5)});
  add(204, {name: 'Time management worksheet', due_at: at(-240)});

  const courses = COURSES.map(c => ({id: c.id, name: c.name, workflow_state: 'available', course_code: c.name.split(' ').slice(0, 2).join(' '),
    end_at: null, concluded: Boolean(c.concluded),
    term: {name: c.termEnded ? 'Spring' : 'Fall', end_at: c.termEnded ? at(-120) : (c.stale ? null : at(75))}}));
  // Ended courses stay on the dashboard so the collector's date and concluded checks are what remove them.
  const dashboard = COURSES.filter(c => !c.offDashboard).map(c => ({id: String(c.id), shortName: c.name}));
  const files = {
    9001: {filename: 'starter_auth.py', type: 'text/x-python', body: 'def login(user, password):\n    raise NotImplementedError\n'},
    9002: {filename: 'essay_rubric.pdf', type: 'application/pdf', body: '%PDF-1.4\n% mock rubric\n'}
  };
  return {courses, dashboard, assignments, files};
}

// delayMs: added to every API response; slowCourseDelayMs: extra per assignment page for Capstone 1.
export function createMockCanvas({now = Date.now, delayMs = 150, slowCourseDelayMs = 1200} = {}) {
  return http.createServer(async (req, res) => {
    const origin = `http://${req.headers.host}`;
    const url = new URL(req.url, origin);
    const signedIn = (req.headers.cookie || '').includes(SESSION);
    const send = (status, body, headers = {}) => { res.writeHead(status, {'Cache-Control': 'no-store', ...headers}); res.end(body); };
    const json = (data, headers = {}) => send(200, `while(1);${JSON.stringify(data)}`, {'Content-Type': 'application/json; charset=utf-8', ...headers});
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    if (url.pathname === '/' || url.pathname === '/login') {
      return send(200, `<!doctype html><meta charset="utf-8"><title>Mock Canvas</title>
<body style="font:16px system-ui;max-width:640px;margin:40px auto">
<h1>Mock Canvas (demo)</h1><p>You are signed in as <b>Demo Student</b>. Click the Can Plan icon in the toolbar; it opens the planner and syncs automatically.</p>
<p>10 courses: 6 current (Capstone 1 is deliberately slow, with 3 pages of assignments) and 4 the extension should skip.</p>
<p><a href="/logout">Sign out</a> to test the signed-out error.</p></body>`,
        {'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': `${SESSION}; Path=/; HttpOnly; SameSite=Lax`});
    }
    if (url.pathname === '/logout') return send(302, '', {'Set-Cookie': 'mock_canvas_session=; Path=/; Max-Age=0', Location: '/signed-out'});
    if (url.pathname === '/signed-out') return send(200, '<!doctype html><title>Signed out</title><p>Signed out. <a href="/login">Sign in</a></p>', {'Content-Type': 'text/html'});

    const data = buildData(now(), origin);
    const download = url.pathname.match(/^\/files\/(\d+)\/download$/)?.[1];
    if (download) {
      if (!signedIn) return send(401, 'unauthorized');
      const file = data.files[download];
      return file ? send(200, file.body, {'Content-Type': file.type}) : send(404, 'not found');
    }
    if (!url.pathname.startsWith('/api/v1/')) return send(404, 'not found');
    await sleep(delayMs);
    if (!signedIn) return send(401, 'while(1);{"errors":[{"message":"user authorization required"}],"status":"unauthenticated"}', {'Content-Type': 'application/json'});

    // Paginates like Canvas: per_page (max 100), page, and a Link header with rel="next" when more remain.
    const paginate = rows => {
      const perPage = Math.min(Number(url.searchParams.get('per_page')) || 10, 100);
      const page = Math.max(Number(url.searchParams.get('page')) || 1, 1);
      const nextUrl = new URL(url); nextUrl.searchParams.set('page', String(page + 1));
      const more = page * perPage < rows.length;
      return json(rows.slice((page - 1) * perPage, page * perPage), more ? {Link: `<${nextUrl.href}>; rel="next"`} : {});
    };
    if (url.pathname === '/api/v1/courses') return paginate(data.courses);
    if (url.pathname === '/api/v1/dashboard/dashboard_cards') return json(data.dashboard);
    const courseAssignments = url.pathname.match(/^\/api\/v1\/courses\/(\d+)\/assignments$/)?.[1];
    if (courseAssignments) {
      const rows = data.assignments.get(Number(courseAssignments));
      if (!rows) return send(404, 'while(1);{"errors":[{"message":"The specified resource does not exist."}]}');
      if (Number(courseAssignments) === 106) await sleep(slowCourseDelayMs);
      // Canvas buckets: future (due later), overdue (past due, not submitted), undated; no bucket returns everything.
      const now_ = now(), bucket = url.searchParams.get('bucket');
      const open = a => !a.submission.submitted_at && a.submission.workflow_state === 'unsubmitted';
      const inBucket = {future: a => a.due_at && Date.parse(a.due_at) > now_, overdue: a => a.due_at && Date.parse(a.due_at) < now_ && open(a),
        undated: a => !a.due_at}[bucket] || (() => true);
      const excluded = url.searchParams.getAll('exclude_response_fields[]');
      const withSubmission = url.searchParams.getAll('include[]').includes('submission');
      return paginate(rows.filter(inBucket).map(({submission, ...rest}) => {
        const row = withSubmission ? {...rest, submission} : rest;
        for (const field of excluded) delete row[field];
        return row;
      }));
    }
    const fileId = url.pathname.match(/^\/api\/v1\/(?:courses\/\d+\/)?files\/(\d+)$/)?.[1];
    if (fileId && data.files[fileId]) {
      const file = data.files[fileId];
      return json({id: Number(fileId), display_name: file.filename, filename: file.filename, 'content-type': file.type,
        size: Buffer.byteLength(file.body), updated_at: new Date(now() - 7 * DAY).toISOString(), locked_for_user: false,
        url: `${origin}/files/${fileId}/download?download_frd=1`});
    }
    return send(404, 'while(1);{"errors":[{"message":"The specified resource does not exist."}]}');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_CANVAS_PORT || 8790);
  createMockCanvas({delayMs: Number(process.env.MOCK_CANVAS_DELAY_MS ?? 150), slowCourseDelayMs: Number(process.env.MOCK_CANVAS_SLOW_MS ?? 1200)})
    .listen(port, '127.0.0.1', () => console.log(`Mock Canvas: http://localhost:${port} (open it, then Sync from the extension)`));
}
