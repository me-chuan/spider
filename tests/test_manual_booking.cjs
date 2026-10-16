/* Offline protocol test: decrypts the userscript's RSA and AES output with Node crypto. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  createDecipheriv, generateKeyPairSync, webcrypto,
} = require('node:crypto');

const scriptPath = path.resolve(__dirname, '..', 'sjtu-manual-booking.user.js');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
let source = fs.readFileSync(scriptPath, 'utf8');
assert(source.includes("  const host = node('div');"));
source = source.replace(/const RSA_PUBLIC_KEY = '[^']+';/, `const RSA_PUBLIC_KEY = '${publicDer}';`);
source = source.replace("  const host = node('div');", [
  '  globalThis.testApi = { rsaEncrypt, aesEncryptEcb, randomAesKey, buildPayload, parseSlots, monitorInterval, datesInRange, planRangeQueries, nextMonitorDelay, apiErrorKind, applyRateCooldown, cooldownUntil };',
  '  return;',
  "  const host = node('div');",
].join('\n'));

const storage = new Map();
const context = vm.createContext({
  crypto: webcrypto,
  TextEncoder,
  atob,
  btoa,
  URLSearchParams,
  location: { origin: 'https://sports.sjtu.edu.cn' },
  document: { getElementById: () => null },
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  },
});
vm.runInContext(source, context, { filename: scriptPath });

function decryptRsa(ciphertext) {
  const jwk = privateKey.export({ format: 'jwk' });
  const parse = (value) => BigInt(`0x${Buffer.from(value, 'base64url').toString('hex')}`);
  const ciphertextBytes = Buffer.from(ciphertext, 'base64');
  let exponent = parse(jwk.d);
  let base = BigInt(`0x${ciphertextBytes.toString('hex')}`);
  const modulus = parse(jwk.n);
  let plain = 1n;
  while (exponent > 0n) {
    if (exponent & 1n) plain = (plain * base) % modulus;
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  const encoded = Buffer.from(plain.toString(16).padStart(ciphertextBytes.length * 2, '0'), 'hex');
  assert.equal(encoded[0], 0);
  assert.equal(encoded[1], 2);
  const separator = encoded.indexOf(0, 2);
  assert(separator >= 10);
  return encoded.subarray(separator + 1).toString();
}

async function main() {
  const { rsaEncrypt, aesEncryptEcb, randomAesKey, buildPayload, parseSlots,
    monitorInterval, datesInRange, planRangeQueries, nextMonitorDelay,
    apiErrorKind, applyRateCooldown, cooldownUntil } = context.testApi;
  assert.equal(monitorInterval(undefined), 180);
  assert.equal(monitorInterval(5), 60);
  assert.equal(monitorInterval(4000), 3600);
  const range = datesInRange(['2026-10-31', '2026-11-01', '2026-11-02'], '2026-10-31', '2026-11-01');
  assert.deepEqual(Array.from(range), ['2026-10-31', '2026-11-01']);
  assert.equal(datesInRange(['2026-11-01'], '2026-11-02', '2026-11-01').length, 0);
  const venueA = { key: 'a', name: '场馆A' };
  const venueB = { key: 'b', name: '场馆B' };
  const dateMaps = new Map([
    ['a', new Map([['2026-10-31', 'date-a-1'], ['2026-11-01', 'date-a-2']])],
    ['b', new Map([['2026-11-01', 'date-b-2']])],
  ]);
  const plan = planRangeQueries([venueA, venueB], dateMaps, range);
  assert.equal(plan.tasks.length, 3);
  assert.deepEqual(Array.from(plan.tasks, (task) => `${task.venue.key}|${task.date}|${task.dateId}`), [
    'a|2026-10-31|date-a-1', 'a|2026-11-01|date-a-2', 'b|2026-11-01|date-b-2',
  ]);
  assert.equal(plan.unopened.length, 1);
  assert.match(plan.unopened[0], /场馆B.*2026-10-31/);
  assert.equal(nextMonitorDelay(60, 0), 60000);
  assert.equal(nextMonitorDelay(60, 1), 120000);
  assert.equal(nextMonitorDelay(60, 2), 240000);
  assert.equal(nextMonitorDelay(60, 9), 900000);
  assert.equal(apiErrorKind(500, '接口 500：请求过于频繁，请稍后再试'), 'rate');
  assert.equal(apiErrorKind(500, '接口 500：服务器故障'), 'api');
  const now = Date.now();
  applyRateCooldown(null);
  assert(cooldownUntil() >= now + 120000);
  assert.equal(Number(storage.get('sjtu-manual-booking-rate-cooldown-v1')), cooldownUntil());
  applyRateCooldown('600');
  assert(cooldownUntil() >= now + 600000);
  const secret = randomAesKey();
  assert.match(secret, /^[0-9A-Z]{16}$/);
  const sid = await rsaEncrypt(secret);
  const tim = await rsaEncrypt('1791691200000');
  assert.equal(decryptRsa(sid), secret);
  assert.equal(decryptRsa(tim), '1791691200000');

  const venue = { key: 'venue|sport', name: '测试羽毛球场', type: '羽毛球', venueId: 'venue', fieldType: 'sport' };
  const price = { status: 0, count: 2, price: 35, sign: 'server-sign', slotId: 'slot-1' };
  const field = { fieldId: 'field-1', fieldName: '场地1', fieldDetailStatus: 0, priceList: [price] };
  const slots = parseSlots([field], venue, '2026-10-11');
  assert.equal(slots.length, 1);
  assert.equal(slots[0].time, '07:00-08:00');
  assert.equal(slots[0].orderable, true);
  assert.equal(parseSlots([{ ...field, priceList: [{ ...price, status: 1 }] }], venue, '2026-10-11').length, 0);
  const payload = buildPayload(venue, '2026-10-11', field, price, 0, { id: 'sport', name: '羽毛球', tension: 0 });
  assert.equal(payload.spaces[0].sign, 'server-sign');
  assert.equal(payload.spaces[0].venuePrice, 35);
  assert.equal(payload.spaces[0].scheduleTime, '07:00-08:00');
  assert.equal(payload.spaces[0].price, undefined);
  assert.equal(payload.week, '0');
  const encryptedBody = await aesEncryptEcb(JSON.stringify(payload), secret);
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(secret), null);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedBody, 'base64')), decipher.final()]).toString();
  assert.deepEqual(JSON.parse(decrypted), JSON.parse(JSON.stringify(payload)));
  console.log('Manual booking range, rate cooldown, RSA, AES, slots, and order payload: OK');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
