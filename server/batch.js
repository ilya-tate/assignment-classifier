import {randomUUID} from 'node:crypto';
import {plan} from '../shared/contracts.js';
import {PROMPT_VERSION} from './prompt.js';
import {inferenceConfig} from './config.js';
import {packGroups, batchSizeFromEnv} from './groups.js';
import {createInferenceLog} from './diagnostics.js';

export function startBatch(assignments, {env, estimate, estimateMany, reportDir, concurrency=3, deadlineMs=600000}) {
  const batchSize=batchSizeFromEnv(env);
  const groups=packGroups(assignments,batchSize);
  const id=randomUUID(), started=Date.now(), {provider,model}=inferenceConfig(env);
  const log=createInferenceLog(reportDir,id), controller=new AbortController();
  const report={batchId:id,at:new Date(started).toISOString(),provider,model,promptVersion:PROMPT_VERSION,
    requested:assignments.length,count:0,status:'running',concurrency,batchSize,groupCount:groups.length,requests:0,retries:0,promptTokens:0,completionTokens:0,totalMs:0,avgMs:0,maxMs:0,items:[],logFile:log.file};
  const job={id,report,results:null,error:null,lastPoll:Date.now(),cancel:()=>controller.abort(),done:null};
  let next=0;
  const output=new Array(assignments.length);
  const timer=setTimeout(()=>controller.abort(),deadlineMs);
  log.emit('batch_started',{requested:assignments.length,provider,model,promptVersion:PROMPT_VERSION,concurrency,batchSize,groupCount:groups.length});
  async function worker() {
    while(next<groups.length && !controller.signal.aborted) {
      const groupIndex=next++, group=groups[groupIndex], at=Date.now();
      const items=group.map(({index,assignment})=>{
        const item={index:index+1,status:'running',ms:0,groupIndex:groupIndex+1};report.items.push(item);
        log.emit('assignment_started',{index:item.index,groupIndex:item.groupIndex,descriptionChars:assignment.description.length,
          attachmentCount:assignment.attachments?.length || 0,attachmentChars:(assignment.attachments || []).reduce((n,a)=>n+a.text.length,0),queueMs:at-started});
        return item;
      });
      const onDiagnostic=(event,fields)=>{
        if(event==='snowflake_request') report.requests++;
        if(event==='item_retry') report.retries++;
        if(event==='snowflake_body') {
          report.promptTokens+=fields.promptTokens || 0;report.completionTokens+=fields.completionTokens || 0;
        }
        if(group.length===1) Object.assign(items[0],fields);
        log.emit(event,{groupIndex:groupIndex+1,...(group.length===1 ? {index:items[0].index} : {}),...fields});
      };
      try {
        const options={env,signal:controller.signal,onDiagnostic};
        const estimates=[];
        if(estimateMany) estimates.push(...await estimateMany(group.map(g=>g.assignment),options));
        else for(const g of group) {
          controller.signal.throwIfAborted();
          estimates.push(await estimate(g.assignment,options));
        }
        controller.signal.throwIfAborted();
        if(estimates.length!==group.length) throw new Error('Invalid group result count');
        const planned=group.map(({assignment},i)=>plan(assignment,estimates[i],estimates[i].provider));
        group.forEach(({index},i)=>{output[index]=planned[i];items[i].status='complete';report.count++;});
      } catch(error) {
        for(const item of items) {
          item.status=controller.signal.aborted ? 'cancelled' : 'failed';
          item.errorCode=typeof error.code==='string' && /^[A-Z0-9_]{1,50}$/.test(error.code) ? error.code : (controller.signal.aborted ? 'CANCELLED' : 'INFERENCE_ERROR');
        }
        if(!job.error && !controller.signal.aborted) job.error=`Assignment ${items[0].index} failed (${items[0].errorCode}). See ${log.file}.`;
        controller.abort();
      } finally {
        for(const item of items) {
          item.ms=Date.now()-at;
          log.emit('assignment_finished',{index:item.index,groupIndex:groupIndex+1,status:item.status,ms:item.ms,errorCode:item.errorCode || null});
        }
      }
    }
  }

  job.done=(async()=>{
    try {
      await Promise.all(Array.from({length:Math.min(concurrency,groups.length)},worker));
      if(controller.signal.aborted) {
        report.status=job.error ? 'failed' : 'cancelled';
        job.error ||= `Inference cancelled or timed out. See ${log.file}.`;
      } else {report.status='complete';job.results=output;}
    } finally {
      clearTimeout(timer);report.totalMs=Date.now()-started;
      report.avgMs=report.items.length ? Math.round(report.items.reduce((n,a)=>n+a.ms,0)/report.items.length) : 0;
      report.maxMs=Math.max(0,...report.items.map(a=>a.ms));
      log.emit('batch_finished',{status:report.status,completed:report.count,requested:report.requested,totalMs:report.totalMs,avgMs:report.avgMs,maxMs:report.maxMs,requests:report.requests,retries:report.retries,promptTokens:report.promptTokens,completionTokens:report.completionTokens});
      await log.flush();
    }
  })();
  return job;
}
