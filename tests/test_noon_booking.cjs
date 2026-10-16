/* Pure date and candidate rules for the standalone noon booking script. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.resolve(__dirname, '..', 'sjtu-noon-booking.user.js');
let source = fs.readFileSync(scriptPath, 'utf8');
source = source.replace("  const host = node('div');", [
  '  globalThis.testApi = { nextRelease, matchingOptions, releaseWindowMinutes, releaseDeadline, apiErrorKind };',
  '  return;',
  "  const host = node('div');",
].join('\n'));
const context = vm.createContext({
  document: { getElementById: () => null },
  localStorage: { getItem: () => null },
});
vm.runInContext(source, context, { filename: scriptPath });
const { nextRelease, matchingOptions, releaseWindowMinutes, releaseDeadline, apiErrorKind } = context.testApi;

assert.equal(releaseWindowMinutes(undefined), 5);
assert.equal(releaseWindowMinutes(0.2), 1);
assert.equal(releaseWindowMinutes(20), 15);
const releaseAt = Date.parse('2026-10-11T12:00:00+08:00');
assert.equal(releaseDeadline(releaseAt, 5), Date.parse('2026-10-11T12:05:00+08:00'));
assert.equal(releaseDeadline(releaseAt, 15), Date.parse('2026-10-11T12:15:00+08:00'));
assert.equal(apiErrorKind(500, '接口 500：请求过于频繁'), 'rate');
assert.equal(apiErrorKind(500, '接口 500：服务异常'), 'server');
assert.equal(apiErrorKind(400, '接口 400：场次已被抢走'), 'api');

assert.deepEqual(JSON.parse(JSON.stringify(nextRelease(Date.parse('2026-10-11T11:59:59+08:00')))), {
  releaseDate: '2026-10-11', targetDate: '2026-10-18',
  releaseAt: Date.parse('2026-10-11T12:00:00+08:00'),
});
assert.equal(nextRelease(Date.parse('2026-10-11T12:00:00+08:00')).targetDate, '2026-10-19');
assert.equal(nextRelease(Date.parse('2026-12-31T11:59:59+08:00')).targetDate, '2027-01-07');

const venue = { key: 'venue|sport', name: '测试网球场', venueId: 'venue', fieldType: 'sport' };
const field = { fieldId: 'field-1', fieldName: '场地1', priceList: [{ status: 0, count: 2, price: 35, sign: 'fresh-sign' }] };
const run = {
  candidates: [
    { venueKey: venue.key, fieldId: '', index: 0 },
    { venueKey: venue.key, fieldId: 'field-1', index: 0 },
  ],
  failedOptions: new Set(),
};
assert.equal(matchingOptions(run, venue, [field], 'fresh-date-id').length, 2);
assert.equal(matchingOptions(run, venue, [{ ...field, priceList: [{ ...field.priceList[0], sign: '' }] }], 'fresh-date-id').length, 0);
assert.equal(matchingOptions(run, venue, [{ ...field, priceList: [{ ...field.priceList[0], status: 1 }] }], 'fresh-date-id').length, 0);
console.log('Noon boundary, retry window, server errors, candidate matching and signed-slot filter: OK');
