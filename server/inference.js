import {validateEstimate} from '../shared/contracts.js';
import {SYSTEM_PROMPT, BATCH_SYSTEM_PROMPT} from './prompt.js';
import {inferenceConfig} from './config.js';

export class InferenceError extends Error {
  constructor(code) {super(`Snowflake inference failed (${code})`);this.code=code;}
}

function parseJson(content) {
  if(typeof content !== 'string' || !content.trim()) throw new InferenceError('EMPTY_CONTENT');
  const trimmed=content.trim();
  // Accept one complete JSON fence; never extract arbitrary objects from surrounding prose.
  const fenced=trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  let parsed;
  try {parsed=JSON.parse(fenced ? fenced[1].trim() : trimmed);} catch {throw new InferenceError('MODEL_JSON_INVALID');}
  return parsed;
}

export function parseModelOutput(content) {
  try {return validateEstimate(parseJson(content));} catch(error) {
    if(error instanceof InferenceError) throw error;
    throw new InferenceError('MODEL_SCHEMA_INVALID');
  }
}

// IDs are local numeric strings, never Canvas IDs. Ignore ordering, but reject ambiguous mappings.
export function parseBatchOutput(content, count) {
  const rows=parseJson(content);
  if(!Array.isArray(rows)) throw new InferenceError('MODEL_SCHEMA_INVALID');
  const output=new Array(count), seen=new Set();
  for(const row of rows) {
    if(!row || typeof row.id!=='string' || !/^(0|[1-9][0-9]*)$/.test(row.id) || Number(row.id)>=count || seen.has(row.id)) throw new InferenceError('MODEL_IDS_INVALID');
    seen.add(row.id);
    try {output[Number(row.id)]=validateEstimate(row);} catch { /* Retry this invalid item only. */ }
  }
  return output;
}

export function assignmentPayload(assignment) {
  return {title:assignment.title,course:assignment.course,description:assignment.description,points:assignment.points,submissionTypes:assignment.submissionTypes,attachments:assignment.attachments};
}

export async function estimateAssignment(assignment, {env = process.env, fetchImpl = fetch, signal, onDiagnostic=()=>{}, group} = {}) {
  const {provider, model} = inferenceConfig(env);
  if (provider === 'mock') {
    const text = `${assignment.title} ${assignment.description}`.toLowerCase();
    const estimatedMinutes = /essay|research/.test(text) ? 180 : /project|implement|code/.test(text) ? 240 : /quiz/.test(text) ? 30 : 60;
    return {...validateEstimate({estimatedMinutes,reason:'Demo heuristic based on keywords; not Snowflake inference or a calibrated prediction.'}),provider};
  }
  if (provider !== 'snowflake') throw new Error('Unknown inference provider');
  if (!env.SNOWFLAKE_ACCOUNT_URL || !env.SNOWFLAKE_TOKEN) throw new Error('Snowflake configuration is incomplete: fill in SNOWFLAKE_ACCOUNT_URL and SNOWFLAKE_TOKEN in .env');
  const base = new URL(env.SNOWFLAKE_ACCOUNT_URL);
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.snowflakecomputing.com') || base.username || base.password || base.port || base.pathname !== '/' || base.search || base.hash) throw new Error('Invalid Snowflake account URL');
  const requestBody=JSON.stringify({model,stream:false,max_completion_tokens:512*(group?.length || 1),temperature:0,
    messages:[{role:'system',content:group ? BATCH_SYSTEM_PROMPT : SYSTEM_PROMPT},{role:'user',content:JSON.stringify(group ? group.map((a,i)=>({id:String(i),...assignmentPayload(a)})) : assignmentPayload(assignment))}]});
  const started=Date.now();
  onDiagnostic('snowflake_request',{requestBytes:Buffer.byteLength(requestBody)});
  const timeout=AbortSignal.timeout(45000);
  let response,raw;
  try {
    response=await fetchImpl(new URL('/api/v2/cortex/v1/chat/completions',base), {
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.SNOWFLAKE_TOKEN}`,
        'X-Snowflake-Authorization-Token-Type':'PROGRAMMATIC_ACCESS_TOKEN'},
      body:requestBody,signal:signal ? AbortSignal.any([signal,timeout]) : timeout
    });
    onDiagnostic('snowflake_headers',{httpStatus:response.status,headersMs:Date.now()-started});
    raw=await response.text();
  } catch {
    throw new InferenceError(signal?.aborted ? 'CANCELLED' : timeout.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR');
  }
  let data;
  try {data=JSON.parse(raw);} catch {onDiagnostic('snowflake_body',{responseBytes:Buffer.byteLength(raw),responseMs:Date.now()-started});throw new InferenceError('HTTP_JSON_INVALID');}
  if(!data || typeof data!=='object' || Array.isArray(data)) throw new InferenceError('HTTP_ENVELOPE_INVALID');
  const requestId=data.request_id || data.id || response.headers.get('x-snowflake-request-id');
  const content=data.choices?.[0]?.message?.content;
  const finish=data.choices?.[0]?.finish_reason;
  const safeReason=['stop','length','content_filter','tool_calls'].includes(finish) ? finish : 'unknown';
  const numeric=v=>Number.isFinite(v) && v>=0 ? v : null;
  const upstreamMessage=typeof data.message==='string' ? data.message.toLowerCase() : '';
  onDiagnostic('snowflake_body',{responseBytes:Buffer.byteLength(raw),responseMs:Date.now()-started,
    requestId:typeof requestId==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(requestId) ? requestId : null,
    finishReason:safeReason,contentChars:typeof content==='string' ? content.length : 0,
    fenced:typeof content==='string' && content.trim().startsWith('```'),
    promptTokens:numeric(data.usage?.prompt_tokens),completionTokens:numeric(data.usage?.completion_tokens),
    totalTokens:numeric(data.usage?.total_tokens),upstreamCategory:response.ok ? null :
      upstreamMessage.includes('deprecated') ? 'model_deprecated' : upstreamMessage.includes('unknown model') ? 'unknown_model' :
      upstreamMessage.includes('network policy') ? 'network_policy' : 'other'});
  if(!response.ok) throw new InferenceError(`HTTP_${response.status}`);
  if(finish==='length') throw new InferenceError('OUTPUT_TRUNCATED');
  if(finish==='content_filter') throw new InferenceError('CONTENT_FILTERED');
  const parseStarted=Date.now();
  try {
    const estimate=group ? parseBatchOutput(content,group.length) : parseModelOutput(content);
    onDiagnostic('model_parsed',{parseMs:Date.now()-parseStarted,parseStatus:'valid',...(group ? {missingItems:group.length-estimate.filter(Boolean).length} : {})});
    return group ? estimate.map(e=>e ? {...e,provider} : undefined) : {...estimate,provider};
  } catch(error) {
    onDiagnostic('model_parsed',{parseMs:Date.now()-parseStarted,parseStatus:error.code || 'MODEL_JSON_INVALID'});
    throw error;
  }
}

export async function estimateAssignments(assignments, options={}) {
  if(!assignments.length) return [];
  if(assignments.length>10) throw new Error('Inference group exceeds 10 assignments');
  const {provider}=inferenceConfig(options.env);
  if(assignments.length===1 || provider==='mock') {
    const output=[];
    for(const a of assignments) {options.signal?.throwIfAborted();output.push(await estimateAssignment(a,options));}
    return output;
  }
  let output;
  try {output=await estimateAssignment(assignments[0],{...options,group:assignments});}
  catch(error) {
    if(!['MODEL_JSON_INVALID','MODEL_SCHEMA_INVALID','MODEL_IDS_INVALID','EMPTY_CONTENT','OUTPUT_TRUNCATED'].includes(error.code)) throw error;
    options.onDiagnostic?.('group_fallback',{errorCode:error.code,retryItems:assignments.length});
    output=new Array(assignments.length);
  }
  // One single-item attempt per missing estimate. No recursion or retries for HTTP/network failures.
  for(let i=0;i<assignments.length;i++) if(!output[i]) {
    options.signal?.throwIfAborted();
    options.onDiagnostic?.('item_retry',{localIndex:i+1});
    output[i]=await estimateAssignment(assignments[i],options);
  }
  return output;
}
