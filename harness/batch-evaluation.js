import {estimateAssignments} from '../server/inference.js';
import {packGroups} from '../server/groups.js';

// Evaluation retains model failures and continues; production jobs still fail atomically.
export async function evaluateBatch(assignments,{batchSize,env,fetchImpl,concurrency=3,onDiagnostic=()=>{}}) {
  const started=Date.now(),groups=packGroups(assignments,batchSize),results=new Array(assignments.length);
  const metrics={requests:0,retries:0,promptTokens:0,completionTokens:0,usageResponses:0,groupFailures:0};
  let next=0,fatal=null;
  const controller=new AbortController();
  const diagnostic=(event,fields,groupIndex)=>{
    if(event==='snowflake_request') metrics.requests++;
    if(event==='item_retry') metrics.retries++;
    if(event==='snowflake_body') {
      metrics.promptTokens+=fields.promptTokens || 0;metrics.completionTokens+=fields.completionTokens || 0;
      if(fields.promptTokens!==null && fields.completionTokens!==null) metrics.usageResponses++;
    }
    onDiagnostic(event,{groupIndex,...fields});
  };
  async function worker() {
    while(next<groups.length && !fatal) {
      const groupIndex=next++,group=groups[groupIndex],at=Date.now();
      try {
        const estimates=await estimateAssignments(group.map(g=>g.assignment),{env,fetchImpl,signal:controller.signal,onDiagnostic:(event,fields)=>diagnostic(event,fields,groupIndex+1)});
        for(let i=0;i<group.length;i++) results[group[i].index]={estimatedMinutes:estimates[i].estimatedMinutes,ms:Date.now()-at};
      } catch(error) {
        metrics.groupFailures++;
        const code=typeof error.code==='string' && /^[A-Z0-9_]{1,50}$/.test(error.code) ? error.code : 'CONFIGURATION_ERROR';
        for(const {index} of group) results[index]={errorCode:code,ms:Date.now()-at};
        diagnostic('evaluation_group_failed',{errorCode:code,itemCount:group.length},groupIndex+1);
        // Stop systemic failures to avoid spending on a broken account/network.
        if(['HTTP_401','HTTP_403','HTTP_429','NETWORK_ERROR','CONFIGURATION_ERROR'].includes(code)) {fatal=code;controller.abort();}
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,groups.length)},worker));
  for(let i=0;i<results.length;i++) results[i] ||= {errorCode:'NOT_ATTEMPTED'};
  return {elapsedMs:Date.now()-started,...metrics,groupCount:groups.length,fatal,results};
}

export function accuracyMetrics(predictions,actualMinutes) {
  if(predictions.length!==actualMinutes.length || actualMinutes.some(v=>!Number.isFinite(v) || v<=0)) throw new Error('Actual times must be positive minutes matching predictions');
  const valid=predictions.map((p,i)=>p?.estimatedMinutes ? {predicted:p.estimatedMinutes,actual:actualMinutes[i]} : null).filter(Boolean);
  if(!valid.length) return {labeled:actualMinutes.length,valid:0,within25Percent:0,hitRate:0,meanAbsolutePercentageError:null,meanSignedPercentageError:null};
  const errors=valid.map(p=>(p.predicted-p.actual)/p.actual),hits=errors.filter(e=>Math.abs(e)<=0.25).length;
  return {labeled:actualMinutes.length,valid:valid.length,within25Percent:hits,hitRate:hits/actualMinutes.length,
    meanAbsolutePercentageError:errors.reduce((s,e)=>s+Math.abs(e),0)/valid.length,
    meanSignedPercentageError:errors.reduce((s,e)=>s+e,0)/valid.length};
}
