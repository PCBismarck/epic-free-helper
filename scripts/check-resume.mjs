import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'patchright';
import { PROMOTIONS_URL } from '../browser-extension/rules.js';

// Isolated fixture browser only. All website requests are served locally or
// rejected. No real Epic account, order or CAPTCHA is accessed.
const membership = readFileSync('/proc/self/cgroup', 'utf8');
const cgroupPath = membership.split('\n').find(line => line.startsWith('0::'))?.slice(3);
if (!cgroupPath?.includes('epic-resume-check.service')) throw new Error('Use the bounded epic-resume-check.service');
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
const games = [1, 2, 3].map(n => ({ title: `Continue Fixture ${n}`, id: `resume-offer-${n}`,
  namespace: `resume-namespace-${n}`, url: `https://store.epicgames.com/p/resume-fixture-${n}` }));
const owned = new Set([games[0].id]);
const now = Date.now();
const payload = { data: { Catalog: { searchStore: { elements: games.map(game => ({
  ...game, offerType: 'BASE_GAME', categories: [{ path: 'games' }, { path: 'freegames' }],
  price: { totalPrice: { originalPrice: 1000, discountPrice: 0 } },
  offerMappings: [{ pageType: 'productHome', pageSlug: new URL(game.url).pathname.split('/').at(-1) }],
  promotions: { promotionalOffers: [{ promotionalOffers: [{
    startDate: new Date(now - 86400000).toISOString(), endDate: new Date(now + 86400000).toISOString(),
    discountSetting: { discountType: 'PERCENTAGE', discountPercentage: 0 },
  }] }] },
})) } } } };
const eventUrl = 'https://store.epicgames.com/__resume_fixture_event';
const challengeUrl = 'https://newassets.hcaptcha.com/resume-fixture';
const checkoutUrl = game => `https://store.epicgames.com/purchase?offers=1-${game.namespace}-${game.id}--`;
const emitSource = game => `const emit = async kind => {
  const response = await fetch(${JSON.stringify(eventUrl)}, {method:'POST',body:JSON.stringify({id:${JSON.stringify(game.id)},kind})});
  if (!response.ok) throw new Error('Fixture telemetry failed');
};`;
function product(game) {
  return `<!doctype html><html><head><link rel="icon" href="data:,"></head><body>
    <egs-navigation isloggedin="true"></egs-navigation><h1>${game.title}</h1>
    <div><span data-testid="price">Free</span><button data-testid="purchase-cta-button" ${owned.has(game.id) ? 'disabled' : ''}>${owned.has(game.id) ? 'In Library' : 'Get'}</button></div>
    <script>${emitSource(game)}
      document.querySelector('button').onclick=async()=>{
        await emit('get');const frame=document.createElement('iframe');
        frame.src=${JSON.stringify(checkoutUrl(game))};frame.width=600;frame.height=500;document.body.append(frame);
      };
      window.addEventListener('message',event=>{
        if(event.origin!=='https://store.epicgames.com'||event.data?.id!==${JSON.stringify(game.id)}||event.data?.kind!=='owned')return;
        const button=document.querySelector('button');button.textContent='In Library';button.disabled=true;
        document.querySelector('iframe')?.remove();
      });
    </script></body></html>`;
}
function checkout(game) {
  return `<!doctype html><html><body><h1>${game.title}</h1><div>Total</div><div>$0.00</div><button>Place Order</button>
    <button id="fixture-verify">Complete offline fixture verification</button>
    <script>${emitSource(game)}
      window.finishFixtureVerification=async()=>{
        await emit('owned');window.parent.postMessage({kind:'owned',id:${JSON.stringify(game.id)}},'https://store.epicgames.com');
      };
      document.getElementById('fixture-verify').onclick=window.finishFixtureVerification;
      document.querySelector('button').onclick=async()=>{
        document.querySelector('button').disabled=true;await emit('submit');
        if(${game.id === games[1].id}){
          const frame=document.createElement('iframe');frame.src=${JSON.stringify(challengeUrl)};
          frame.width=400;frame.height=200;document.body.append(frame);
        }else await window.finishFixtureVerification();
      };
    </script></body></html>`;
}

const events = [], errors = [], navigations = Object.fromEntries(games.map(game => [game.id, 0]));
let context, worker, state, report, timer;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check() {
  context = await chromium.launchPersistentContext(path.join(directory, `resume-check-${Date.now()}`), {
    channel: 'chromium', headless: true, timeout: 15000,
    args: ['--disable-gpu', '--disable-background-networking',
      `--disable-extensions-except=${path.join(root, 'browser-extension')}`,
      `--load-extension=${path.join(root, 'browser-extension')}`],
  });
  context.setDefaultTimeout(5000);
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  let origin;
  await context.route('**/*', async route => {
    const request = route.request();
    if (origin && request.url().startsWith(`${origin}/`)) return route.continue();
    if (request.url() === eventUrl && request.method() === 'POST') {
      const event = JSON.parse(request.postData());
      assert.ok(games.some(game => game.id === event.id));
      assert.ok(['get', 'submit', 'owned'].includes(event.kind));
      events.push(event);if (event.kind === 'owned') owned.add(event.id);
      return route.fulfill({ status: 204, body: '' });
    }
    const game = games.find(item => item.url === request.url());
    if (game) {
      navigations[game.id]++;
      return route.fulfill({ status: 200, contentType: 'text/html', body: product(game) });
    }
    const orderGame = games.find(item => checkoutUrl(item) === request.url());
    if (orderGame) return route.fulfill({ status: 200, contentType: 'text/html', body: checkout(orderGame) });
    if (request.url() === challengeUrl) return route.fulfill({ status: 200, contentType: 'text/html', body: 'Offline verification placeholder' });
    return route.abort('blockedbyclient');
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  origin = `chrome-extension://${new URL(worker.url()).host}`;
  await worker.evaluate(({ endpoint, payload }) => {
    globalThis.fetch = async input => {
      if (String(input) !== endpoint) throw new Error('Unexpected test worker fetch');
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  }, { endpoint: PROMOTIONS_URL, payload });
  const waitState = async predicate => {
    const deadline = Date.now() + 18000;
    do {
      state = await worker.evaluate(() => chrome.storage.local.get(['status', 'job', 'settings']));
      if (predicate(state)) return state;
      await delay(100);
    } while (Date.now() < deadline);
    throw new Error(`Unexpected task state: ${JSON.stringify(state)}`);
  };
  let popup = await context.newPage();
  await popup.goto(`${origin}/popup.html`);
  await popup.waitForFunction(() => !document.getElementById('run-button').disabled);
  await popup.click('#run-button');
  await waitState(s => /等待安全验证/.test(s.status.note));
  const tabId = state.job.tabId;
  assert.equal(state.job.games[0].status, 'already_owned');
  assert.equal(state.job.games[1].resumeStage, 'submitted');
  // Advance only the isolated test worker's clock to exercise a real timeout
  // without spending the resource budget on a 60-second idle wait.
  await worker.evaluate(() => { const realNow = Date.now; Date.now = () => realNow() + 65000; });
  await waitState(s => s.job?.phase === 'manual' && !s.status.running);
  assert.equal(state.job.tabId, tabId);
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '!');
  await popup.close();popup = await context.newPage();
  await popup.goto(`${origin}/popup.html`);
  await popup.waitForFunction(() => !document.getElementById('resume-button').hidden && !document.getElementById('resume-button').disabled);
  assert.equal(await popup.locator('#run-button').isVisible(), false);
  const taskPage = context.pages().find(page => page.url() === games[1].url);
  assert.ok(taskPage, 'The original checkout must remain open');
  const frame = taskPage.frames().find(item => item.url() === checkoutUrl(games[1]));
  assert.ok(frame);
  // This is an offline fixture state change, never a real CAPTCHA operation.
  await frame.click('#fixture-verify');
  await popup.click('#resume-button');
  await waitState(s => s.job?.source === 'resume' && s.status.running);
  assert.equal(state.job.tabId, tabId, 'Continue must reuse the existing task tab');
  await waitState(s => !s.status.running && s.status.state === 'claimed');
  assert.deepEqual(state.status.games.map(game => game.status), ['already_owned', 'claimed', 'claimed']);
  assert.equal(state.job, null);
  assert.equal(state.settings.enabled, false);
  assert.deepEqual(navigations, { [games[0].id]: 1, [games[1].id]: 2, [games[2].id]: 2 });
  for (const game of games) {
    const count = game.id === games[0].id ? 0 : 1;
    assert.equal(events.filter(e => e.id === game.id && e.kind === 'get').length, count);
    assert.equal(events.filter(e => e.id === game.id && e.kind === 'submit').length, count);
  }
  await popup.waitForFunction(() => !document.getElementById('run-button').disabled && document.getElementById('resume-button').hidden);
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '✓');
  assert.deepEqual(await worker.evaluate(() => chrome.alarms.getAll()), []);
  assert.equal(context.pages().some(page => games.some(game => game.url === page.url())), false);
  assert.deepEqual(errors, []);
  report = { passed: true, limits, state, navigations, events, clockAdvancedMs: 65000 };
}
try {
  await Promise.race([check(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser check deadline')), 60000); })]);
  console.log('PASS: popup pause/Continue, persisted stage, same tab, completed-game skip, one Get/Submit per new game, final green badge.');
} catch (error) {
  report = { passed: false, error: error.message, limits, state, navigations, events, errors };
  console.error(error.stack);process.exitCode = 1;
} finally {
  clearTimeout(timer);
  if (context) await context.close();
  writeFileSync(path.join(directory, 'resume-browser-check.json'), `${JSON.stringify(report, null, 2)}\n`);
}
