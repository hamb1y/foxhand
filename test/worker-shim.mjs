// Run packaged browser Worker code in a real isolated Node worker thread for VM tests.
import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../build/extension/regex-worker.js', import.meta.url), 'utf8');
export class BrowserWorker {
  constructor() {
    this.thread = new Worker(`const { parentPort } = require('node:worker_threads'); const self = { postMessage: value => parentPort.postMessage(value) }; ${source}; parentPort.on('message', data => self.onmessage({data}));`, { eval: true });
    this.thread.on('message', data => this.onmessage?.({ data }));
    this.thread.on('error', error => this.onerror?.(error));
  }
  postMessage(value) { this.thread.postMessage(value); }
  terminate() { void this.thread.terminate(); }
}
