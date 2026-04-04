#!/usr/bin/env node
const fs = require('node:fs');

const args = process.argv.slice(2);
const outputIdx = args.indexOf('--output-last-message');
const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : null;
const resumeIdx = args.indexOf('resume');
const isResume = resumeIdx >= 0;
const threadId = isResume ? args[resumeIdx + 1] : 'mock-container-thread-1';
const prompt = args[args.length - 1];

console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
console.log(JSON.stringify({ type: 'agent_message_delta', delta: 'M3_CONTAINER_PASS' }));

if (outputPath) {
  fs.writeFileSync(outputPath, 'M3_CONTAINER_PASS');
}

if (!prompt) {
  process.exit(2);
}
process.exit(0);
