import {readFile,writeFile} from 'node:fs/promises';
import {estimateAssignment} from '../server/inference.js';
import {validateAssignments} from '../shared/contracts.js';
import {PROMPT_VERSION} from '../server/prompt.js';
const fixtures=JSON.parse(await readFile(new URL('./fixtures.json',import.meta.url),'utf8'));
const results=[];
for (const fixture of fixtures) {
  try {
    const [a]=validateAssignments([fixture.assignment]);
    const e=await estimateAssignment(a);
    const pass=e.estimatedMinutes>=fixture.expectedRange[0] && e.estimatedMinutes<=fixture.expectedRange[1];
    results.push({id:a.id,...e,pass});
  } catch(error) {results.push({id:fixture.assignment.id,pass:false,error:error.message});}
}
const report={promptVersion:PROMPT_VERSION,provider:process.env.INFERENCE_PROVIDER || 'mock',model:process.env.SNOWFLAKE_MODEL || null,results};
await writeFile(new URL('./results.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(results.some(r=>!r.pass)) process.exitCode=1;
