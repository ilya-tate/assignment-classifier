// Persist numeric diagnostics only; browser UI can still show course/assignment names.
const number=v=>Number.isFinite(v) && v>=0 ? v : 0;
export function sanitizeSyncReport(report) {
  const request=r=>({path:typeof r.path==='string' && /^\/api\/v1\/[a-zA-Z0-9_/:.-]+$/.test(r.path) ? r.path.replace(/\/\d+(?=\/|$)/g,'/:id') : 'unknown',
    bucket:['future','overdue','undated'].includes(r.bucket) ? r.bucket : null,page:number(Number(r.page)),
    ms:number(r.ms),status:number(r.status),bytes:number(r.bytes),headersMs:number(r.headersMs),bodyMs:number(r.bodyMs),parseMs:number(r.parseMs),
    outcome:['complete','running','timeout','http_or_parse_error','network_error'].includes(r.outcome) ? r.outcome : 'unknown'});
  const canvas=report.canvas;
  return {startedAt:Number.isFinite(Date.parse(report.startedAt)) ? new Date(report.startedAt).toISOString() : null,
    totalMs:number(report.totalMs),ok:report.ok===true,inferenceJobId:/^[a-f0-9-]{36}$/.test(report.inferenceJobId || '') ? report.inferenceJobId : null,
    range:report.range ? {includeCatchUp:report.range.includeCatchUp===true,overdueDays:number(report.range.overdueDays),daysAhead:report.range.daysAhead===null ? null : number(report.range.daysAhead)} : null,
    readFiles:report.readFiles===true,
    ...(Array.isArray(report.phases) ? {phases:report.phases.slice(0,100).map(p=>({phase:/^(Reading Canvas|Checking local server|Estimating \d+ assignments)$/.test(p.phase) ? p.phase : 'other',ms:number(p.ms),ok:p.ok===true}))} : {}),
    canvas:canvas ? {totalMs:number(canvas.totalMs),requestCount:number(canvas.requestCount),
      courses:(canvas.courses || []).slice(0,1000).map((c,index)=>({index:index+1,ms:number(c.ms),listMs:number(c.listMs),pages:number(c.pages),assignments:number(c.assignments),kept:number(c.kept),outcome:c.outcome==='read' ? 'read' : c.outcome?.startsWith('failed:') ? 'failed' : 'skipped'})),
      requests:(canvas.requests || []).slice(0,10000).map(request),slowestRequests:(canvas.slowestRequests || []).slice(0,15).map(request)} : null,
    counts:report.counts ? {assignments:number(report.counts.assignments),courses:number(report.counts.courses)} : null,
    progressEvents:Array.isArray(report.timeline) ? report.timeline.length : 0};
}
