// Run after `yarn build`: TTYD_BINARY=/path/to/ttyd node --test tests/paste.test.cjs
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require('playwright');

const port = process.env.TTYD_TEST_PORT || '17683';
const url = `http://127.0.0.1:${port}`;
const binary = process.env.TTYD_BINARY || path.resolve(__dirname, '../../build/ttyd');
let server;
let serverErr = '';

before(async () => {
    server = spawn(binary, [
        '-W', '-i', '127.0.0.1', '-p', port, '-I', path.resolve(__dirname, '../dist/inline.html'),
        '-t', 'disableLeaveAlert=true', '-t', 'rendererType=dom',
        'cat',
    ]);
    server.stderr.on('data', data => { serverErr += data; });
    server.on('error', e => { serverErr += e.message; });
    for (let i = 0; i < 100; i++) {
        try { if ((await fetch(url)).ok) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`ttyd did not start: ${serverErr}`);
});
after(() => server?.kill('SIGTERM'));

const payload = ` Ran python3 - <<'PY'
  │ import json,pathlib,shutil
  │ r=json.load(open('/tmp/sqlite-five-apps-benchmark/results.json'))
  │ … +48 lines
  └ | SQL on each app | main: all five finish (ms) | worker branch: all five finish (ms) | main: peak loop delay (ms) | worker branch: peak loop delay (ms) |
    | --- | ---: | ---: | ---: | ---: |
    … +5 lines (ctrl + t to view transcript)
    ?? packages/data-engine/benchmark/sqlite-worker-five-apps.json
    ?? packages/data-engine/benchmark/sqlite-worker-five-apps.md

${'─'.repeat(200)}

• Tested locally: five concurrent calls to five separate databases, each containing 300,000 rows. Medians across five runs; all values in milliseconds:

   Operation          main: all 5 finish    Worker: all 5 finish    main: loop delay    Worker: loop delay
  ${'━'.repeat(90)}
   Aggregate                         362                     103                 363                     1
   Read all rows                   2,771                   2,019               2,770                 1,024
   Update all rows                 1,465                     383               1,464                     1
   Create index                      843                     241                 843                     1

  Workers were 3.5–3.8× faster for aggregation, updates, and index creation. Returning 1.5 million rows still blocked the main thread for about one second.

  This tests SQL calls, not existing HTTP routes. No production access.

  Full report and methodology (packages/data-engine/benchmark/sqlite-worker-five-apps.md)
`;

test('large unicode paste does not close the websocket', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(8000);
        await page.addInitScript(() => {
            window.testSockets = [];
            window.testCloses = [];
            window.testInputSizes = [];
            const OriginalWebSocket = window.WebSocket;
            window.WebSocket = class extends OriginalWebSocket {
                constructor(...args) {
                    super(...args);
                    window.testSockets.push(this);
                    this.addEventListener('close', event => window.testCloses.push(event.code));
                    const origSend = this.send.bind(this);
                    this.send = data => {
                        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
                            : data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
                        if (bytes[0] === 0x30) window.testInputSizes.push(bytes.length);
                        return origSend(data);
                    };
                }
            };
        });
        await page.goto(url);
        await page.waitForFunction(() => window.term && window.testSockets.some(s => s.readyState === 1));
        await page.evaluate(text => window.term.paste(text), payload);
        await page.waitForFunction(() => window.testCloses.length > 0 || window.term.buffer.active.getLine(0)?.translateToString(true).includes('python3'));
        await new Promise(resolve => setTimeout(resolve, 400));
        const result = await page.evaluate(() => ({
            closes: window.testCloses,
            readyState: window.testSockets[0].readyState,
            inputSizes: window.testInputSizes,
        }));
        assert.deepEqual(result.closes, [], `websocket closed (${result.closes}); ttyd stderr:\n${serverErr}`);
        assert.equal(result.readyState, 1);
        assert.ok(result.inputSizes.length > 1, `expected chunked INPUT, got ${JSON.stringify(result.inputSizes)}`);
        assert.ok(result.inputSizes.every(n => n <= 513), `INPUT frame too large: ${JSON.stringify(result.inputSizes)}`);
    } finally {
        await browser.close();
    }
});

test('single large INPUT frame does not close the websocket', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(8000);
        await page.addInitScript(() => {
            window.testSockets = [];
            window.testCloses = [];
            const OriginalWebSocket = window.WebSocket;
            window.WebSocket = class extends OriginalWebSocket {
                constructor(...args) {
                    super(...args);
                    window.testSockets.push(this);
                    this.addEventListener('close', event => window.testCloses.push(event.code));
                }
            };
        });
        await page.goto(url);
        await page.waitForFunction(() => window.term && window.testSockets.some(s => s.readyState === 1));
        await page.evaluate(text => {
            const bytes = new TextEncoder().encode(text);
            const payload = new Uint8Array(bytes.length + 1);
            payload[0] = 0x30;
            payload.set(bytes, 1);
            window.testSockets[0].send(payload);
        }, payload);
        await new Promise(resolve => setTimeout(resolve, 500));
        const result = await page.evaluate(() => ({
            closes: window.testCloses,
            readyState: window.testSockets[0].readyState,
        }));
        assert.deepEqual(result.closes, [], `websocket closed (${result.closes}); ttyd stderr:\n${serverErr}`);
        assert.equal(result.readyState, 1);
        assert.ok(!serverErr.includes('rx buffer underflow'), serverErr);
    } finally {
        await browser.close();
    }
});
