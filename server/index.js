import http from 'node:http';
import {mkdir, writeFile} from 'node:fs/promises';
import {pathToFileURL, fileURLToPath} from 'node:url';
import path from 'node:path';
import {validateAssignments, plan, byDueDate} from '../shared/contracts.js';
import {estimateAssignment} from './inference.js';
import {inferenceConfig} from './config.js';

// Groups a synced batch the same way the popup does: past-due work is Catch Up, everything else is Upcoming.
export function summarize(assignments, now=Date.now()) {
  const view = a => ({course:a.course,title:a.title,description:a.description,dueDate:a.dueAt,attachments:a.attachments || []});
  const sorted = [...assignments].sort(byDueDate);
  const overdue = a => a.dueAt && Date.parse(a.dueAt) < now;
  return {catchUp:sorted.filter(overdue).map(view),upcoming:sorted.filter(a => !overdue(a)).map(view)};
}

// Sync reports (bottleneck diagnostics) are written here, one JSON file per sync. The folder is gitignored.
const DEFAULT_REPORT_DIR = fileURLToPath(new URL('../sync-logs/', import.meta.url));

export function createServer({env=process.env,estimate=estimateAssignment}={}) {
  const {provider} = inferenceConfig(env);
  const reportDir = env.SYNC_LOG_DIR || DEFAULT_REPORT_DIR;
  // Timing of the most recent estimate batch, attached to the next sync report.
  let lastEstimate = null;
  // Latest synced batch, in memory only: never written to disk and gone when the server stops.
  let latest = [];
  let syncedAt = null;
  return http.createServer(async (req,res) => {
    const origin = req.headers.origin;
    const configured = (env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
    const allowed = origin && (configured.length ? configured.includes(origin) : /^chrome-extension:\/\/[a-p]{32}$/.test(origin));
    const send = (code,data,space) => {res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data,null,space));};
    if (origin && !allowed) return send(403,{error:'Origin denied'});
    if (allowed) {res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
    if (req.method === 'OPTIONS') {res.setHeader('Access-Control-Allow-Methods','POST, GET');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.writeHead(204);return res.end();}
    if (req.method === 'GET' && req.url === '/health') return send(200,{ok:true,provider});
    if (req.method === 'GET' && (req.url === '/' || req.url === '/assignments')) {
      // Only serve student data to loopback hostnames, which blocks DNS-rebinding pages from reading it.
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(403,{error:'Host denied'});
      return send(200,{syncedAt,...summarize(latest)},2);
    }
    if (req.method !== 'POST' || (req.url !== '/api/estimate' && req.url !== '/api/sync-report')) return send(404,{error:'Not found'});
    if (!req.headers['content-type']?.startsWith('application/json')) return send(415,{error:'Use application/json'});
    let body;
    {
      const chunks=[];let size=0;
      for await (const chunk of req) {size+=chunk.length;if(size>4000000) {send(413,{error:'Request too large'});return;}chunks.push(chunk);}
      try {body=JSON.parse(Buffer.concat(chunks).toString());} catch {return send(400,{error:'Request body is not valid JSON'});}
    }
    if (req.url === '/api/sync-report') {
      const report = body?.report;
      if (!report || typeof report !== 'object' || Array.isArray(report)) return send(400,{error:'Expected {report: object}'});
      const startedAt = Date.parse(report.startedAt);
      // Server-side estimate timing belongs to this sync only if the batch ran after the sync started.
      const server = {provider, estimate: lastEstimate && (!Number.isFinite(startedAt) || Date.parse(lastEstimate.at) >= startedAt) ? lastEstimate : null};
      const name = `sync-${new Date().toISOString().replace(/[:.]/g,'-')}-${Math.random().toString(36).slice(2,6)}.json`;
      try {
        await mkdir(reportDir,{recursive:true});
        await writeFile(path.join(reportDir,name),JSON.stringify({...report,server},null,2));
      } catch (error) {console.error(`Sync report not saved: ${error.message}`);return send(500,{error:'Could not write sync report'});}
      return send(200,{file:path.relative(process.cwd(),path.join(reportDir,name)) || name});
    }
    let assignments;
    try {
      assignments=validateAssignments(body?.assignments);
      // Stored before inference so the scraped data is viewable even if the model call fails.
      latest=assignments;syncedAt=new Date().toISOString();
    } catch (error) {return send(400,{error:`Invalid assignment payload: ${error.message}`});}
    try {
      // Sequential requests bound concurrency. Results only reach the browser as a complete batch.
      const output=[], times=[], started=Date.now();
      for (const a of assignments) {
        const t=Date.now();const e=await estimate(a,{env});times.push(Date.now()-t);output.push(plan(a,e,e.provider));
      }
      lastEstimate={at:new Date(started).toISOString(),count:times.length,totalMs:Date.now()-started,
        avgMs:times.length ? Math.round(times.reduce((x,y)=>x+y,0)/times.length) : 0,maxMs:Math.max(0,...times)};
      send(200,{assignments:output});
    } catch (error) {
      // Error messages come from our own adapter code (status codes, config problems), never payloads or tokens.
      console.error(`Inference failed: ${error.message}`);
      send(502,{error:'Inference failed. Check the server terminal for details, model access, or reduce the batch size.'});
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port=Number(process.env.PORT || 8787);
  createServer().listen(port,'127.0.0.1',() => console.log(`Assignment API: http://localhost:${port} (${inferenceConfig().provider})`));
}
