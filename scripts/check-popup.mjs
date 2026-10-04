import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'patchright';

// An isolated extension page, not a Windows native toolbar-popup benchmark.
// No account, live game page, claim command or external request is used.
const membership = readFileSync('/proc/self/cgroup', 'utf8');
const cgroupPath = membership.split('\n').find(line => line.startsWith('0::'))?.slice(3);
if (!cgroupPath?.includes('epic-popup-check.service')) throw new Error('Use the bounded epic-popup-check.service');
const limit = name => readFileSync(`/sys/fs/cgroup${cgroupPath}/${name}`, 'utf8').trim();
const bounded = (name, max) => {
  const value = limit(name);
  assert.match(value, /^\d+$/);
  assert.ok(BigInt(value) > 0n && BigInt(value) <= max, `${name} exceeds test bounds`);
  return Number(value);
};
const limits = { memory: bounded('memory.max', 2147483648n), tasks: bounded('pids.max', 256n),
  swap: limit('memory.swap.max'), cpu: limit('cpu.max') };
assert.equal(limits.swap, '0');
const cpu = limits.cpu.match(/^(\d+) (\d+)$/);
assert.ok(cpu && BigInt(cpu[1]) > 0n && BigInt(cpu[1]) * 2n <= BigInt(cpu[2]) * 3n);

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.local/epic-free');
mkdirSync(directory, { recursive: true });
const extension = path.join(root, 'browser-extension');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { limits, measurements: [], requests: [], errors: [], workerStarts: 0 };
let context, timer;

async function check() {
  context = await chromium.launchPersistentContext(path.join(directory, `popup-check-${Date.now()}`), {
    channel: 'chromium', headless: true, timeout: 15000,
    args: ['--disable-gpu', '--disable-background-networking', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(5000);
  await context.route('**/*', route => {
    if (route.request().url().startsWith('chrome-extension://')) return route.continue();
    report.requests.push(new URL(route.request().url()).origin);
    return route.abort('blockedbyclient');
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const workerUrl = worker.url();
  const popupUrl = `chrome-extension://${new URL(workerUrl).host}/popup.html`;
  for (let i = 0; i < 50; i++) {
    if ((await worker.evaluate(() => chrome.storage.local.get('status'))).status) break;
    await delay(50);
  }
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ settings: { enabled: false, hour: 23, minute: 35 }, job: null,
      status: { state: 'already_owned', running: false, note: '本轮游戏已全部在库中。',
        updatedAt: '2026-10-01T16:03:11Z', games: [1, 2].map(n => ({ title: `Popup fixture ${n}`,
          url: `https://store.epicgames.com/p/popup-fixture-${n}`, status: 'already_owned' })) } });
  });

  const client = await context.newCDPSession(context.pages()[0]);
  const versions = new Map();
  let observing = false;
  client.on('ServiceWorker.workerVersionUpdated', event => {
    for (const version of event.versions) {
      if (observing && version.scriptURL === workerUrl &&
          ['starting', 'running'].includes(version.runningStatus) &&
          versions.get(version.versionId)?.runningStatus !== version.runningStatus) report.workerStarts++;
      versions.set(version.versionId, version);
    }
  });
  await client.send('ServiceWorker.enable');
  let version;
  for (let i = 0; i < 50; i++) {
    version = [...versions.values()].find(value => value.scriptURL === workerUrl);
    if (version) break;
    await delay(50);
  }
  assert.ok(version, 'The worker must be visible before testing its suspension');
  await client.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  for (let i = 0; i < 50 && versions.get(version.versionId)?.runningStatus !== 'stopped'; i++) await delay(50);
  assert.equal(versions.get(version.versionId)?.runningStatus, 'stopped');
  observing = true;

  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(popupUrl);
    await page.waitForFunction(() => !document.getElementById('run-button').disabled);
    const renderedMs = Math.round(performance.now() - start);
    assert.equal(await page.locator('#game-list li').count(), 2);
    assert.equal(await page.locator('#status-text').textContent(), '本周游戏已在你的游戏库中');
    // Allow startup events to arrive before asserting that the worker stayed asleep.
    await delay(150);
    report.measurements.push({ label: `open-${i + 1}`, renderedMs,
      workerStatus: versions.get(version.versionId)?.runningStatus });
    // Keep these test tabs open: closing a tab emits tabs.onRemoved, a
    // separate background event that native popup closure does not emit.
  }
  assert.equal(report.workerStarts, 0, 'Opening saved results must not wake the claim worker');
  assert.ok(report.measurements.every(value => value.workerStatus === 'stopped'));
  assert.deepEqual(report.requests, []);
  assert.deepEqual(report.errors, []);
  report.sourceVersion = JSON.parse(readFileSync(path.join(extension, 'manifest.json'), 'utf8')).version;
}

try {
  await Promise.race([check(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Popup browser check deadline')), 45000);
  })]);
  report.passed = true;
  console.log(JSON.stringify(report));
} catch (error) {
  report.passed = false;report.error = error.message;
  console.error(error.stack);process.exitCode = 1;
} finally {
  clearTimeout(timer);
  if (context) await context.close();
  writeFileSync(path.join(directory, 'popup-browser-check.json'), `${JSON.stringify(report, null, 2)}\n`);
}
