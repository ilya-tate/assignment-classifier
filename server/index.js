import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {pathToFileURL, fileURLToPath} from 'node:url';
import path from 'node:path';
import {validateAssignments, byDueDate} from '../shared/contracts.js';
import {estimateAssignment, estimateAssignments} from './inference.js';
import {batchSizeFromEnv} from './groups.js';
import {inferenceConfig} from './config.js';
import {startBatch} from './batch.js';
import {sanitizeSyncReport} from './sync-report.js';

// Groups a synced batch the same way the popup does: past-due work is Catch Up, everything else is Upcoming.
export function summarize(assignments, now=Date.now()) {
  const view = a => ({course:a.course,title:a.title,description:a.description,dueDate:a.dueAt,attachments:a.attachments || []});
  const sorted = [...assignments].sort(byDueDate);
  const overdue = a => a.dueAt && Date.parse(a.dueAt) < now;
  return {catchUp:sorted.filter(overdue).map(view),upcoming:sorted.filter(a => !overdue(a)).map(view)};
}

// Sync reports (bottleneck diagnostics) are written here, one JSON file per sync. The folder is gitignored.
const DEFAULT_REPORT_DIR = fileURLToPath(new URL('../sync-logs/', import.meta.url));

export function createServer({env=process.env,estimate=estimateAssignment,estimateMany=estimate===estimateAssignment ? estimateAssignments : undefined}={}) {
  const {provider} = inferenceConfig(env);
  batchSizeFromEnv(env); // Fail invalid configuration at startup, before accepting jobs.
  const hosted = !['127.0.0.1', 'localhost', '::1'].includes(env.HOST || '127.0.0.1');
  const accessKey = env.API_ACCESS_KEY || '';
  const configured = (env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
  if (hosted && (accessKey.length < 32 || !configured.length || configured.some(s=>!/^chrome-extension:\/\/[a-p]{32}$/.test(s)))) {
    throw new Error('Hosted mode requires API_ACCESS_KEY (32+ characters) and explicit chrome-extension:// ALLOWED_ORIGINS');
  }
  // Hosted deployments keep diagnostics in stdout only; no student payloads are persisted.
  const reportDir = hosted ? null : (env.SYNC_LOG_DIR || DEFAULT_REPORT_DIR);
  const requestLimit = Number(env.API_REQUESTS_PER_MINUTE || 240);
  const estimateLimit = Number(env.API_ESTIMATES_PER_HOUR || 6);
  if (![requestLimit, estimateLimit].every(n=>Number.isSafeInteger(n) && n>0)) throw new Error('Invalid API rate limits');
  const windows = new Map();
  function limited(key, limit, duration) {
    const now=Date.now();
    let window=windows.get(key);
    if (!window || now>=window.until) {window={until:now+duration,count:0};windows.set(key,window);}
    return ++window.count>limit;
  }
  const retentionMs=15*60*1000;
  // Timing of the most recent estimate batch, attached to the next sync report.
  let lastEstimate = null;
  // Latest synced batch, in memory only: never written to disk and gone when the server stops.
  let latest = [];
  let syncedAt = null;
  const jobs=new Map();
  const cleanup=setInterval(()=>{
    if (hosted && syncedAt && Date.now()-Date.parse(syncedAt)>retentionMs) {latest=[];syncedAt=null;}
    for(const [id,job] of jobs) {
      if(job.report.status==='running' && Date.now()-job.lastPoll>60000) job.cancel();
      if (hosted && Date.now()-Date.parse(job.report.at)>retentionMs) {job.cancel();jobs.delete(id);}
      else if(job.report.status!=='running' && Date.now()-job.lastPoll>900000) jobs.delete(id);
    }
  },10000);cleanup.unref();
  const serverInstance=http.createServer(async (req,res) => {
    const origin = req.headers.origin;
    const allowed = origin && (configured.length ? configured.includes(origin) : /^chrome-extension:\/\/[a-p]{32}$/.test(origin));
    const send = (code,data,space) => {res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data,null,space));};
    if (origin && !allowed) return send(403,{error:'Origin denied'});
    if (allowed) {res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
    if (req.method === 'OPTIONS') {res.setHeader('Access-Control-Allow-Methods','POST, GET, DELETE');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.writeHead(204);return res.end();}
    if (req.method === 'GET' && req.url === '/health') return send(200,{ok:true,provider});
    if (accessKey) {
      const actual=Buffer.from(req.headers.authorization || '');
      const expected=Buffer.from(`Bearer ${accessKey}`);
      if (actual.length!==expected.length || !timingSafeEqual(actual,expected)) return send(401,{error:'Invalid or missing API access key'});
    }
    if (hosted && limited('requests',requestLimit,60000)) {res.setHeader('Retry-After','60');return send(429,{error:'API request limit reached; retry in one minute'});}
    if (req.method === 'GET' && (req.url === '/' || req.url === '/assignments')) {
      // Only serve student data to loopback hostnames, which blocks DNS-rebinding pages from reading it.
      if (!hosted && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(403,{error:'Host denied'});
      return send(200,{syncedAt,...summarize(latest)},2);
    }
    const jobPath=req.url?.match(/^\/api\/estimate-jobs\/([a-f0-9-]{36})$/);
    if(jobPath && ['GET','DELETE'].includes(req.method)) {
      if(!hosted && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(403,{error:'Host denied'});
      const job=jobs.get(jobPath[1]);if(!job) return send(404,{error:'Inference job expired or server restarted'});
      job.lastPoll=Date.now();
      if(req.method==='DELETE') {job.cancel();return send(200,{cancelled:true});}
      return send(200,{jobId:job.id,status:job.report.status,completed:job.report.count,total:job.report.requested,
        elapsedMs:Date.now()-Date.parse(job.report.at),error:job.error,diagnostics:job.report,
        ...(job.results ? {assignments:job.results} : {})});
    }
    if (req.method !== 'POST' || !['/api/estimate','/api/estimate-jobs','/api/sync-report'].includes(req.url)) return send(404,{error:'Not found'});
    if (hosted && ['/api/estimate','/api/estimate-jobs'].includes(req.url) && limited('estimates',estimateLimit,3600000)) {
      res.setHeader('Retry-After','3600');return send(429,{error:'Estimate limit reached; retry in one hour'});
    }
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
      if (hosted) return send(200,{saved:false});
      const startedAt = Date.parse(report.startedAt);
      // Server-side estimate timing belongs to this sync only if the batch ran after the sync started.
      const matched=report.inferenceJobId ? jobs.get(report.inferenceJobId)?.report : lastEstimate;
      const server = {provider, estimate: matched && (!Number.isFinite(startedAt) || Date.parse(matched.at) >= startedAt) ? matched : null};
      const name = `sync-${new Date().toISOString().replace(/[:.]/g,'-')}-${Math.random().toString(36).slice(2,6)}.json`;
      try {
        await mkdir(reportDir,{recursive:true});
        await writeFile(path.join(reportDir,name),JSON.stringify({...sanitizeSyncReport(report),server},null,2));
      } catch (error) {console.error(`Sync report not saved: ${error.message}`);return send(500,{error:'Could not write sync report'});}
      return send(200,{file:path.relative(process.cwd(),path.join(reportDir,name)) || name});
    }
    let assignments;
    try {
      assignments=validateAssignments(body?.assignments);
      // Stored before inference so the scraped data is viewable even if the model call fails.
      latest=assignments;syncedAt=new Date().toISOString();
    } catch (error) {return send(400,{error:`Invalid assignment payload: ${error.message}`});}
    if(lastEstimate?.status==='running') return send(409,{error:'An inference batch is already running; wait for it to finish or cancel it.'});
    const job=startBatch(assignments,{env,estimate,estimateMany,reportDir});
    lastEstimate=job.report;
    if(req.url==='/api/estimate-jobs') {
      jobs.set(job.id,job);
      return send(202,{jobId:job.id,logFile:job.report.logFile});
    }
    // Compatibility endpoint for tests and direct API callers; cancel on disconnect.
    res.once('close',()=>{if(!res.writableEnded) job.cancel();});
    await job.done;
    if(job.report.status==='complete') send(200,{assignments:job.results,diagnostics:job.report});
    else send(502,{error:job.error,diagnostics:job.report});
  });
  serverInstance.on('close',()=>{clearInterval(cleanup);for(const job of jobs.values())job.cancel();});
  return serverInstance;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port=Number(process.env.PORT || 8787);
  const host=process.env.HOST || '127.0.0.1';
  createServer().listen(port,host,() => console.log(`Assignment API listening on ${host}:${port} (${inferenceConfig().provider})`));
}
