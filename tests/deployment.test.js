import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from '../server/index.js';
import {serverSettings} from '../extension/server-settings.js';

const origin=`chrome-extension://${'a'.repeat(32)}`;
const key='test-access-key-'.repeat(4);
const env={HOST:'0.0.0.0',API_ACCESS_KEY:key,ALLOWED_ORIGINS:origin,INFERENCE_PROVIDER:'mock'};

test('hosted configuration fails closed',()=>{
  assert.throws(()=>createServer({env:{HOST:'0.0.0.0'}}),/Hosted mode requires/);
  assert.throws(()=>createServer({env:{...env,ALLOWED_ORIGINS:'*'}}),/Hosted mode requires/);
  assert.throws(()=>createServer({env:{...env,API_REQUESTS_PER_MINUTE:'NaN'}}),/rate limits/);
});

test('hosted API authenticates every private route, polls on public hosts and does not write files',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'hosted-api-'));
  const server=createServer({env:{...env,SYNC_LOG_DIR:dir}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={Authorization:`Bearer ${key}`,Origin:origin,Host:'planner.ondigitalocean.app','Content-Type':'application/json'};
  assert.equal((await fetch(`${base}/health`)).status,200);
  for (const route of ['/', '/assignments','/api/estimate-jobs/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']) {
    assert.equal((await fetch(base+route)).status,401);
  }
  assert.equal((await fetch(base+'/api/estimate-jobs',{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(base+'/assignments',{headers:{...headers,Authorization:'Bearer wrong'}})).status,401);
  assert.equal((await fetch(base+'/assignments',{headers:{...headers,Origin:'https://evil.example'}})).status,403);
  const preflight=await fetch(base+'/api/estimate-jobs',{method:'OPTIONS',headers:{Origin:origin}});
  assert.equal(preflight.status,204);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'),/Authorization/);
  const assignment={id:'a',title:'Quiz',course:'Biology',description:'Ten questions',dueAt:null,points:10,submissionTypes:[]};
  const started=await fetch(base+'/api/estimate-jobs',{method:'POST',headers,body:JSON.stringify({assignments:[assignment]})});
  assert.equal(started.status,202);
  const {jobId}=await started.json();
  const poll=await fetch(`${base}/api/estimate-jobs/${jobId}`,{headers});
  assert.equal(poll.status,200);
  assert.equal((await poll.json()).status,'complete');
  assert.equal((await fetch(`${base}/api/estimate-jobs/${jobId}`,{method:'DELETE'})).status,401);
  assert.equal((await fetch(`${base}/api/estimate-jobs/${jobId}`,{method:'DELETE',headers})).status,200);
  assert.equal((await fetch(base+'/assignments',{headers})).status,200);
  const report=await fetch(base+'/api/sync-report',{method:'POST',headers,body:JSON.stringify({report:{startedAt:new Date().toISOString()}})});
  assert.deepEqual(await report.json(),{saved:false});
  assert.deepEqual(await readdir(dir),[]);
});

test('hosted rate limits bound requests and inference starts',async t=>{
  for (const settings of [{API_REQUESTS_PER_MINUTE:'1'},{API_ESTIMATES_PER_HOUR:'1'}]) {
    const server=createServer({env:{...env,...settings}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    const base=`http://127.0.0.1:${server.address().port}`;
    const options={method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:'{"assignments":[]}'};
    assert.equal((await fetch(base+'/api/estimate',options)).status,200);
    const limited=await fetch(base+'/api/estimate',options);
    assert.equal(limited.status,429);
    assert.ok(limited.headers.get('Retry-After'));
  }
});

test('hosted retention expires payloads and jobs even when they are polled',async t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:Date.now()});
  const server=createServer({env});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
  const assignment={id:'a',title:'Quiz',course:'Biology',description:'Ten questions',dueAt:null,points:10,submissionTypes:[]};
  const started=await fetch(base+'/api/estimate-jobs',{method:'POST',headers,body:JSON.stringify({assignments:[assignment]})});
  const {jobId}=await started.json();
  t.mock.timers.tick(14*60*1000);
  assert.equal((await fetch(`${base}/api/estimate-jobs/${jobId}`,{headers})).status,200);
  t.mock.timers.tick(70000);
  assert.equal((await fetch(`${base}/api/estimate-jobs/${jobId}`,{headers})).status,404);
  assert.deepEqual(await (await fetch(base+'/assignments',{headers})).json(),{syncedAt:null,catchUp:[],upcoming:[]});
});

test('extension accepts HTTPS origins and rejects insecure or credential-bearing endpoints',()=>{
  assert.equal(serverSettings().url,'http://localhost:8787');
  assert.equal(serverSettings({url:'https://planner.ondigitalocean.app/',accessKey:key}).url,'https://planner.ondigitalocean.app');
  for (const url of ['http://example.com','https://user:pass@example.com','https://example.com/api','https://example.com?key=secret']) {
    assert.throws(()=>serverSettings({url,accessKey:key}));
  }
  assert.throws(()=>serverSettings({url:'https://example.com'}),/access key/);
});
