import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {estimateAssignments,parseBatchOutput} from '../server/inference.js';
import {packGroups,batchSizeFromEnv} from '../server/groups.js';
import {startBatch} from '../server/batch.js';
import {createServer} from '../server/index.js';
const env={INFERENCE_PROVIDER:'snowflake',SNOWFLAKE_ACCOUNT_URL:'https://test.snowflakecomputing.com',SNOWFLAKE_TOKEN:'secret-token'};
const a={id:'private-id',title:'private-title',course:'private-course',description:'private-description',points:10,dueAt:null,submissionTypes:[],attachments:[]};
const estimate={estimatedMinutes:60,reason:'Synthetic'};
const response=rows=>Response.json({usage:{prompt_tokens:100,completion_tokens:20},choices:[{finish_reason:'stop',message:{content:JSON.stringify(rows)}}]});

test('group configuration and byte packing handle tails, long text, Unicode and empty input',()=>{
  for(const n of [1,5,10]) {assert.equal(batchSizeFromEnv({INFERENCE_BATCH_SIZE:String(n)}),n);assert.equal(packGroups(Array(46).fill(a),n).length,Math.ceil(46/n));}
  for(const value of ['0','2','100','5junk','']) assert.throws(()=>batchSizeFromEnv({INFERENCE_BATCH_SIZE:value}));
  assert.equal(batchSizeFromEnv(),1);assert.deepEqual(packGroups([],10),[]);
  const long={...a,description:'漢'.repeat(6000)};
  assert.deepEqual(packGroups([a,long,a],10).map(g=>g.length),[1,1,1]);
});

test('batch parser restores order and marks missing/invalid items; ambiguous IDs and prose fail',()=>{
  const parsed=parseBatchOutput(JSON.stringify([{id:'2',...estimate},{id:'0',...estimate},{id:'1',estimatedMinutes:-1,reason:'bad'}]),4);
  assert.equal(parsed[0].estimatedMinutes,60);assert.equal(parsed[1],undefined);assert.equal(parsed[2].estimatedMinutes,60);assert.equal(parsed[3],undefined);
  for(const rows of [[{id:'0',...estimate},{id:'0',...estimate}],[{id:'4',...estimate}],[{id:0,...estimate}],[{id:'01',...estimate}]]) assert.throws(()=>parseBatchOutput(JSON.stringify(rows),4),e=>e.code==='MODEL_IDS_INVALID');
  assert.throws(()=>parseBatchOutput('Here: []',4),e=>e.code==='MODEL_JSON_INVALID');
});

test('group request uses local IDs, scaled tokens and partial single retries without repeating good estimates',async()=>{
  const requests=[],events=[];
  const output=await estimateAssignments(Array.from({length:5},(_,i)=>({...a,id:`private-${i}`,title:`private-${i}`})),{env,onDiagnostic:(event,fields)=>events.push({event,...fields}),fetchImpl:async(_,options)=>{
    const body=JSON.parse(options.body),payload=JSON.parse(body.messages[1].content);requests.push(payload);
    if(Array.isArray(payload)) {
      assert.equal(body.max_completion_tokens,2560);assert.deepEqual(payload.map(p=>p.id),['0','1','2','3','4']);
      return response([{id:'4',...estimate},{id:'0',...estimate},{id:'2',...estimate},{id:'3',estimatedMinutes:-1,reason:'invalid'}]);
    }
    assert.equal(body.max_completion_tokens,512);return response(estimate);
  }});
  assert.equal(output.length,5);assert.equal(requests.length,3);
  assert.deepEqual(requests.slice(1).map(p=>p.title),['private-1','private-3']);
  assert.doesNotMatch(JSON.stringify(events),/private-|secret-token/);
});

test('malformed, duplicate and truncated groups fall back once; transport failures never retry',async()=>{
  for(const mode of ['malformed','duplicate','length']) {
    let calls=0;
    const output=await estimateAssignments([a,a],{env,fetchImpl:async()=>{
      calls++;
      if(calls>1) return response(estimate);
      if(mode==='duplicate') return response([{id:'0',...estimate},{id:'0',...estimate}]);
      return Response.json({choices:[{finish_reason:mode==='length' ? 'length' : 'stop',message:{content:'['}}]});
    }});
    assert.equal(output.length,2);assert.equal(calls,3);
  }
  for(const status of [401,429,500]) {
    let calls=0;
    await assert.rejects(estimateAssignments([a,a],{env,fetchImpl:async()=>{calls++;return Response.json({message:'error'},{status});}}),e=>e.code===`HTTP_${status}`);
    assert.equal(calls,1);
  }
  let calls=0;
  await assert.rejects(estimateAssignments([a,a],{env,fetchImpl:async()=>{calls++;return response({estimatedMinutes:-1,reason:'bad'});}}),e=>e.code==='MODEL_SCHEMA_INVALID');
  assert.equal(calls,2); // Invalid group, then one invalid singleton; no unbounded retry.
});

test('cancelled fallback stops before paying for another request',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(estimateAssignments([a,a],{env,signal:controller.signal,fetchImpl:async()=>{calls++;controller.abort();return response([]);}}));
  assert.equal(calls,1);
});

for(const batchSize of [1,5,10]) test(`46 assignments in mode ${batchSize}: three concurrent requests, stable order and redacted logs`,async(t)=>{
  const dir=await mkdtemp(path.join(tmpdir(),'batch-mode-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let active=0,max=0,calls=0;
  const job=startBatch(Array.from({length:46},(_,i)=>({...a,id:`private-${i}`})),{env:{...env,INFERENCE_BATCH_SIZE:String(batchSize)},reportDir:dir,estimateMany:async(group,options)=>estimateAssignments(group,{...options,fetchImpl:async(_,request)=>{
    active++;max=Math.max(max,active);calls++;
    const payload=JSON.parse(JSON.parse(request.body).messages[1].content);
    await new Promise(r=>setTimeout(r,5));active--;
    return response(Array.isArray(payload) ? payload.map(p=>({id:p.id,...estimate})).reverse() : estimate);
  }})});
  await job.done;assert.equal(job.report.status,'complete');assert.equal(job.report.count,46);
  assert.equal(calls,Math.ceil(46/batchSize));assert.equal(job.report.requests,calls);assert.equal(max,3);
  assert.equal(job.report.promptTokens,100*calls);assert.equal(job.report.retries,0);
  assert.deepEqual(job.results.map(r=>r.id),Array.from({length:46},(_,i)=>`private-${i}`));
  assert.doesNotMatch(await readFile(path.join(dir,(await readdir(dir))[0]),'utf8'),/private-|secret-token/);
});

test('HTTP job uses configured batch size and exposes group metrics',async(t)=>{
  const dir=await mkdtemp(path.join(tmpdir(),'batch-api-'));t.after(()=>rm(dir,{recursive:true,force:true}));let sizes=[];
  const server=createServer({env:{INFERENCE_PROVIDER:'mock',INFERENCE_BATCH_SIZE:'5',SYNC_LOG_DIR:dir},estimateMany:async(group)=>{sizes.push(group.length);return group.map(()=>({...estimate,provider:'mock'}));}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const result=await (await fetch(`http://127.0.0.1:${server.address().port}/api/estimate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assignments:Array.from({length:11},(_,i)=>({...a,id:String(i)}))})})).json();
  assert.deepEqual(sizes,[5,5,1]);assert.equal(result.assignments.length,11);assert.equal(result.diagnostics.batchSize,5);
  assert.throws(()=>createServer({env:{INFERENCE_BATCH_SIZE:'4'}}));
});
