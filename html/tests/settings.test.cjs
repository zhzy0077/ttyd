// Run after `yarn build`: TTYD_BINARY=/path/to/ttyd node --test tests/settings.test.cjs
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium, firefox } = require('playwright');

const port = process.env.TTYD_TEST_PORT || '17682';
const url = `http://127.0.0.1:${port}`;
const storageKey = 'ttyd.settings.v1:/';
let server;
before(async () => {
    server = spawn(process.env.TTYD_BINARY || path.resolve(__dirname, '../../build/ttyd'), [
        '-W', '-i', '127.0.0.1', '-p', port, '-I', path.resolve(__dirname, '../dist/inline.html'),
        '-t', 'disableLeaveAlert=true', '-t', 'rendererType=dom', '-t', 'fontSize=18',
        '-t', 'theme={"background":"#ffffff","foreground":"#123456"}',
        'sh',
    ]);
    let error = '';
    server.stderr.on('data', data => { error += data; });
    server.on('error', e => { error += e.message; });
    for (let i = 0; i < 100; i++) {
        try { if ((await fetch(url)).ok) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`ttyd did not start: ${error}`);
});
after(() => server?.kill('SIGTERM'));

for (const engine of [chromium, firefox]) {
    test(`${engine.name()}: settings, persistence, resizing, and defaults`, async () => {
        const browser = await engine.launch({ headless: true });
        try {
            const context = await browser.newContext({ viewport: { width: 1000, height: 760 } });
            const page = await context.newPage();
            page.setDefaultTimeout(5000);
            await page.addInitScript(() => {
                window.testSockets = [];
                const OriginalWebSocket = window.WebSocket;
                window.WebSocket = class extends OriginalWebSocket {
                    constructor(...args) {
                        super(...args);
                        window.testSockets.push(this);
                    }
                };
            });
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(url);
            await page.waitForFunction(() => window.term?.options.fontSize === 18);
            const rowsBefore = await page.evaluate(() => window.term.rows);
            await page.getByRole('button', { name: 'Terminal settings', exact: true }).click();
            await page.getByLabel('Theme', { exact: true }).selectOption('nord');
            await page.getByLabel('Font family').fill('DejaVu Sans Mono, monospace');
            await page.getByLabel('Font family').press('Tab');
            await page.getByLabel('Font size (px)').fill('28');
            await page.getByLabel('Font size (px)').press('Tab');
            await page.getByLabel('Suppress terminal right-click menu').check();
            await page.waitForFunction(old => window.term.rows < old, rowsBefore);
            assert.equal(await page.evaluate(() => window.term.options.theme.background), '#2e3440');
            // Refit must use current font metrics, without an external resize.
            const fitChangedRows = await page.evaluate(() => {
                const rows = window.term.rows;
                window.term.fit();
                return rows !== window.term.rows;
            });
            assert.equal(fitChangedRows, false);
            const prevented = () => page.evaluate(() => {
                const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
                window.term.element.dispatchEvent(event);
                return event.defaultPrevented;
            });
            assert.equal(await prevented(), true);
            await page.evaluate(() => window.testSockets[0].close(4000, 'Test reconnect'));
            await page.waitForFunction(() => window.testSockets.length === 2 && window.testSockets[1].readyState === 1);
            await page.waitForFunction(() => window.term.options.fontSize === 28);
            assert.equal(await page.locator('.ttyd-settings').count(), 1);
            assert.equal(await page.evaluate(() => window.term.options.theme.background), '#2e3440');
            // Suppression applies to the terminal, not the settings controls.
            assert.equal(await page.evaluate(() => {
                const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
                document.querySelector('.ttyd-settings input').dispatchEvent(event);
                return event.defaultPrevented;
            }), false);
            await page.reload();
            await page.waitForFunction(() => window.term?.options.fontSize === 28);
            assert.equal(await prevented(), true);
            assert.equal(await page.evaluate(() => window.term.options.theme.background), '#2e3440');
            assert.equal(await page.evaluate(() => window.term.options.fontFamily), 'DejaVu Sans Mono, monospace');
            await page.getByRole('button', { name: 'Terminal settings', exact: true }).click();
            await page.screenshot({ path: `/tmp/ttyd-settings-${engine.name()}.png` });
            await page.getByLabel('Text', { exact: true }).fill('#abcdef');
            assert.equal(await page.evaluate(() => window.term.options.theme.foreground), '#abcdef');
            await page.getByRole('button', { name: 'Reset to server defaults' }).click();
            await page.waitForFunction(() => window.term.options.fontSize === 18);
            assert.equal(await page.evaluate(() => window.term.options.theme.foreground), '#123456');
            assert.equal(await prevented(), false);
            assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), null);
            await page.getByLabel('Font family').press('Escape');
            assert.equal(await page.getByRole('dialog').isVisible(), false);
            assert.deepEqual(errors, []);
            await page.setViewportSize({ width: 360, height: 640 });
            await page.getByRole('button', { name: 'Terminal settings', exact: true }).click();
            const bounds = await page.getByRole('dialog').boundingBox();
            assert(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 360);
            await context.close();

            // Bad storage and denied storage must leave the terminal usable.
            for (const unavailable of [false, true]) {
                const isolated = await browser.newContext();
                await isolated.addInitScript(({ unavailable, storageKey }) => {
                    if (unavailable) {
                        Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage denied'); } });
                    } else {
                        localStorage.setItem(storageKey, '{invalid json');
                    }
                }, { unavailable, storageKey });
                const tab = await isolated.newPage();
                await tab.goto(url);
                await tab.waitForFunction(() => window.term?.options.fontSize === 18);
                await tab.getByRole('button', { name: 'Terminal settings', exact: true }).click();
                await tab.getByLabel('Theme', { exact: true }).selectOption('light');
                assert.equal(await tab.evaluate(() => window.term.options.theme.background), '#ffffff');
                if (unavailable) assert.match(await tab.getByRole('status').textContent(), /unavailable/);
                await isolated.close();
            }
        } finally {
            await browser.close();
        }
    });
}
