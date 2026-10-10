/* Offline browser smoke test. Requires Playwright and a Chromium-compatible browser. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const ORIGIN = 'https://sports.sjtu.edu.cn';
const venueKey = '0c6edc93-87ac-41b0-9895-6b66fda93fe5|19f69e5c-872f-4fbb-b9fe-70d6337c2d93';
const scriptPath = path.resolve(__dirname, '..', 'sjtu-venue-monitor.user.js');

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
  });
  try {
    const context = await browser.newContext({ timezoneId: 'Asia/Shanghai' });
    await context.addCookies([{
      name: 'JSESSIONID', value: 'offline-test-session', domain: 'sports.sjtu.edu.cn',
      path: '/', httpOnly: true, secure: true,
    }]);
    const page = await context.newPage();
    const sentCookies = [];
    const situationDates = [];
    await page.route(`${ORIGIN}/**`, async (route) => {
      const request = route.request();
      if (request.url().endsWith('/pc/')) {
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body><main>预约页面</main></body></html>' });
        return;
      }
      sentCookies.push(request.headers().cookie || '');
      if (request.url().includes('queryFieldReserveSituationIsFull')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          code: 0, data: [
            { date: '2026-10-10', dateId: 'date-id-1' },
            { date: '2026-10-11', dateId: 'date-id-2' },
          ],
        }) });
        return;
      }
      if (request.url().includes('queryFieldSituation')) {
        situationDates.push(JSON.parse(request.postData()).date);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          code: 0, data: [{
            fieldId: 'court-a', fieldName: 'Court A',
            priceList: Array.from({ length: 15 }, (_, index) => ({ count: index === 12 ? '2' : '0', status: 0 })),
          }],
        }) });
        return;
      }
      await route.abort();
    });
    await page.goto(`${ORIGIN}/pc/`);
    await page.evaluate((key) => localStorage.setItem('sjtu-venue-monitor-settings-v1', JSON.stringify({
      venues: [key], dates: [], datesChosen: false, startHour: 7, endHour: 22, interval: 60, notify: false,
    })), venueKey);
    await page.addScriptTag({ path: scriptPath });
    const ui = page.locator('#sjtu-venue-monitor-host');
    await ui.locator('#launcher').click();
    await page.waitForFunction(() => document.querySelector('#sjtu-venue-monitor-host').shadowRoot.querySelectorAll('#dates label').length === 2);
    assert.equal(await ui.locator('#venues label').count(), 7);
    assert.equal(await ui.locator('#dates label').count(), 2);
    await ui.locator('#dates label').nth(0).locator('input').uncheck();
    await ui.locator('#dates label').nth(1).locator('input').check();
    await ui.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#sjtu-venue-monitor-host').shadowRoot.querySelector('#slots').textContent.includes('余量 2'));
    assert.deepEqual(situationDates, ['2026-10-11']);
    assert(sentCookies.every((cookie) => cookie.includes('JSESSIONID=offline-test-session')));
    assert((await ui.locator('#slots').textContent()).includes('19:00-20:00'));
    await ui.locator('#start').click();
    assert((await ui.locator('#status').textContent()).includes('已停止'));
    await page.evaluate(() => {
      const nextBody = document.createElement('body');
      nextBody.innerHTML = '<main>预约页面已重新渲染</main>';
      document.body.replaceWith(nextBody);
    });
    await page.waitForFunction(() => document.querySelector('#sjtu-venue-monitor-host')?.parentNode === document.body);
    assert(await ui.locator('#launcher').isVisible());
    assert((await ui.locator('#status').textContent()).includes('已停止'));
    if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH });
    console.log('Userscript UI, date selection, authenticated fetch, slot parsing, stop, and remount: OK');
    await context.close();

    const authContext = await browser.newContext();
    const authPage = await authContext.newPage();
    await authPage.route(`${ORIGIN}/**`, async (route) => {
      if (route.request().url().endsWith('/pc/')) {
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body>预约页面</body></html>' });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 401, msg: '登录超时', data: [] }) });
      }
    });
    await authPage.goto(`${ORIGIN}/pc/`);
    await authPage.evaluate((key) => localStorage.setItem('sjtu-venue-monitor-settings-v1', JSON.stringify({ venues: [key] })), venueKey);
    await authPage.addScriptTag({ path: scriptPath });
    await authPage.locator('#sjtu-venue-monitor-host #launcher').click();
    await authPage.waitForFunction(() => document.querySelector('#sjtu-venue-monitor-host').shadowRoot.querySelector('#status').textContent.includes('登录失效'));
    assert((await authPage.locator('#sjtu-venue-monitor-host #errors').textContent()).includes('401'));
    console.log('Userscript expired-login handling: OK');
    await authContext.close();
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
