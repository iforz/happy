import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.HAPPY_SMOKE_URL || 'http://localhost:8081';
const target = new URL(base);
if (target.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
    throw new Error('Smoke tests only visit a local HTTP origin.');
}
const out = path.join(root, '.happy-web-local', 'smoke');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const blocked = [];
const pageErrors = [];
const responses = [];
// A production bundle pins its domain; replay those requests locally only.
await context.route('**/*', async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === 'https://ai.iforz.cn' && process.env.HAPPY_SMOKE_PRODUCTION === '1') {
        const response = await route.fetch({ url: `${target.origin}${requestUrl.pathname}${requestUrl.search}` });
        return route.fulfill({ response });
    }
    if (['localhost', '127.0.0.1', '[::1]'].includes(requestUrl.hostname) || ['data:', 'blob:'].includes(requestUrl.protocol)) {
        return route.continue();
    }
    blocked.push(requestUrl.origin);
    return route.abort();
});
const page = await context.newPage();
page.on('pageerror', error => pageErrors.push(error.message));
page.on('response', response => { if (response.status() >= 400) responses.push({ url: response.url().split('?')[0], status: response.status() }); });
try {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(() => document.body.innerText.trim().length > 20, null, { timeout: 180000 });
    await page.waitForTimeout(4000);
    const desktopText = await page.locator('body').innerText();
    await page.screenshot({ path: path.join(out, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(out, 'mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${target.origin}/server`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(3000);
    const serverText = await page.locator('body').innerText();
    await page.screenshot({ path: path.join(out, 'server.png'), fullPage: true });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const report = { base, desktopText, serverText, pageErrors, blockedOrigins: [...new Set(blocked)], failedResponses: responses };
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (pageErrors.length) process.exitCode = 1;
} finally {
    await browser.close();
}
