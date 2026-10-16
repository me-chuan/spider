/* Offline browser integration tests. All sports.sjtu.edu.cn responses are mocked. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const ORIGIN = 'https://sports.sjtu.edu.cn';
const RELEASE_AT = Date.parse('2026-10-11T12:00:00+08:00');
const TARGET = '2026-10-18';
const scriptPath = path.resolve(__dirname, '..', 'sjtu-noon-booking.user.js');
const manualScriptPath = path.resolve(__dirname, '..', 'sjtu-manual-booking.user.js');
const source = fs.readFileSync(scriptPath, 'utf8');
const publicKey = source.match(/const RSA_PUBLIC_KEY = '([^']+)'/)[1];
const venues = [
  { key: '0c6edc93-87ac-41b0-9895-6b66fda93fe5|19f69e5c-872f-4fbb-b9fe-70d6337c2d93', id: '0c6edc93-87ac-41b0-9895-6b66fda93fe5', type: '19f69e5c-872f-4fbb-b9fe-70d6337c2d93', field: 'court-a' },
  { key: '3466293b-a7d8-45be-a918-8526e3bed4c5|4dd7ae28-cf27-4369-9bc4-ee75b8e3cc76', id: '3466293b-a7d8-45be-a918-8526e3bed4c5', type: '4dd7ae28-cf27-4369-9bc4-ee75b8e3cc76', field: 'court-b' },
];

function slot(fieldId, available = true) {
  return [{
    fieldId, fieldName: fieldId, fieldDetailStatus: 0,
    priceList: Array.from({ length: 15 }, (_, index) => ({
      count: available && index === 0 ? 1 : 0,
      status: 0, price: 40, sign: `signature-${fieldId}-${index}`,
    })),
  }];
}

async function setup(browser, scenario = {}) {
  const context = await browser.newContext({ timezoneId: 'Asia/Shanghai' });
  await context.addInitScript((initial) => {
    const NativeDate = Date;
    let now = initial;
    window.__setMockNow = (value) => { now = value; };
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
  }, RELEASE_AT - 2000);
  await context.addCookies([{
    name: 'JSESSIONID', value: 'offline-session', domain: 'sports.sjtu.edu.cn',
    path: '/', httpOnly: true, secure: true,
  }]);
  const records = { orders: [], targetDateQueries: 0, targetSituations: 0, activeQueries: 0, maxActiveQueries: 0 };
  await context.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.endsWith('/pc/')) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body><script src="/pc/static/js/app.test.js"></script><main>Mock booking page</main></body></html>' });
      return;
    }
    if (url.includes('/pc/static/js/app.test.js')) {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: `setPublicKey("${scenario.wrongKey ? 'MIIB' + 'A'.repeat(400) : publicKey}")` });
      return;
    }
    const data = url.includes('ConfirmOrder') ? {} : req.postDataJSON?.() || {};
    const venue = venues.find((item) => item.id === (data.id || data.venueId)) || venues[0];
    const json = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(body),
    });
    if (url.includes('queryVenueById')) {
      await json({ code: 0, data: { motionTypes: [{ id: venue.type, name: '网球', tension: 0 }] } });
    } else if (url.includes('queryFieldReserveSituationIsFull')) {
      const afterNoon = req.frame().page().evaluate(() => Date.now() >= window.__testReleaseAt).catch(() => false);
      // The fake clock lives in each page, so simultaneous tabs can advance independently.
      const released = await afterNoon;
      if (released) records.targetDateQueries += 1;
      if (scenario.authAtRelease && released) {
        await json({ code: 401, msg: '登录超时' });
      } else if (scenario.rateOnce && released && records.targetDateQueries === 1) {
        await json({ code: 429, msg: '请求频繁' }, 429);
      } else {
        if (released && scenario.dateDelayMs) await new Promise((resolve) => setTimeout(resolve, scenario.dateDelayMs));
        await json({ code: 0, data: [
          { date: '2026-10-11', dateId: 'old-date-id' },
          ...((released || scenario.preopenTarget) && !scenario.hideTarget ? [{ date: TARGET, dateId: `new-${venue.field}` }] : []),
        ] });
      }
    } else if (url.includes('queryFieldSituation')) {
      if (data.date === TARGET) {
        records.targetSituations += 1;
        records.activeQueries += 1;
        records.maxActiveQueries = Math.max(records.maxActiveQueries, records.activeQueries);
      }
      try {
        if (data.date === TARGET && scenario.situationDelayMs) await new Promise((resolve) => setTimeout(resolve, scenario.situationDelayMs));
        const available = data.date !== TARGET || (!scenario.soldOut && !(scenario.soldOutRecheck && records.targetSituations > 1));
        await json({ code: 0, data: slot(venue.field, available) });
      } finally {
        if (data.date === TARGET) records.activeQueries -= 1;
      }
    } else if (url.includes('ConfirmOrder')) {
      records.orders.push({ headers: req.headers(), body: req.postData() });
      if (scenario.orderUnknown) await route.abort('timedout');
      else if (scenario.rejectFirst && records.orders.length === 1) await json({ code: 400, msg: '场次已被抢走' });
      else await json({ code: 0, data: 'offline-order-1' });
    } else await route.abort();
  });
  const newPage = async () => {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/pc/`);
    await page.evaluate((key) => localStorage.setItem('sjtu-manual-booking-settings-v1', JSON.stringify({ venues: [key] })), venues[0].key);
    await page.evaluate((releaseAt) => { window.__testReleaseAt = releaseAt; }, RELEASE_AT);
    await page.addScriptTag({ path: scriptPath });
    const ui = page.locator('#sjtu-noon-booking-host');
    await ui.locator('#launcher').click();
    return { page, ui };
  };
  return { context, records, newPage };
}

async function arm(tab, candidateVenues = [venues[0]]) {
  const { ui } = tab;
  for (const venue of candidateVenues) {
    await ui.locator('#auto-sport').selectOption('网球');
    await ui.locator('#auto-venue').selectOption(venue.key);
    await ui.locator('#auto-time').selectOption('0');
    await ui.locator('#add-candidate').click();
  }
  await ui.locator('#auto-arm').click();
  assert((await ui.locator('#arm-confirm-text').textContent()).includes(TARGET));
  await ui.locator('#arm-submit').click();
  await expectPhase(tab, '等待放号');
}

async function release(tab) {
  await tab.page.evaluate((time) => window.__setMockNow(time), RELEASE_AT + 100);
  await tab.page.bringToFront();
}

async function expectPhase(tab, phase, timeout = 10000) {
  await tab.page.waitForFunction((name) => {
    const host = document.querySelector('#sjtu-noon-booking-host');
    return host?.shadowRoot?.querySelector('#auto-status')?.textContent.startsWith(name);
  }, phase, { timeout });
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
  });
  try {
    {
      const harness = await setup(browser, { dateDelayMs: 150 });
      const tab = await harness.newPage();
      await tab.page.addScriptTag({ path: manualScriptPath });
      const manual = tab.page.locator('#sjtu-manual-booking-host');
      assert.equal(await tab.ui.locator('#query').count(), 0);
      assert.equal(await manual.locator('#auto-arm').count(), 0);
      await manual.locator('#launcher').click();
      await tab.page.waitForFunction(() => document.querySelector('#sjtu-manual-booking-host')?.shadowRoot?.querySelector('#query')?.disabled === false);
      await manual.locator('#query').click();
      await manual.locator('.slot').first().waitFor({ state: 'visible' });
      await manual.locator('.slot').first().click();
      await manual.locator('#order').click();
      assert((await manual.locator('#confirm-text').textContent()).includes('07:00-08:00'));
      await manual.locator('#cancel').click();
      await manual.locator('#close').click();
      await arm(tab, venues);
      assert.equal(await tab.ui.locator('#auto-arm').isDisabled(), true);
      assert.equal(await tab.ui.locator('#auto-target').textContent().then((value) => value.includes(`${TARGET} 场地`)), true);
      assert.equal(harness.records.targetDateQueries, 0);
      await release(tab);
      await expectPhase(tab, '成功');
      assert.equal(harness.records.orders.length, 1);
      assert(harness.records.orders[0].headers.sid);
      assert(harness.records.orders[0].headers.tim);
      assert(harness.records.orders[0].body.length > 100);
      assert(harness.records.maxActiveQueries <= 2);
      assert.equal(await tab.page.evaluate(() => JSON.parse(localStorage.getItem('sjtu-manual-booking-attempt-v1')).stage), 'success');
      await tab.page.reload();
      await tab.page.addScriptTag({ path: scriptPath });
      assert.equal(harness.records.orders.length, 1);
      await harness.context.close();
    }
    {
      const harness = await setup(browser, { preopenTarget: true });
      const tab = await harness.newPage();
      await tab.page.addScriptTag({ path: manualScriptPath });
      const manual = tab.page.locator('#sjtu-manual-booking-host');
      await manual.locator('#launcher').click();
      await tab.page.waitForFunction(() => document.querySelector('#sjtu-manual-booking-host')?.shadowRoot?.querySelector('#date-start option[value="2026-10-18"]'));
      await manual.locator('#date-start').selectOption(TARGET);
      await manual.locator('#date-end').selectOption(TARGET);
      await manual.locator('#query').click();
      await manual.locator('.slot').first().waitFor({ state: 'visible' });
      await manual.locator('.slot').first().click();
      await manual.locator('#order').click();
      await manual.locator('#submit').click();
      await tab.page.waitForFunction(() => document.querySelector('#sjtu-manual-booking-host')?.shadowRoot?.querySelector('#status')?.textContent.includes('未付款订单已创建'));
      assert.equal(await tab.page.evaluate((date) => JSON.parse(localStorage.getItem(`sjtu-manual-booking-manual-attempt-${date}`)).stage, TARGET), 'success');
      assert.equal(harness.records.orders.length, 1);
      await manual.locator('#close').click();
      await tab.ui.locator('#auto-sport').selectOption('网球');
      await tab.ui.locator('#auto-venue').selectOption(venues[0].key);
      await tab.ui.locator('#add-candidate').click();
      assert.equal(await tab.ui.locator('#auto-arm').isDisabled(), true);
      assert.equal(harness.records.orders.length, 1);
      await harness.context.close();
    }
    {
      const harness = await setup(browser, { wrongKey: true });
      const tab = await harness.newPage();
      await tab.ui.locator('#auto-sport').selectOption('网球');
      await tab.ui.locator('#auto-venue').selectOption(venues[0].key);
      await tab.ui.locator('#add-candidate').click();
      await tab.ui.locator('#auto-arm').click();
      await tab.ui.locator('#arm-submit').click();
      await expectPhase(tab, '已停止');
      assert((await tab.ui.locator('#auto-status').textContent()).includes('公钥'));
      assert.equal(harness.records.orders.length, 0);
      await harness.context.close();
    }
    {
      const harness = await setup(browser, { hideTarget: true });
      const tab = await harness.newPage();
      await arm(tab);
      await release(tab);
      await expectPhase(tab, '日期未开放');
      await tab.page.evaluate((time) => window.__setMockNow(time), RELEASE_AT + 301000);
      await expectPhase(tab, '已停止');
      assert.equal(harness.records.orders.length, 0);
      await harness.context.close();
    }
    {
      const harness = await setup(browser, { authAtRelease: true });
      const tab = await harness.newPage();
      await arm(tab);
      await release(tab);
      await expectPhase(tab, '已停止');
      assert.equal(harness.records.orders.length, 0);
      assert((await tab.ui.locator('#auto-status').textContent()).includes('登录'));
      await harness.context.close();
    }
    {
      const harness = await setup(browser, { soldOutRecheck: true });
      const tab = await harness.newPage();
      await arm(tab);
      await release(tab);
      await tab.page.waitForFunction(() => document.querySelector('#sjtu-noon-booking-host')?.shadowRoot?.querySelector('#auto-log')?.textContent.includes('场次已变化'));
      assert.equal(harness.records.orders.length, 0);
      await harness.context.close();
    }
    {
      const harness = await setup(browser, { situationDelayMs: 500 });
      const tab = await harness.newPage();
      await arm(tab);
      await release(tab);
      await tab.page.waitForFunction(() => document.querySelector('#sjtu-noon-booking-host')?.shadowRoot?.querySelector('#auto-log')?.textContent.includes('再次核对'));
      await tab.ui.locator('#auto-stop').click();
      await expectPhase(tab, '已停止');
      assert.equal(harness.records.orders.length, 0);
      await harness.context.close();
    }
    {
      const harness = await setup(browser, { rateOnce: true, rejectFirst: true });
      const tab = await harness.newPage();
      await arm(tab, venues);
      await release(tab);
      await expectPhase(tab, '成功');
      assert(harness.records.targetDateQueries >= 2);
      assert.equal(harness.records.orders.length, 2);
      await harness.context.close();
    }
    {
      const harness = await setup(browser, { orderUnknown: true });
      const tab = await harness.newPage();
      await arm(tab);
      await release(tab);
      await expectPhase(tab, '结果未知');
      assert.equal(harness.records.orders.length, 1);
      await harness.context.close();
    }
    {
      const harness = await setup(browser);
      const first = await harness.newPage();
      const second = await harness.newPage();
      await Promise.all([arm(first), arm(second)]);
      await Promise.all([release(first), release(second)]);
      await Promise.all([first, second].map((tab) => tab.page.waitForFunction(() => {
        const status = document.querySelector('#sjtu-noon-booking-host')?.shadowRoot?.querySelector('#auto-status')?.textContent || '';
        return status.startsWith('成功') || status.startsWith('已停止');
      })));
      assert.equal(harness.records.orders.length, 1);
      await harness.context.close();
    }
    console.log('Auto booking mocked browser flow, auth, stale slot, unknown result, and two tabs: OK');
  } finally { await browser.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
