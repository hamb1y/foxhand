// Isolated helper regressions: no real browser or profile.
import assert from 'node:assert/strict';
import { ExtensionBridge } from '../mcp-server/dist/bridge/bridge.js';
import { McpHttp } from '../mcp-server/dist/http.js';
import { fmt } from '../mcp-server/dist/tools/helpers.js';
import { withSignal, setPendingThought, takePendingThought } from '../mcp-server/dist/bridge/thought.js';
const bridge = new ExtensionBridge();
bridge.connect({ send() {} }, { extensionId: 'test', version: '0.5.7', profile: 'isolated-test', firefoxVersion: 'test', capabilities: [] });
bridge.receive({ event: 'tab.updated', data: { url: 'https://before.test' } });
assert.equal((await bridge.waitForEvent(['tab.updated'], () => true, 500, { afterSeq: 0 })).data.url, 'https://before.test');
const waiting = assert.rejects(bridge.waitForEvent(['download.done'], () => true, 1000), { code: 'PAUSED' });
bridge.setPaused(true);
await waiting;
await assert.rejects(bridge.waitForEvent(['tab.updated'], () => true, 500, { afterSeq: 0 }), { code: 'PAUSED' });
bridge.receive({ event: 'tab.updated', data: { url: 'https://during-pause.test' } });
bridge.setPaused(false);
const resumed = bridge.waitForEvent(['tab.updated'], () => true, 500, { afterSeq: 0 });
bridge.receive({ event: 'tab.updated', data: { url: 'https://after.test' } });
assert.equal((await resumed).data.url, 'https://after.test');
const signal = new AbortController().signal;
withSignal(signal, () => {
  setPendingThought('request-local');
  assert.equal(takePendingThought(), 'request-local');
});
withSignal(signal, () => { setPendingThought('must not cross requests'); });
withSignal(signal, () => assert.equal(takePendingThought(), undefined));
assert.equal(JSON.parse(fmt({ nested: ['x'.repeat(40000)] })).truncated, true);
// Simulate a network adapter appearing; the retry must accept Address errors too.
const http = new McpHttp(bridge);
const listen = http.listenOne.bind(http);
http.listenOne = async () => ({ err: "Address 192.0.2.77 doesn't exist on this machine yet." });
try {
  await http.apply({ port: 0, bind: '192.0.2.77', token: 'x'.repeat(32), confirmDestructive: true, cmdTimeoutMs: 30000, allowWsl: false });
  assert.equal(http.status.listening, false);
  http.listenOne = (app, port) => listen(app, port, '127.0.0.1');
  await http.reconcile();
  assert.equal(http.status.listening, true);
} finally { await http.stop(); bridge.disconnect(); }
console.log('Audit helper regressions passed: pause clears/wakes/rejects event access, request-local thoughts, valid oversized JSON, missing-address recovery.');
