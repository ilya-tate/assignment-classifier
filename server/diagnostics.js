import {appendFile, mkdir} from 'node:fs/promises';
import path from 'node:path';

// Callers supply only timings/counts/status metadata, never prompts or response text.
export function createInferenceLog(directory, batchId) {
  const file = directory ? path.join(directory, `inference-${batchId}.jsonl`) : null;
  let writes = Promise.resolve();
  let writeFailed = false;
  return {
    file: file ? path.relative(process.cwd(), file) : 'server logs',
    emit(event, fields = {}) {
      const line = JSON.stringify({at:new Date().toISOString(),batchId,event,...fields});
      console.info(line);
      if (!directory) return;
      writes = writes.then(async () => {
        await mkdir(directory,{recursive:true});
        await appendFile(file, `${line}\n`);
      }).catch(() => { if (!writeFailed) console.error('Inference diagnostic file could not be written.'); writeFailed=true; });
    },
    flush: () => writes
  };
}
