import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateBatch,accuracyMetrics} from '../harness/batch-evaluation.js';
const a={title:'quiz',course:'synthetic',description:'',points:1,submissionTypes:[],attachments:[]};
const env={INFERENCE_PROVIDER:'snowflake',SNOWFLAKE_ACCOUNT_URL:'https://synthetic.snowflakecomputing.com',SNOWFLAKE_TOKEN:'synthetic'};
test('evaluator retains schema failures, keeps later estimates and bounds concurrency',async()=>{
  let active=0,max=0,calls=0;
  const result=await evaluateBatch(Array(8).fill(a),{batchSize:1,env,fetchImpl:async()=>{
    const n=++calls;active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,2));active--;
    return Response.json({usage:{prompt_tokens:10,completion_tokens:5},choices:[{message:{content:JSON.stringify({estimatedMinutes:n===4 ? -1 : 30,reason:'test'})}}]});
  }});
  assert.equal(calls,8);assert.equal(max,3);assert.equal(result.results[3].errorCode,'MODEL_SCHEMA_INVALID');
  assert.equal(result.results[7].estimatedMinutes,30);assert.equal(result.groupFailures,1);assert.equal(result.promptTokens,80);assert.equal(result.usageResponses,8);
});
test('systemic auth failure stops queued work and records unattempted cases',async()=>{
  const result=await evaluateBatch(Array(46).fill(a),{batchSize:1,env,fetchImpl:async()=>Response.json({message:'not authorized'},{status:401})});
  assert.equal(result.fatal,'HTTP_401');assert.ok(result.requests<=3);assert.equal(result.results.length,46);assert.equal(result.results[45].errorCode,'NOT_ATTEMPTED');
});
test('accuracy requires actual times, treats failures as misses and computes signed errors',()=>{
  assert.deepEqual(accuracyMetrics([{estimatedMinutes:75},{estimatedMinutes:125},{errorCode:'failed'}],[100,100,100]),{labeled:3,valid:2,within25Percent:2,hitRate:2/3,meanAbsolutePercentageError:0.25,meanSignedPercentageError:0});
  assert.throws(()=>accuracyMetrics([{estimatedMinutes:30}],[0]));
});
