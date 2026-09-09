// Run after `yarn build`: TTYD_BINARY=/path/to/ttyd node --test tests/upload.test.cjs
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const port = process.env.TTYD_TEST_PORT || '17684';
const url = `http://127.0.0.1:${port}`;
const uploadDir = '/tmp/ttyd';
let server;
let serverErr = '';

before(async () => {
    server = spawn(process.env.TTYD_BINARY || path.resolve(__dirname, '../../build/ttyd'), [
        '-W', '-i', '127.0.0.1', '-p', port, '-I', path.resolve(__dirname, '../dist/inline.html'),
        '-t', 'disableLeaveAlert=true', '-t', 'rendererType=dom',
        'sh',
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

test('POST /upload writes to /tmp/ttyd and returns the path', async () => {
    const name = `ttyd-upload-${Date.now()}.txt`;
    const body = 'hello from ttyd';
    const res = await fetch(`${url}/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.path, `${uploadDir}/${name}`);
    assert.equal(fs.readFileSync(json.path, 'utf8'), body);
    fs.unlinkSync(json.path);
});

test('POST /upload rejects path traversal and GET', async () => {
    const res = await fetch(`${url}/upload?name=${encodeURIComponent('../escape.txt')}`, {
        method: 'POST',
        body: 'nope',
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.path, `${uploadDir}/escape.txt`);
    assert.equal(path.dirname(json.path), uploadDir);
    fs.unlinkSync(json.path);
    assert.equal((await fetch(`${url}/upload?name=x`)).status, 405);
});

test('settings Upload file copies the server path', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1000, height: 760 } });
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        await page.goto(url);
        await page.waitForFunction(() => window.term);
        await page.getByRole('button', { name: 'Terminal settings', exact: true }).click();
        const name = `ttyd-ui-${Date.now()}.txt`;
        await page.locator('[data-upload-input]').setInputFiles({
            name,
            mimeType: 'text/plain',
            buffer: Buffer.from('from-browser'),
        });
        const dest = `${uploadDir}/${name}`;
        await page.waitForFunction(dest => document.querySelector('[role="status"]')?.textContent?.includes(dest), dest);
        assert.equal(fs.readFileSync(dest, 'utf8'), 'from-browser');
        const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
        if (copied) assert.equal(copied, dest);
        fs.unlinkSync(dest);
        await context.close();
    } finally {
        await browser.close();
    }
});
