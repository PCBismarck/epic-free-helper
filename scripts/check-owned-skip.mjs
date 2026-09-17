import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'patchright';
import { PROMOTIONS_URL } from '../browser-extension/rules.js';

// Run only inside the caller's bounded systemd unit. No user browser/profile,
// real Epic response, account, or checkout is involved in this regression check.
const membership = readFileSync('/proc/self/cgroup', 'utf8');
const cgroupPath = membership.split('\n').find(line => line.startsWith('0::'))?.slice(3);
if (!cgroupPath?.includes('epic-owned-skip-check.service')) {
  throw new Error('Use the bounded epic-owned-skip-check.service');
}
const cgroupDirectory = `/sys/fs/cgroup${cgroupPath}`;
const readLimit = name => readFileSync(path.join(cgroupDirectory, name), 'utf8').trim();
const positiveLimit = (name, maximum) => {
  const value = readLimit(name);
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n || BigInt(value) > maximum) {
    throw new Error(`${name} must be finite, positive, and at most ${maximum}`);
  }
  return Number(value);
};
const limits = {
  memoryMaxBytes: positiveLimit('memory.max', 2n * 1024n * 1024n * 1024n),
  swapMaxBytes: readLimit('memory.swap.max'),
  tasksMax: positiveLimit('pids.max', 256n),
  cpuMax: readLimit('cpu.max'),
};
if (limits.swapMaxBytes !== '0') throw new Error('memory.swap.max must be exactly 0');
const cpu = limits.cpuMax.match(/^(\d+)\s+(\d+)$/);
if (!cpu || BigInt(cpu[1]) <= 0n || BigInt(cpu[2]) <= 0n || BigInt(cpu[1]) * 2n > BigInt(cpu[2]) * 3n) {
  throw new Error('cpu.max must be finite, positive, and no more than 150%');
}
limits.swapMaxBytes = 0;

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.local/epic-free');
const extension = path.join(root, 'browser-extension');
const profile = path.join(directory, `owned-skip-check-${Date.now()}`);
const reportPath = path.join(directory, 'owned-skip-browser-check.json');
const eventUrl = 'https://store.epicgames.com/__owned-skip-check-event';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixtures = [
  { slug: 'skip-fixture-one', title: 'Owned Fixture One' },
  { slug: 'skip-fixture-two', title: 'Owned Fixture Two' },
].map((game, index) => ({ ...game, id: `fixture-offer-${index + 1}`,
  namespace: `fixture-namespace-${index + 1}`, url: `https://store.epicgames.com/p/${game.slug}` }));
const now = Date.now();
const payload = { data: { Catalog: { searchStore: { elements: fixtures.map(game => ({
  title: game.title, id: game.id, namespace: game.namespace, offerType: 'BASE_GAME',
  categories: [{ path: 'games' }, { path: 'freegames' }],
  price: { totalPrice: { originalPrice: 1000, discountPrice: 0 } },
  offerMappings: [{ pageType: 'productHome', pageSlug: game.slug }],
  promotions: { promotionalOffers: [{ promotionalOffers: [{
    startDate: new Date(now - 86400000).toISOString(),
    endDate: new Date(now + 86400000).toISOString(),
    discountSetting: { discountType: 'PERCENTAGE', discountPercentage: 0 },
  }] }] },
})) } } } };

function html(game) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <title>${game.title}</title><link rel="icon" href="data:,">
    <style>body{font-family:sans-serif}egs-navigation{display:block;height:24px}
    button{padding:12px}main{max-width:600px;padding:24px}</style></head><body>
    <egs-navigation isloggedin="false"></egs-navigation>
    <main><h1>${game.title}</h1><div><span data-testid="price">免费</span>
    <button data-testid="purchase-cta-button">获取</button></div></main>
    <script>
      const emit = detail => {
        if (!navigator.sendBeacon(${JSON.stringify(eventUrl)}, JSON.stringify({
          fixture: ${JSON.stringify(game.slug)}, ...detail
        }))) throw new Error('Fixture event could not be queued');
      };
      document.addEventListener('click', event => {
        const target = event.target.closest('button');
        if (!target) return;
        if (target.matches('[data-testid="purchase-cta-button"]')) {
          emit({ kind: 'click', action: 'get', label: target.innerText });
        } else if (/add to library|place order|添加到库|下单/i.test(target.innerText)) {
          emit({ kind: 'click', action: 'submit', label: target.innerText });
        }
      }, true);
      // Epic briefly exposes logged-out/Get placeholders before ownership loads.
      setTimeout(() => document.querySelector('egs-navigation').setAttribute('isloggedin', 'true'), 450);
      setTimeout(() => {
        const button = document.querySelector('[data-testid="purchase-cta-button"]');
        button.innerText = '已在库中';
        button.disabled = true;
        emit({ kind: 'owned' });
      }, 2000);
    </script></body></html>`;
}

mkdirSync(directory, { recursive: true });
const navigations = Object.fromEntries(fixtures.map(game => [game.url, 0]));
const clicks = { get: 0, submit: 0 };
const events = [];
const blockedRequests = new Set();
const errors = [];
let context;
let worker;
let latestState;
let report;
let timeout;
let closing = false;

async function check() {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, timeout: 15000,
    args: ['--disable-gpu', '--disable-background-networking',
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(4000);
  let extensionOrigin;
  const observedPages = new WeakSet();
  const observe = page => {
    if (observedPages.has(page)) return;
    observedPages.add(page);
    page.on('pageerror', error => errors.push(error.message));
  };
  context.on('page', observe);
  context.pages().forEach(observe);

  await context.route('**/*', async route => {
    try {
      const request = route.request();
      // The shipped popup's local files are not network fixtures. Keep them
      // loadable if this Chromium version also routes extension-scheme URLs.
      if (extensionOrigin && request.url().startsWith(`${extensionOrigin}/`)) {
        await route.continue();
        return;
      }
      // Patchright can suppress console events. Receive fixture telemetry as
      // same-origin beacons instead, fulfilled locally before any network I/O.
      if (request.url() === eventUrl && request.method() === 'POST') {
        const event = JSON.parse(request.postData() || 'null');
        assert.ok(fixtures.some(game => game.slug === event?.fixture), 'Unknown fixture event source');
        assert.ok(event.kind === 'owned' ||
          (event.kind === 'click' && Object.hasOwn(clicks, event.action)), 'Unknown fixture event kind');
        events.push(event);
        if (event.kind === 'click') clicks[event.action]++;
        await route.fulfill({ status: 204, body: '' });
        return;
      }
      const game = fixtures.find(candidate => candidate.url === request.url());
      if (game && request.isNavigationRequest() && !request.frame().parentFrame()) {
        navigations[game.url]++;
        // While the second navigation is pending, Chrome can still expose the
        // previous owned document. It must never count as evidence for game two.
        if (game.slug === 'skip-fixture-two') await delay(400);
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html(game) });
      } else {
        blockedRequests.add(request.url());
        await route.abort('blockedbyclient');
      }
    } catch (error) {
      if (!closing) errors.push(`Fixture routing: ${error.message}`);
      await route.abort('blockedbyclient').catch(() => {});
    }
  });

  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
  extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
  // BrowserContext routing does not intercept service-worker fetches. Replace
  // only this test worker's fetch, rejecting every URL except the fixture API.
  await worker.evaluate(({ expectedUrl, payload }) => {
    globalThis.__ownedSkipPromotionsReads = 0;
    globalThis.fetch = async input => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (url !== expectedUrl) throw new Error(`Unexpected worker fetch: ${url}`);
      if (globalThis.__simulatePromotionsFailure) throw new Error('Simulated promotions outage');
      globalThis.__ownedSkipPromotionsReads++;
      return new Response(JSON.stringify(payload), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
  }, { expectedUrl: PROMOTIONS_URL, payload });

  const page = await context.newPage();
  await page.goto(`${extensionOrigin}/popup.html`);
  await page.waitForFunction(() => !document.getElementById('run-button').disabled);
  latestState = await worker.evaluate(() => chrome.storage.local.get(['settings', 'status', 'job']));
  assert.equal(latestState.status.state, 'idle', 'The empty test profile must start idle');
  assert.equal(latestState.settings.enabled, false, 'Scheduling must start disabled');
  assert.equal(latestState.job, null, 'The empty test profile must not contain a job');
  const toolbar = () => worker.evaluate(async () => ({
    text: await chrome.action.getBadgeText({}), color: await chrome.action.getBadgeBackgroundColor({}),
    title: await chrome.action.getTitle({}),
  }));
  const waitBadge = async text => {
    const deadline = Date.now() + 4000;
    let badge;
    do {
      badge = await toolbar();
      if (badge.text === text) return badge;
      await delay(100);
    } while (Date.now() < deadline);
    assert.equal(badge.text, text, 'Toolbar must follow the saved task state');
  };
  assert.equal((await toolbar()).text, '');

  // Exercise the shipped popup, message handler, background orchestration,
  // page engine and real Chrome extension APIs without patching any of them.
  await page.click('#run-button');
  const runningBadge = await waitBadge('…');
  assert.deepEqual(runningBadge.color, [37, 99, 235, 255]);
  while (true) {
    latestState = await worker.evaluate(() => chrome.storage.local.get(['settings', 'status', 'job']));
    if (latestState.status.state !== 'idle' && !latestState.status.running) break;
    await delay(200);
  }
  assert.equal(latestState.status.state, 'already_owned', 'Both owned games must finish successfully');
  assert.deepEqual(latestState.status.games.map(game => [game.url, game.status]),
    fixtures.map(game => [game.url, 'already_owned']), 'The second owned game must also be checked');
  assert.deepEqual(navigations, Object.fromEntries(fixtures.map(game => [game.url, 1])),
    'Owned games must be checked on their first document without a redundant reload');
  assert.deepEqual(clicks, { get: 0, submit: 0 }, 'Owned games must never be claimed again');
  assert.deepEqual(events.filter(event => event.kind === 'owned').map(event => event.fixture),
    fixtures.map(game => game.slug), 'Both product pages must hydrate their own ownership state');
  assert.equal(latestState.job, null, 'The completed run must clear its job');
  assert.equal(latestState.status.tabId, null, 'The completed run must clear its tab');
  assert.equal(latestState.settings.enabled, false, 'A manual run must leave scheduling disabled');
  assert.deepEqual(await worker.evaluate(() => chrome.alarms.getAll()), [], 'No daily or deadline alarm may remain');
  assert.equal(context.pages().some(open => fixtures.some(game => open.url() === game.url)), false,
    'The extension must close its completed task tab');
  const successBadge = await waitBadge('✓');
  assert.deepEqual(successBadge.color, [21, 128, 61, 255]);
  assert.match(successBadge.title, /全部确认在库（2 款）/);

  // A later scheduled run can fail before discovering games. The real popup,
  // worker and action APIs must replace the previous green badge with red.
  await worker.evaluate(() => { globalThis.__simulatePromotionsFailure = true; });
  await page.click('#run-button');
  const failureBadge = await waitBadge('!');
  assert.deepEqual(failureBadge.color, [220, 38, 38, 255]);
  assert.match(failureBadge.title, /需要处理/);
  assert.match(failureBadge.title, /每日定时已关闭/);
  const failedState = await worker.evaluate(() => chrome.storage.local.get(['status', 'job']));
  assert.equal(failedState.status.state, 'failed');
  assert.equal(failedState.job, null);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(`${extensionOrigin}/popup.html`);
  await reopened.waitForFunction(() => !document.getElementById('run-button').disabled);
  assert.equal((await toolbar()).text, '!', 'Opening the popup must not dismiss unresolved failures');
  assert.deepEqual(errors, [], 'The fixture and popup must not raise browser errors');
  report = {
    state: 'owned_skip_verified', popup: 'passed', extensionVersion: await worker.evaluate(() => chrome.runtime.getManifest().version),
    games: latestState.status.games.map(({ title, url, status }) => ({ title, url, status })),
    fixtureNavigations: navigations, ctaClicks: clicks, fixtureEvents: events,
    eventTransport: 'locally intercepted sendBeacon', job: latestState.job,
    timerEnabled: latestState.settings.enabled,
    toolbar: { running: runningBadge, success: successBadge, failure: failureBadge, failurePersistsAfterPopupReopen: true },
    fixtureApiReads: await worker.evaluate(() => globalThis.__ownedSkipPromotionsReads),
    externalClaimRequests: 'none; page requests intercepted and worker fetch replaced with fixtures',
    blockedRequests: [...blockedRequests], limits, time: new Date().toISOString(),
  };
}

try {
  await Promise.race([
    check(),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Check exceeded 43 seconds')), 43000); }),
  ]);
} catch (error) {
  process.exitCode = 1;
  report = { state: 'failed', error: error.stack || error.message,
    saved: latestState, fixtureNavigations: navigations, ctaClicks: clicks,
    events, errors, blockedRequests: [...blockedRequests], limits, time: new Date().toISOString() };
} finally {
  clearTimeout(timeout);
  closing = true;
  try {
    if (context) await context.close();
  } catch (error) {
    process.exitCode = 1;
    report = { ...report, state: 'failed', closeError: error.message };
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
