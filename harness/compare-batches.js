import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {validateAssignments} from '../shared/contracts.js';
import {estimateAssignments} from '../server/inference.js';
import {evaluateBatch} from './batch-evaluation.js';
import {inferenceConfig} from '../server/config.js';
import {createInferenceLog} from '../server/diagnostics.js';
import {PROMPT_VERSION} from '../server/prompt.js';
import {randomUUID} from 'node:crypto';

const live=process.argv.includes('--live');
if(live && inferenceConfig().provider!=='snowflake') throw new Error('--live requires Snowflake credentials and provider');
const clean=process.argv.includes('--clean');
const repetitionsArg=process.argv.find(a=>a.startsWith('--repeats='));
const repetitions=repetitionsArg ? Number(repetitionsArg.split('=')[1]) : 3;
if(![1,3].includes(repetitions)) throw new Error('--repeats must be 1 or 3');
const allFixtures=JSON.parse(await readFile(new URL('./fixtures.json',import.meta.url),'utf8'));
const fixtures=clean ? allFixtures.filter(f=>!f.assignment.id.includes('injection')) : allFixtures;
const cases=Array.from({length:46},(_,i)=>({...fixtures[i%fixtures.length],assignment:{...fixtures[i%fixtures.length].assignment,id:`synthetic-${i}`}}));
const assignments=validateAssignments(cases.map(c=>c.assignment));
const rows=[1,5,10].map(batchSize=>({batchSize,runs:[]}));
const directory=fileURLToPath(new URL('../sync-logs/evaluation/',import.meta.url));await mkdir(directory,{recursive:true});
const report={mode:live ? 'live-snowflake' : 'simulated-snowflake',at:new Date().toISOString(),model:live ? inferenceConfig().model : 'simulated',promptVersion:PROMPT_VERSION,
  cohort:clean ? 'ordinary' : 'stress',assignments:46,uniqueFixtures:fixtures.length,repeats:repetitions,concurrency:3,accuracy:{status:'unavailable',reason:'No observed active completion times in fixtures.'},
  caveat:live ? `${fixtures.length} unique synthetic fixtures repeated 46 times; broad ranges and singleton agreement are not prediction accuracy.` : 'Simulated 40ms request overhead + 2ms per result; byte/4 token approximations. Not Snowflake performance or prediction accuracy.',rows};
const save=async()=>{
  const content=JSON.stringify(report,null,2);
  await writeFile(new URL('./batch-results.json',import.meta.url),content);
  await writeFile(new URL(`./batch-${live ? 'live' : 'simulated'}-${clean ? 'ordinary' : 'stress'}.json`,import.meta.url),content);
};
let stop=false;
for(let repeat=0;repeat<repetitions && !stop;repeat++) {
  // Rotate mode order between repetitions; use identical shuffled assignments for each mode in that repetition.
  let seed=repeat+1;const ordered=assignments.map((assignment,index)=>({assignment,index}));
  for(let i=ordered.length-1;i>0;i--) {seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[ordered[i],ordered[j]]=[ordered[j],ordered[i]];}
  for(let mode=0;mode<3;mode++) {
    const row=rows[(mode+repeat)%3],size=row.batchSize;
    const env=live ? {...process.env,INFERENCE_BATCH_SIZE:String(size)} : {INFERENCE_PROVIDER:'snowflake',SNOWFLAKE_ACCOUNT_URL:'https://synthetic.snowflakecomputing.com',SNOWFLAKE_TOKEN:'synthetic-token'};
    const fetchImpl=live ? undefined : async(_,request)=>{
      const body=JSON.parse(request.body),input=JSON.parse(body.messages[1].content),items=Array.isArray(input) ? input : [input];
      await new Promise(resolve=>setTimeout(resolve,40+2*items.length));
      const estimates=await estimateAssignments(items,{env:{INFERENCE_PROVIDER:'mock'}});
      const result=Array.isArray(input) ? estimates.map((e,i)=>({id:input[i].id,estimatedMinutes:e.estimatedMinutes,reason:e.reason})).reverse() : {estimatedMinutes:estimates[0].estimatedMinutes,reason:estimates[0].reason};
      const content=JSON.stringify(result);
      return Response.json({usage:{prompt_tokens:Math.ceil(Buffer.byteLength(JSON.stringify(body.messages))/4),completion_tokens:Math.ceil(Buffer.byteLength(content)/4)},choices:[{finish_reason:'stop',message:{content}}]});
    };
    const log=createInferenceLog(directory,randomUUID());
    const outcome=await evaluateBatch(ordered.map(o=>o.assignment),{batchSize:size,env,fetchImpl,onDiagnostic:(event,fields)=>{
      // Keep metadata traces without flooding the summary console.
      const info=console.info;console.info=()=>{};try {log.emit(event,fields);} finally {console.info=info;}
    }});await log.flush();
    const results=new Array(assignments.length);ordered.forEach((o,i)=>{results[o.index]=outcome.results[i];});
    const rangesPassed=results.filter((r,i)=>r.estimatedMinutes>=cases[i].expectedRange[0] && r.estimatedMinutes<=cases[i].expectedRange[1]).length;
    const valid=results.filter(r=>Number.isInteger(r.estimatedMinutes)).length;
    row.runs.push({...outcome,results,repeat:repeat+1,rangesPassed,valid,logFile:log.file});
    console.log(JSON.stringify({repeat:repeat+1,batchSize:size,elapsedMs:outcome.elapsedMs,requests:outcome.requests,retries:outcome.retries,valid,rangesPassed,fatal:outcome.fatal}));
    await save();
    if(outcome.fatal) {stop=true;break;}
  }
}
const median=values=>{const sorted=[...values].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);return sorted.length%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;};
for(const row of rows) {
  if(!row.runs.length) continue;
  row.medianMs=median(row.runs.map(r=>r.elapsedMs));
  for(const key of ['requests','retries','promptTokens','completionTokens','valid','rangesPassed','groupFailures']) row[key]=row.runs.reduce((n,r)=>n+r[key],0);
  row.evaluated=row.runs.length*assignments.length;
  row.perFixture=fixtures.map((f,i)=>{
    const results=row.runs.flatMap(r=>r.results.filter((_,j)=>j%fixtures.length===i)),valid=results.filter(r=>r.estimatedMinutes);
    return {id:f.assignment.id,total:results.length,valid:valid.length,rangesPassed:valid.filter(r=>r.estimatedMinutes>=f.expectedRange[0] && r.estimatedMinutes<=f.expectedRange[1]).length,
      minMinutes:valid.length ? Math.min(...valid.map(r=>r.estimatedMinutes)) : null,maxMinutes:valid.length ? Math.max(...valid.map(r=>r.estimatedMinutes)) : null,
      medianMinutes:valid.length ? median(valid.map(r=>r.estimatedMinutes)) : null};
  });
  let comparable=0,within25=0;
  for(const run of row.runs) {
    const baseline=rows[0].runs.find(r=>r.repeat===run.repeat);if(!baseline) continue;
    run.results.forEach((p,i)=>{const b=baseline.results[i].estimatedMinutes;if(p.estimatedMinutes && b) {comparable++;if(Math.abs(p.estimatedMinutes-b)/b<=0.25) within25++;}});
  }
  row.singletonAgreement={comparable,within25,rate:comparable ? within25/comparable : null};
}
await save();
console.log(report.caveat);
console.table(rows.filter(r=>r.runs.length).map(({batchSize,medianMs,requests,retries,promptTokens,completionTokens,valid,evaluated,rangesPassed})=>({batchSize,medianMs,requests,retries,promptTokens,completionTokens,valid,evaluated,rangesPassed})));
if(stop || rows.some(r=>r.valid!==r.evaluated || (!live && r.rangesPassed!==r.evaluated))) process.exitCode=1;
