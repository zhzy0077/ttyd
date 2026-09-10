// Static checks: node --test tests/alt.test.cjs
// PTY checks after `yarn build`: TTYD_BINARY=/path/to/ttyd node --test tests/alt.test.cjs
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, firefox } = require('playwright');

const staticPort = process.env.TTYD_ALT_STATIC_PORT || '17686';
const staticUrl = `http://127.0.0.1:${staticPort}`;
const ttydPort = process.env.TTYD_TEST_PORT || '17685';
const ttydUrl = `http://127.0.0.1:${ttydPort}`;
const binary = process.env.TTYD_BINARY || path.resolve(__dirname, '../../build/ttyd');
const hasTtyd = fs.existsSync(binary);
const dist = path.resolve(__dirname, '../dist');

function contentType(file) {
    if (file.endsWith('.html')) return 'text/html';
    if (file.endsWith('.js')) return 'application/javascript';
    if (file.endsWith('.css')) return 'text/css';
    if (file.endsWith('.png')) return 'image/png';
    return 'application/octet-stream';
}

let staticServer;
let ttydServer;
let ttydErr = '';

before(async () => {
    staticServer = http.createServer((req, res) => {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        const file = path.normalize(path.join(dist, urlPath === '/' ? 'index.html' : urlPath));
        if (!file.startsWith(dist)) {
            res.writeHead(403);
            res.end();
            return;
        }
        fs.readFile(file, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end();
                return;
            }
            res.writeHead(200, { 'Content-Type': contentType(file) });
            res.end(data);
        });
    });
    await new Promise((resolve, reject) => {
        staticServer.listen(staticPort, '127.0.0.1', resolve);
        staticServer.on('error', reject);
    });
    if (!hasTtyd) return;
    ttydServer = spawn(binary, [
        '-W', '-i', '127.0.0.1', '-p', ttydPort, '-I', path.resolve(__dirname, '../dist/inline.html'),
        '-t', 'disableLeaveAlert=true', '-t', 'rendererType=dom',
        'cat',
    ]);
    ttydServer.stderr.on('data', data => { ttydErr += data; });
    ttydServer.on('error', e => { ttydErr += e.message; });
    for (let i = 0; i < 100; i++) {
        try { if ((await fetch(ttydUrl)).ok) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`ttyd did not start: ${ttydErr}`);
});
after(() => {
    staticServer?.close();
    ttydServer?.kill('SIGTERM');
});

async function openPage(engine, url) {
    const browser = await engine.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    await page.addInitScript(() => {
        window.testSockets = [];
        window.testInput = [];
        const OriginalWebSocket = window.WebSocket;
        window.WebSocket = class extends OriginalWebSocket {
            constructor(...args) {
                super(...args);
                window.testSockets.push(this);
                const origSend = this.send.bind(this);
                this.send = data => {
                    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
                        : data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
                    if (bytes[0] === 0x30) window.testInput.push(Array.from(bytes.subarray(1)));
                    return origSend(data);
                };
            }
        };
    });
    await page.goto(url);
    await page.waitForFunction(() => window.term);
    await page.click('#terminal-container');
    return { browser, page };
}

function dispatchAlt(page) {
    return page.evaluate(() => {
        const textarea = document.querySelector('.xterm-helper-textarea');
        textarea.focus();
        const fire = (type, key, code) => {
            const event = new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true });
            textarea.dispatchEvent(event);
            return event.defaultPrevented;
        };
        return {
            down: fire('keydown', 'Alt', 'AltLeft'),
            up: fire('keyup', 'Alt', 'AltLeft'),
            altGraph: fire('keydown', 'AltGraph', 'AltRight'),
            letter: fire('keydown', 'a', 'KeyA'),
        };
    });
}

for (const engine of [chromium, firefox]) {
    test(`${engine.name()}: focused terminal captures Alt keydown and keyup`, async () => {
        const { browser, page } = await openPage(engine, staticUrl);
        try {
            const result = await dispatchAlt(page);
            assert.equal(result.down, true, `${engine.name()} Alt keydown was not captured`);
            assert.equal(result.up, true, `${engine.name()} Alt keyup was not captured`);
            assert.equal(result.altGraph, false, `${engine.name()} AltGraph should not be captured`);
            assert.equal(result.letter, false, `${engine.name()} plain letter should not be captured by Alt handler`);
        } finally {
            await browser.close();
        }
    });

    test(`${engine.name()}: settings fields do not capture Alt`, async () => {
        const { browser, page } = await openPage(engine, staticUrl);
        try {
            await page.getByRole('button', { name: 'Terminal settings', exact: true }).click();
            const result = await page.evaluate(() => {
                const input = document.querySelector('.ttyd-settings input[name="fontFamily"]');
                input.focus();
                const down = new KeyboardEvent('keydown', {
                    key: 'Alt',
                    code: 'AltLeft',
                    bubbles: true,
                    cancelable: true,
                });
                input.dispatchEvent(down);
                return { prevented: down.defaultPrevented, active: document.activeElement?.getAttribute('name') };
            });
            assert.equal(result.active, 'fontFamily');
            assert.equal(result.prevented, false);
        } finally {
            await browser.close();
        }
    });
}

const ptyTest = hasTtyd ? test : test.skip;

ptyTest('chromium: Alt+a is sent to the pty as ESC a', async () => {
    const { browser, page } = await openPage(chromium, ttydUrl);
    try {
        await page.waitForFunction(() => window.testSockets.some(s => s.readyState === 1));
        await page.keyboard.down('Alt');
        await page.keyboard.press('a');
        await page.keyboard.up('Alt');
        await page.waitForFunction(() => window.testInput.some(bytes => bytes[0] === 0x1b && bytes[1] === 0x61));
        const frames = await page.evaluate(() => window.testInput);
        assert.ok(frames.some(bytes => bytes[0] === 0x1b && bytes[1] === 0x61), `INPUT frames: ${JSON.stringify(frames)}`);
    } finally {
        await browser.close();
    }
});
