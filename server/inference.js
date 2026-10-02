import {validateEstimate} from '../shared/contracts.js';
import {SYSTEM_PROMPT} from './prompt.js';

export async function estimateAssignment(assignment, {env = process.env, fetchImpl = fetch} = {}) {
  const provider = env.INFERENCE_PROVIDER || 'mock';
  if (provider === 'mock') {
    const text = `${assignment.title} ${assignment.description}`.toLowerCase();
    const estimatedMinutes = /essay|research/.test(text) ? 180 : /project|implement|code/.test(text) ? 240 : /quiz/.test(text) ? 30 : 60;
    return {...validateEstimate({estimatedMinutes,reason:'Demo heuristic based on keywords; not Snowflake inference or a calibrated prediction.'}),provider};
  }
  if (provider !== 'snowflake') throw new Error('Unknown inference provider');
  if (!env.SNOWFLAKE_ACCOUNT_URL || !env.SNOWFLAKE_TOKEN || !env.SNOWFLAKE_MODEL) throw new Error('Snowflake configuration is incomplete');
  const base = new URL(env.SNOWFLAKE_ACCOUNT_URL);
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.snowflakecomputing.com') || base.username || base.password || base.port || base.pathname !== '/' || base.search || base.hash) throw new Error('Invalid Snowflake account URL');
  const response = await fetchImpl(new URL('/api/v2/cortex/v1/chat/completions',base), {
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.SNOWFLAKE_TOKEN}`},
    body:JSON.stringify({model:env.SNOWFLAKE_MODEL,stream:false,messages:[{role:'system',content:SYSTEM_PROMPT},{role:'user',content:JSON.stringify({title:assignment.title,course:assignment.course,description:assignment.description,points:assignment.points,submissionTypes:assignment.submissionTypes})}]}),
    signal:AbortSignal.timeout(45000)
  });
  if (!response.ok) throw new Error(`Snowflake inference failed (${response.status})`);
  const data = await response.json();
  let parsed;
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content); } catch { throw new Error('Snowflake returned invalid JSON'); }
  return {...validateEstimate(parsed),provider};
}
