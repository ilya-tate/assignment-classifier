import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {validateAssignments,validateEstimate,plan} from '../shared/contracts.js';
import {estimateAssignment} from '../server/inference.js';
import {createServer,summarize} from '../server/index.js';
import {inferenceConfig,DEFAULT_MODEL} from '../server/config.js';
const assignment={id:'a',title:'Quiz',course:'Biology',description:'Ten questions',dueAt:'2026-10-04T00:00:00Z',points:10,submissionTypes:['online_quiz']};

test('contract rejects duplicates, invalid dates, excessive payloads and strips extra data',()=>{
  assert.throws(()=>validateAssignments([assignment,assignment]));
  assert.throws(()=>validateAssignments([{...assignment,dueAt:'tomorrow'}]));
  assert.throws(()=>validateAssignments([{...assignment,description:'a'.repeat(12001)}]));
  assert.throws(()=>validateAssignments(Array(101).fill(assignment)));
  assert.equal(validateAssignments([{...assignment,secret:'unused'}])[0].secret,undefined);
});
test('attachments are optional, bounded, and stripped to name and text',()=>{
  assert.deepEqual(validateAssignments([assignment])[0].attachments,[]);
  const file={name:'notes.pdf',text:'Read chapter 4',url:'https://drop.me'};
  assert.deepEqual(validateAssignments([{...assignment,attachments:[file]}])[0].attachments,[{name:'notes.pdf',text:'Read chapter 4'}]);
  assert.throws(()=>validateAssignments([{...assignment,attachments:Array(6).fill(file)}]));
  assert.throws(()=>validateAssignments([{...assignment,attachments:[{name:'a',text:'x'.repeat(4001)}]}]));
  assert.throws(()=>validateAssignments([{...assignment,attachments:[1,2,3].map(n=>({name:`f${n}`,text:'x'.repeat(3000)}))}]));
  assert.throws(()=>validateAssignments([{...assignment,attachments:[{name:'',text:'x'}]}]));
});
test('planner handles null dates and UTC deadline subtraction',()=>{
  assert.equal(plan(assignment,{estimatedMinutes:60,reason:'test'},'mock').startAt,'2026-10-03T22:45:00.000Z');
  assert.equal(plan({...assignment,dueAt:null},{estimatedMinutes:60},'mock').startAt,null);
  for(const minutes of [-1,0,1.5,Infinity,10081]) assert.throws(()=>validateEstimate({estimatedMinutes:minutes,reason:'test'}));
});
test('mock provider is explicit and unknown providers fail',async()=>{
  assert.equal((await estimateAssignment(assignment,{env:{}})).provider,'mock');
  await assert.rejects(estimateAssignment(assignment,{env:{INFERENCE_PROVIDER:'other'}}));
});
const snowflake={INFERENCE_PROVIDER:'snowflake',SNOWFLAKE_ACCOUNT_URL:'https://example.snowflakecomputing.com',SNOWFLAKE_TOKEN:'test-token',SNOWFLAKE_MODEL:'test-model'};
test('credentials alone activate Snowflake with a default model; partial credentials fail',async()=>{
  const env={SNOWFLAKE_ACCOUNT_URL:snowflake.SNOWFLAKE_ACCOUNT_URL,SNOWFLAKE_TOKEN:'test-token'};
  assert.deepEqual(inferenceConfig(env),{provider:'snowflake',model:DEFAULT_MODEL});
  assert.equal(inferenceConfig({}).provider,'mock');
  assert.equal(inferenceConfig({...env,INFERENCE_PROVIDER:'mock'}).provider,'mock');
  await estimateAssignment(assignment,{env,fetchImpl:async(url,options)=>{
    assert.equal(JSON.parse(options.body).model,DEFAULT_MODEL);
    return Response.json({choices:[{message:{content:'{"estimatedMinutes":30,"reason":"Quiz"}'}}]});
  }});
  await assert.rejects(estimateAssignment(assignment,{env:{SNOWFLAKE_TOKEN:'test-token'}}),/configuration is incomplete/);
  await assert.rejects(estimateAssignment(assignment,{env:{SNOWFLAKE_ACCOUNT_URL:env.SNOWFLAKE_ACCOUNT_URL}}),/configuration is incomplete/);
});
test('Snowflake adapter sends server auth and validates model output',async()=>{
  let body;
  const fetchImpl=async(url,options)=>{
    assert.equal(url.pathname,'/api/v2/cortex/v1/chat/completions');
    assert.equal(options.headers.Authorization,'Bearer test-token');
    body=JSON.parse(options.body);
    return Response.json({choices:[{message:{content:'{"estimatedMinutes":45,"reason":"Review and answer questions"}'}}]});
  };
  const result=await estimateAssignment({...assignment,attachments:[{name:'rubric.txt',text:'Show work'}]},{env:snowflake,fetchImpl});
  assert.equal(result.estimatedMinutes,45);assert.equal(body.stream,false);
  assert.deepEqual(JSON.parse(body.messages[1].content).attachments,[{name:'rubric.txt',text:'Show work'}]);
  assert.equal(JSON.parse(body.messages[1].content).id,undefined);
  await assert.rejects(estimateAssignment(assignment,{env:snowflake,fetchImpl:async()=>Response.json({choices:[{message:{content:'not JSON'}}]})}));
  await assert.rejects(estimateAssignment(assignment,{env:snowflake,fetchImpl:async()=>new Response('',{status:401})}));
  await assert.rejects(estimateAssignment(assignment,{env:{...snowflake,SNOWFLAKE_ACCOUNT_URL:'https://evil.example'}}));
});
test('HTTP API handles estimates, validation, origin and provider failures',async(t)=>{
  const server=createServer({env:{}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(value,headers={})=>fetch(`${base}/api/estimate`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(value)});
  const response=await post({assignments:[assignment]});assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.assignments[0].provider,'mock');assert.ok(data.assignments[0].startAt);
  assert.equal((await post({assignments:[{id:'broken'}]})).status,400);
  assert.equal((await post({assignments:[]},{Origin:'https://evil.example'})).status,403);
  assert.equal((await fetch(`${base}/missing`)).status,404);
  const extensionOrigin=`chrome-extension://${'a'.repeat(32)}`;
  assert.equal((await post({assignments:[]},{Origin:extensionOrigin})).headers.get('Access-Control-Allow-Origin'),extensionOrigin);
});
test('assignment view splits Catch Up from Upcoming with the public fields',async(t)=>{
  const now=Date.parse('2026-10-03T00:00:00Z');
  const view=summarize([{...assignment,id:'b',dueAt:null},assignment,{...assignment,id:'c',title:'Late',dueAt:'2026-10-01T00:00:00Z'}],now);
  assert.deepEqual(view.catchUp,[{course:'Biology',title:'Late',description:'Ten questions',dueDate:'2026-10-01T00:00:00Z',attachments:[]}]);
  assert.deepEqual(view.upcoming.map(a=>a.dueDate),['2026-10-04T00:00:00Z',null]);
  const ordered=summarize([
    {...assignment,id:'u2',dueAt:'2026-10-05T00:00:00Z'},{...assignment,id:'u0',dueAt:null},
    {...assignment,id:'o1',dueAt:'2026-10-02T00:00:00Z'},{...assignment,id:'u1',dueAt:'2026-10-04T01:00:00+02:00'},
    {...assignment,id:'o0',dueAt:'2026-09-01T00:00:00Z'}],now);
  assert.deepEqual(ordered.catchUp.map(a=>a.dueDate),['2026-09-01T00:00:00Z','2026-10-02T00:00:00Z']);
  assert.deepEqual(ordered.upcoming.map(a=>a.dueDate),['2026-10-04T01:00:00+02:00','2026-10-05T00:00:00Z',null]);
  const server=createServer({env:{}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.deepEqual((await (await fetch(`${base}/`)).json()).upcoming,[]);
  await fetch(`${base}/api/estimate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assignments:[assignment]})});
  const page=await (await fetch(`${base}/assignments`)).json();
  assert.equal(page.catchUp.length+page.upcoming.length,1);assert.ok(page.syncedAt);
  const rebound=await new Promise(resolve=>http.get(`${base}/`,{headers:{Host:'evil.example'}},resolve));
  assert.equal(rebound.statusCode,403);rebound.resume();
});
test('HTTP API surfaces inference failures without exposing secrets',async(t)=>{
  const server=createServer({estimate:async()=>{throw new Error('sensitive upstream detail');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/estimate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assignments:[assignment]})});
  assert.equal(response.status,502);assert.doesNotMatch(await response.text(),/sensitive/);
});
