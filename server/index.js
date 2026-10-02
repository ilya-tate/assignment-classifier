import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {validateAssignments, plan} from '../shared/contracts.js';
import {estimateAssignment} from './inference.js';

export function createServer({env=process.env,estimate=estimateAssignment}={}) {
  return http.createServer(async (req,res) => {
    const origin = req.headers.origin;
    const configured = (env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
    const allowed = origin && (configured.length ? configured.includes(origin) : /^chrome-extension:\/\/[a-p]{32}$/.test(origin));
    const send = (code,data) => {res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    if (origin && !allowed) return send(403,{error:'Origin denied'});
    if (allowed) {res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
    if (req.method === 'OPTIONS') {res.setHeader('Access-Control-Allow-Methods','POST, GET');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.writeHead(204);return res.end();}
    if (req.method === 'GET' && req.url === '/health') return send(200,{ok:true,provider:env.INFERENCE_PROVIDER || 'mock'});
    if (req.method !== 'POST' || req.url !== '/api/estimate') return send(404,{error:'Not found'});
    if (!req.headers['content-type']?.startsWith('application/json')) return send(415,{error:'Use application/json'});
    let assignments;
    try {
      const chunks=[];let size=0;
      for await (const chunk of req) {size+=chunk.length;if(size>1500000) {send(413,{error:'Request too large'});return;}chunks.push(chunk);}
      assignments=validateAssignments(JSON.parse(Buffer.concat(chunks).toString()).assignments);
    } catch {return send(400,{error:'Invalid assignment payload'});}
    try {
      // Sequential requests bound concurrency. Results only reach the browser as a complete batch.
      const output=[];
      for (const a of assignments) {const e=await estimate(a,{env});output.push(plan(a,e,e.provider));}
      send(200,{assignments:output});
    } catch {send(502,{error:'Inference failed. Check server configuration, model access, or reduce the batch size.'});}
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port=Number(process.env.PORT || 8787);
  createServer().listen(port,'127.0.0.1',() => console.log(`Assignment API: http://localhost:${port} (${process.env.INFERENCE_PROVIDER || 'mock'})`));
}
