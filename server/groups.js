import {assignmentPayload} from './inference.js';

export function batchSizeFromEnv(env={}) {
  const value=String(env.INFERENCE_BATCH_SIZE ?? '5');
  if(!['1','5','10'].includes(value)) throw new Error('INFERENCE_BATCH_SIZE must be 1, 5, or 10');
  return Number(value);
}

// UTF-8 bytes conservatively bound text tokens without adding a model-specific tokenizer.
// This is a grouping budget, not a guarantee about a provider's context window.
// Oversize individual assignments remain singletons, subject to provider limits.
export function packGroups(assignments, size, byteBudget=16000) {
  if(![1,5,10].includes(size)) throw new Error('Invalid inference batch size');
  const groups=[];let group=[],bytes=0;
  assignments.forEach((assignment,index)=>{
    const length=Buffer.byteLength(JSON.stringify({id:String(size-1),...assignmentPayload(assignment)}))+1;
    if(group.length && (group.length>=size || bytes+length>byteBudget)) {groups.push(group);group=[];bytes=0;}
    group.push({assignment,index});bytes+=length;
  });
  if(group.length) groups.push(group);
  return groups;
}
