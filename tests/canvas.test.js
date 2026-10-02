import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const origin = 'https://canvas.test';
const day = 86400000, soon = new Date(Date.now() + day).toISOString();
const files = {
  101: {filename: 'brief.docx', updated_at: '2026-09-01T00:00:00Z', body: Buffer.from('PK docx bytes')}, 102: {filename: 'data.csv', body: Buffer.from('name,score\nAda,10\n')},
  103: {filename: 'starter.py', body: Buffer.from('def solve():\n    pass\n')}, 104: {filename: 'diagram.png', body: Buffer.from('png')},
  105: {filename: 'reading.pdf', updated_at: '2026-09-02T00:00:00Z', body: Buffer.from('%PDF-1.4')}, 106: {filename: 'huge.csv', size: 200 * 1024, body: Buffer.from('a,b')},
  107: {filename: 'data.ipynb', body: Buffer.from(JSON.stringify({cells: [{cell_type: 'markdown', source: ['# Lab ', '2']}, {cell_type: 'code', source: 'x = 1'}]}))},
  108: {filename: 'blocked.txt', blocked: true, body: Buffer.from('nope')}
};
const link = id => `<a href="${origin}/courses/1/files/${id}?wrap=1">file</a>`;
const assignments = [
  {id: 1, name: 'Essay', due_at: soon, description: `<p>See files</p>${[101, 102, 103, 104, 105].map(link).join('')}`},
  {id: 2, name: 'Lab', due_at: soon, description: `${link(105)}${link(106)}${link(107)}<img src="/courses/1/files/107/preview">${link(108)}<a href="https://elsewhere.test/files/999">x</a>`}
];

async function collect(store = new Map(), options = {readFiles: true}) {
  const requested = [];
  let downloads = 0;
  const fetch = async (input) => {
    const url = new URL(String(input));
    requested.push(url.pathname);
    const json = data => new Response('while(1);' + JSON.stringify(data));
    if (url.pathname === '/api/v1/courses') return json([{id: 1, name: 'English', workflow_state: 'available'}]);
    if (url.pathname === '/api/v1/dashboard/dashboard_cards') return json([{id: '1'}]);
    if (url.pathname === '/api/v1/courses/1/assignments') return json(assignments);
    const meta = url.pathname.match(/^\/api\/v1\/files\/(\d+)$/)?.[1];
    if (meta) { const f = files[meta]; return json({display_name: f.filename, filename: f.filename, updated_at: f.updated_at, 'content-type': f.filename.endsWith('.pdf') ? 'application/pdf' : '', size: f.size ?? f.body.length, url: `${origin}/files/${meta}/download`}); }
    const download = url.pathname.match(/^\/files\/(\d+)\/download$/)?.[1];
    if (download) { downloads++; if (files[download].blocked) throw new TypeError('Failed to fetch'); return new Response(files[download].body); }
    return new Response('not found', {status: 404});
  };
  // Stands in for the background worker's IndexedDB store.
  const chrome = {runtime: {sendMessage: async message => {
    if (message.type === 'FILE_HAS') return {ok: true, has: store.get(message.key)?.version === message.version};
    if (message.type === 'FILE_SAVE') { store.set(message.file.key, {...message.file, owners: [...(store.get(message.file.key)?.owners || []), message.owner.assignmentId]}); return {ok: true}; }
    if (message.type === 'FILE_LINK') { const f = store.get(message.key); if (f && !f.owners.includes(message.owner.assignmentId)) f.owners.push(message.owner.assignmentId); return {ok: true, linked: Boolean(f)}; }
  }}};
  const DOMParser = class { parseFromString(html) { return {body: {textContent: html.replace(/<[^>]+>/g, '')}}; } };
  const context = vm.createContext({fetch, chrome, DOMParser, location: new URL(origin + '/courses'), URL, Response, TextDecoder, AbortSignal, btoa});
  vm.runInContext(await readFile(new URL('../extension/canvas.js', import.meta.url), 'utf8'), context);
  // JSON round trip copies sandbox objects into this realm so strict deep equality works.
  return {result: JSON.parse(JSON.stringify(await context.collectCanvasAssignments(options))), store, downloads, requested};
}

test('collector reads text attachments, saves documents, and skips images, oversized, blocked and foreign files', async () => {
  const {result, store, downloads} = await collect();
  assert.equal(result.ok, true, result.error);
  const [essay, lab] = result.assignments;
  assert.deepEqual(essay.attachments, [{name: 'data.csv', text: 'name,score\nAda,10'}, {name: 'starter.py', text: 'def solve():\n    pass'}]);
  assert.deepEqual(lab.attachments, [{name: 'data.ipynb', text: '[markdown]\n# Lab 2\n\n[code]\nx = 1'}]);
  assert.deepEqual(result.skipped.files, ['diagram.png: unsupported type .png', 'huge.csv: larger than 100 KB', 'blocked.txt: download blocked']);
  // reading.pdf is linked from both assignments: stored once, linked twice.
  assert.deepEqual(result.documents, {saved: 2, current: 0, links: 3});
  assert.equal(downloads, 6);
  const pdf = store.get('canvas.test:105');
  assert.deepEqual({name: pdf.name, contentType: pdf.contentType, version: pdf.version, owners: pdf.owners},
    {name: 'reading.pdf', contentType: 'application/pdf', version: '2026-09-02T00:00:00Z', owners: ['canvas.test:1:1', 'canvas.test:1:2']});
  assert.equal(Buffer.from(pdf.data, 'base64').toString(), '%PDF-1.4');
  assert.deepEqual(store.get('canvas.test:101').owners, ['canvas.test:1:1']);
  assert.equal(Buffer.from(store.get('canvas.test:101').data, 'base64').toString(), 'PK docx bytes');
});
test('re-sync skips documents already saved at the same Canvas version', async () => {
  const {store, downloads: first} = await collect();
  const {result, downloads: second} = await collect(store);
  assert.deepEqual(result.documents, {saved: 0, current: 2, links: 3});
  assert.equal(first - second, 2);
});
test('sync skips linked files entirely unless file reading is enabled', async () => {
  const {result, store, downloads, requested} = await collect(new Map(), {});
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.assignments.map(a => a.attachments), [[], []]);
  assert.equal(downloads, 0); assert.equal(store.size, 0);
  assert.equal(requested.some(path => path.includes('/files/')), false);
});
test('assignment range keeps past-due work within overdueDays and upcoming work within daysAhead', async () => {
  const day = 86400000, at = offset => new Date(Date.now() + offset * day).toISOString();
  const rows = [{id: 1, name: 'old', due_at: at(-20)}, {id: 2, name: 'recent', due_at: at(-3)}, {id: 3, name: 'soon', due_at: at(5)},
    {id: 4, name: 'far', due_at: at(40)}, {id: 5, name: 'undated', due_at: null}];
  const saved = assignments.splice(0, assignments.length, ...rows);
  try {
    const titles = async options => (await collect(new Map(), options)).result.assignments.map(a => a.title);
    assert.deepEqual(await titles({overdueDays: 7, daysAhead: 30}), ['recent', 'soon', 'undated']);
    assert.deepEqual(await titles({overdueDays: 0, daysAhead: null}), ['soon', 'far', 'undated']);
    const {result} = await collect(new Map(), {overdueDays: 7, daysAhead: 30});
    assert.deepEqual({pastDue: result.skipped.pastDue, tooFar: result.skipped.tooFar}, {pastDue: 1, tooFar: 1});
  } finally { assignments.splice(0, assignments.length, ...saved); }
});
