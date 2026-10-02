import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {estimateAssignment,parseModelOutput,InferenceError} from '../server/inference.js';
import {startBatch} from '../server/batch.js';
import {createServer} from '../server/index.js';
import {sanitizeSyncReport} from '../server/sync-report.js';
const a={id:'private-id',title:'private-title',course:'private-course',description:'private-description',dueAt:null,points:10,submissionTypes:[],attachments:[]};
const env={INFERENCE_PROVIDER:'snowflake',SNOWFLAKE_ACCOUNT_URL:'https://test.snowflakecomputing.com',SNOWFLAKE_TOKEN:'private-token',SNOWFLAKE_MODEL:'llama3.1-8b'};
const result={estimatedMinutes:30,reason:'test'};
async function directory(t) {const dir=await mkdtemp(path.join(os.tmpdir(),'inference-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('model parsing accepts one fence, rejects prose, invalid schema and empty content',()=>{
  assert.deepEqual(parseModelOutput('```json\n'+JSON.stringify(result)+'\n```'),result);
  assert.deepEqual(parseModelOutput(JSON.stringify(result)),result);
  for(const [value,code] of [['Here is your result: '+JSON.stringify(result),'MODEL_JSON_INVALID'],['{"estimatedMinutes":-1,"reason":"test"}','MODEL_SCHEMA_INVALID'],[null,'EMPTY_CONTENT']]) {
    assert.throws(()=>parseModelOutput(value),e=>e.code===code);
  }
});
test('diagnostics expose structure, token usage and request IDs without response or prompt content',async()=>{
  const events=[];
  const value=await estimateAssignment(a,{env,onDiagnostic:(event,fields)=>events.push({event,...fields}),fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);assert.equal(body.max_completion_tokens,512);assert.equal(body.temperature,0);
    assert.equal(options.headers['X-Snowflake-Authorization-Token-Type'],'PROGRAMMATIC_ACCESS_TOKEN');
    return Response.json({request_id:'1234-abcd',usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120},choices:[{finish_reason:'stop',message:{content:'```json\n'+JSON.stringify(result)+'\n```'}}]});
  }});
  assert.equal(value.estimatedMinutes,30);
  const body=events.find(e=>e.event==='snowflake_body');assert.equal(body.fenced,true);assert.equal(body.totalTokens,120);assert.equal(body.requestId,'1234-abcd');
  assert.doesNotMatch(JSON.stringify(events),/private-|estimatedMinutes|"reason"/);
});
test('truncation, malformed HTTP bodies, upstream errors and cancellation are distinguishable',async()=>{
  const invoke=fetchImpl=>estimateAssignment(a,{env,fetchImpl});
  await assert.rejects(invoke(async()=>Response.json({choices:[{finish_reason:'length',message:{content:'{"estimated'}}]})),e=>e.code==='OUTPUT_TRUNCATED');
  await assert.rejects(invoke(async()=>new Response('<html>error</html>')),e=>e.code==='HTTP_JSON_INVALID');
  await assert.rejects(invoke(async()=>Response.json({message:'private-token'},{status:400})),e=>e.code==='HTTP_400');
  const controller=new AbortController();controller.abort();
  await assert.rejects(estimateAssignment(a,{env,signal:controller.signal,fetchImpl:async(url,options)=>{options.signal.throwIfAborted();}}),e=>e.code==='CANCELLED');
});
test('batch bounds concurrency, retains input order and writes safe per-assignment diagnostics',async(t)=>{
  const reportDir=await directory(t);let active=0,max=0;
  const estimate=async(assignment)=>{active++;max=Math.max(active,max);await new Promise(r=>setTimeout(r,10));active--;return {...result,estimatedMinutes:Number(assignment.id),provider:'mock'};};
  const job=startBatch(Array.from({length:46},(_,i)=>({...a,id:String(i+5)})),{env:{},estimate,reportDir});
  await job.done;
  assert.equal(max,3);assert.equal(job.report.count,46);assert.equal(job.report.status,'complete');
  assert.deepEqual(job.results.map(a=>a.estimatedMinutes),Array.from({length:46},(_,i)=>i+5));
  const raw=await readFile(path.join(reportDir,(await readdir(reportDir))[0]),'utf8');
  assert.doesNotMatch(raw,/private-/);assert.match(raw,/batch_finished/);assert.equal(job.report.items.length,46);
});
test('failure cancels in-flight requests, stops queued work and preserves the failed item',async(t)=>{
  const reportDir=await directory(t);let started=0,aborted=0;
  const estimate=async(assignment,{signal})=>{
    started++;
    if(assignment.id==='fail') {await new Promise(r=>setTimeout(r,5));throw new InferenceError('MODEL_JSON_INVALID');}
    await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(new Error('cancel'));},{once:true}));
  };
  const job=startBatch([{...a,id:'fail'},...Array(9).fill(a)],{env:{},estimate,reportDir});
  await job.done;
  assert.equal(started,3);assert.equal(aborted,2);assert.equal(job.report.status,'failed');
  assert.equal(job.report.items[0].errorCode,'MODEL_JSON_INVALID');assert.match(job.error,/Assignment 1/);
  const raw=await readFile(path.join(reportDir,(await readdir(reportDir))[0]),'utf8');assert.match(raw,/MODEL_JSON_INVALID/);assert.doesNotMatch(raw,/private-/);
});
test('job endpoints return immediately, expose progress and result, and reports correlate by job ID',async(t)=>{
  const reportDir=await directory(t);let release;
  const waiting=new Promise(resolve=>{release=resolve;});
  const server=createServer({env:{SYNC_LOG_DIR:reportDir},estimate:async()=>{await waiting;return {...result,provider:'mock'};}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(`${base}/api/estimate-jobs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assignments:[a]})});
  assert.equal(response.status,202);const {jobId}=await response.json();
  const poll=async()=>await (await fetch(`${base}/api/estimate-jobs/${jobId}`)).json();
  assert.equal((await poll()).status,'running');release();
  let finished;
  for(let i=0;i<30;i++) {finished=await poll();if(finished.status==='complete') break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(finished.completed,1);assert.equal(finished.assignments[0].id,a.id);
  const report=await (await fetch(`${base}/api/sync-report`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({report:{inferenceJobId:jobId,startedAt:new Date(Date.now()-1000).toISOString()}})})).json();
  const saved=JSON.parse(await readFile(path.resolve(report.file),'utf8'));assert.equal(saved.server.estimate.batchId,jobId);
});
test('saved scrape reports omit arbitrary fields, names, timeline text and query parameters',()=>{
  const saved=sanitizeSyncReport({token:'private-token',error:'private-title',timeline:[{text:'private-title'}],
    canvas:{courses:[{course:'private-course',ms:20}],requests:[{path:'/api/v1/courses/123/assignments',ms:42,status:400,bucket:'future',outcome:'http_or_parse_error'}]}});
  assert.doesNotMatch(JSON.stringify(saved),/private-/);assert.equal(saved.canvas.requests[0].ms,42);assert.equal(saved.canvas.requests[0].path,'/api/v1/courses/:id/assignments');
});
test('batch deadline aborts the provider and saves a terminal cancellation event',async(t)=>{
  const reportDir=await directory(t);let aborted=false;
  const estimate=async(assignment,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true}));
  const job=startBatch([a],{env:{},estimate,reportDir,deadlineMs:10});await job.done;
  assert.equal(aborted,true);assert.equal(job.report.status,'cancelled');assert.equal(job.report.count,0);
  assert.match(await readFile(path.join(reportDir,(await readdir(reportDir))[0]),'utf8'),/batch_finished/);
});
