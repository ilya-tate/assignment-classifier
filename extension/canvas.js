// Executed only after a user clicks Sync on their active Canvas tab.
// overdueDays: how many days past due an unsubmitted assignment is still kept (0 = drop all past-due work).
// readFiles: also read/save files linked from descriptions (off by default; file handling is planned for the AI step).
async function collectCanvasAssignments({overdueDays = 0, readFiles = false} = {}) {
  const cutoff = Date.now() - overdueDays * 86400000;
  const DONE_STATES = new Set(['submitted', 'graded', 'pending_review']);
  const isCompleted = s => Boolean(s && (DONE_STATES.has(s.workflow_state) || s.submitted_at || s.excused));
  const text = html => new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();
  async function getJson(url) {
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/v1/')) throw new Error('Invalid Canvas API URL');
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
    try { return {data: JSON.parse(body), response}; } catch { throw new Error('This tab is not a Canvas site (API returned non-JSON).'); }
  }
  async function pages(path) {
    let next = new URL(path, location.origin).href;
    const rows = [];
    while (next) {
      const {data, response} = await getJson(new URL(next));
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
  // ---- Attachments: plain-text files linked from the description (code, data, notes) are passed to the model;
  // documents (PDF, DOCX, ...) are saved in the extension's browser storage instead and never sent to the server. ----
  const MAX_FILES = 5, MAX_FILE_CHARS = 4000, MAX_ASSIGNMENT_CHARS = 8000;
  const TEXT_BYTES = 100 * 1024, DOC_BYTES = 25 * 1024 * 1024;
  const DOC_TYPES = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'doc', 'ppt', 'rtf', 'odt']);
  const TEXT_TYPES = new Set(('csv tsv json xml yaml yml txt md html htm py java c h cpp cc hpp cs go rs rb php swift kt scala dart lua pl ' +
    'js mjs ts jsx tsx css scss r rmd jl m sql ipynb hs ml ex asm s v sv vhd sh bash ps1 tex toml ini cfg log').split(' '));
  const extOf = name => (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  function plainText(ext, raw) {
    if (raw.includes('\u0000')) throw new Error('binary content');
    if (ext === 'html' || ext === 'htm') return text(raw);
    if (ext === 'ipynb') return (JSON.parse(raw).cells || []).map(c => `[${c.cell_type}]\n${[].concat(c.source || []).join('')}`).join('\n\n');
    return raw;
  }
  // Same-origin Canvas file IDs linked from the description (links, embeds, or API endpoints).
  function linkedFileIds(html) {
    const ids = [];
    for (const [, value] of (html || '').matchAll(/(?:href|src|data-api-endpoint)="([^"]+)"/g)) {
      let url;
      try { url = new URL(value.replace(/&amp;/g, '&'), location.origin); } catch { continue; }
      const id = url.origin === location.origin && url.pathname.match(/\/files\/(\d+)/)?.[1];
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids.slice(0, 10);
  }
  const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;
  // Streams the body so large downloads can report progress (at most every 500 ms) and stop early past the limit.
  async function download(file, limit, onProgress = () => {}) {
    const response = await fetch(file.url, {credentials: 'same-origin', signal: AbortSignal.timeout(120000)});
    if (!response.ok) throw new Error(`download returned ${response.status}`);
    const total = Number(response.headers.get('Content-Length')) || file.size || 0;
    const reader = response.body.getReader(), chunks = [];
    let received = 0, reported = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      received += value.length;
      if (received > limit) { await reader.cancel(); throw new Error(`larger than ${limit / 1024} KB`); }
      chunks.push(value);
      if (Date.now() - reported > 500) { reported = Date.now(); onProgress(received, total); }
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes.buffer;
  }
  // One download per Canvas file per sync, shared by every assignment (and parallel course worker) that links it.
  const fileSaves = new Map();
  async function send(message) {
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply?.ok) throw new Error(reply?.error || 'extension storage unavailable');
    return reply;
  }
  async function saveDocument(file, name, owner, documents, say) {
    if (file.size > DOC_BYTES) throw new Error(`larger than ${DOC_BYTES / 1048576} MB`);
    if (file.locked_for_user || !file.url) throw new Error('locked');
    const key = `${location.host}:${file.id}`;
    const first = !fileSaves.has(key);
    if (first) fileSaves.set(key, storeOnce(file, key, name, owner, documents, say));
    else say(`${name}: same file as another assignment, saving once`);
    // A fresh save records its own assignment; every other assignment (or an already-stored file) is added as a link.
    const storedWithOwner = await fileSaves.get(key);
    if (!(first && storedWithOwner)) await send({type: 'FILE_LINK', key, owner});
    documents.links++;
  }
  // Resolves true when this call stored the file with `owner` attached, false when it already existed.
  async function storeOnce(file, key, name, owner, documents, say) {
    const version = String(file.updated_at || file.size);
    if ((await send({type: 'FILE_HAS', key, version})).has) { documents.current++; say(`${name}: already saved`); return false; }
    say(`${name}: downloading${file.size ? ` (${mb(file.size)})` : ''}`);
    const bytes = new Uint8Array(await download(file, DOC_BYTES, (got, total) =>
      say(`${name}: downloading ${mb(got)}${total ? ` of ${mb(total)} (${Math.round(got / total * 100)}%)` : ''}`)));
    say(`${name}: saving ${mb(bytes.length)}`);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await send({type: 'FILE_SAVE', owner, file: {key, fileId: String(file.id), version, name, contentType: file['content-type'] || '', data: btoa(binary)}});
    documents.saved++;
    return true;
  }
  // owner: {assignmentId, course, assignment} labels saved documents so the popup can list them per assignment.
  // report(text) updates this course's live progress line.
  async function readAttachments(html, skippedFiles, owner, documents, report) {
    const attachments = [];
    let budget = MAX_ASSIGNMENT_CHARS;
    const ids = linkedFileIds(html);
    for (const [index, id] of ids.entries()) {
      let name = `file ${id}`;
      const say = text => report(`${owner.assignment} · file ${index + 1}/${ids.length} · ${text}`);
      try {
        say(`${name}: checking`);
        const {data: file} = await getJson(new URL(`/api/v1/files/${id}`, location.origin));
        name = file.display_name || file.filename || name;
        const ext = extOf(file.filename || name);
        if (DOC_TYPES.has(ext)) { await saveDocument({...file, id}, name.slice(0, 255), owner, documents, say); continue; }
        if (!TEXT_TYPES.has(ext)) throw new Error(`unsupported type .${ext || '?'}`);
        if (attachments.length >= MAX_FILES || budget <= 0) throw new Error('attachment text limit reached');
        if (file.size > TEXT_BYTES) throw new Error(`larger than ${TEXT_BYTES / 1024} KB`);
        if (file.locked_for_user || !file.url) throw new Error('locked');
        say(`${name}: reading text`);
        const buffer = await download(file, TEXT_BYTES);
        const content = plainText(ext, new TextDecoder().decode(buffer)).trim();
        if (!content) throw new Error('no readable text');
        const clipped = content.slice(0, Math.min(MAX_FILE_CHARS, budget));
        budget -= clipped.length;
        attachments.push({name: name.slice(0, 255), text: clipped});
      } catch (error) {
        // Cross-origin file storage without CORS shows up here as a network TypeError.
        skippedFiles.push(`${name}: ${error.name === 'TypeError' ? 'download blocked' : error.message}`);
      }
    }
    return attachments;
  }
  // Progress goes to the popup so a slow sync shows where it is. Ignore failures if the popup closed.
  // With a course, the text replaces that course's line in the popup's live list; without one, it updates the summary.
  const progress = (text, course) => chrome.runtime.sendMessage({type: 'CANVAS_PROGRESS', text, course}).catch(() => {});
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
    const documents = {saved: 0, current: 0, links: 0};
    const skipped = {completed: 0, pastDue: 0, files: [], endedCourses: available.length - courses.length, endedCourseNames: available.filter(c => !courses.includes(c)).map(c => c.name)};
    const kept = [];
    // A course whose latest due date is over a semester (~6 months) old is treated as over even if Canvas says otherwise.
    const STALE_MS = 182 * 86400000;
    let done = 0;
    progress(`found ${courses.length} current courses (${skipped.endedCourses} ended)`);
    // Read a few courses at a time; one slow course should not serialize the whole sync.
    const queue = [...courses];
    async function worker() {
      for (let course; (course = queue.shift());) {
        const report = text => progress(text, course.name);
        report('loading assignment list');
        let rows;
        try { rows = await pages(`/api/v1/courses/${course.id}/assignments?per_page=100&include[]=submission`); }
        catch (error) { throw new Error(`${course.name}: ${error.message}`); }
        const lastDue = Math.max(...rows.filter(a => a.due_at).map(a => Date.parse(a.due_at)));
        if (Number.isFinite(lastDue) && lastDue < Date.now() - STALE_MS) {
          skipped.endedCourses++; skipped.endedCourseNames.push(course.name);
          report('skipped: no recent assignments');
          progress(`${++done}/${courses.length} courses read`);
          continue;
        }
        kept.push(course.name);
        for (const [index, a] of rows.entries()) {
          if (isCompleted(a.submission)) { skipped.completed++; continue; }
          // Undated assignments are kept; the planner shows them without a start time.
          if (a.due_at && Date.parse(a.due_at) < cutoff) { skipped.pastDue++; continue; }
          const id = `${location.host}:${course.id}:${a.id}`;
          report(`assignment ${index + 1}/${rows.length} · ${a.name}`);
          assignments.push({id, title: a.name,
            course: course.name, description: text(a.description).slice(0, 12000),
            dueAt: a.due_at || null, points: a.points_possible || 0,
            submissionTypes: a.submission_types || [], url: a.html_url,
            attachments: readFiles ? await readAttachments(a.description, skipped.files, {assignmentId: id, course: course.name, assignment: a.name}, documents, report) : []});
        }
        report(`✓ done (${rows.length} assignments)`);
        progress(`${++done}/${courses.length} courses read`);
      }
    }
    await Promise.all(Array.from({length: Math.min(4, courses.length)}, worker));
    return {ok: true, assignments, skipped, documents, courses: kept};
  } catch (error) { return {ok: false, error: error.message}; }
}
