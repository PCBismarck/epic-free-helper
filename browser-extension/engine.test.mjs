import test from 'node:test';
import assert from 'node:assert/strict';
import { claimGame } from './engine.js';
import { PROMOTIONS_URL, selectWeeklyPcGames } from './rules.js';

// Tests never invoke pageAction's DOM function. Chrome APIs, fetch, wall time,
// and delays are replaced before claimGame executes; no browser is started.
const NOW = Date.parse('2026-09-12T08:00:00Z');
const TAB_ID = 17;
const GAME = {
  title: 'Weekly PC Game', url: 'https://store.epicgames.com/p/weekly-pc-game',
  id: 'weekly-offer', namespace: 'weekly-namespace',
};

function apiPayload(discountPrice = 0) {
  return { data: { Catalog: { searchStore: { elements: [{
    id: GAME.id, namespace: GAME.namespace, title: GAME.title, offerType: 'BASE_GAME',
    categories: [{ path: 'games' }, { path: 'freegames' }, { path: 'games/edition/base' }],
    catalogNs: { mappings: [{ pageType: 'productHome', pageSlug: 'weekly-pc-game' }] },
    price: { totalPrice: { originalPrice: 2000, discountPrice } },
    promotions: { promotionalOffers: [{ promotionalOffers: [{
      startDate: '2026-09-10T15:00:00Z', endDate: '2026-09-17T15:00:00Z',
      discountSetting: { discountType: 'PERCENTAGE', discountPercentage: 0 },
    }] }] },
  }] } } } };
}

const product = (extra = {}) => ({
  url: GAME.url, cta: 'Get', ready: true, loggedIn: 'true', freeTexts: ['Free'], ...extra,
});
const owned = () => product({ cta: 'In Library', ready: false });
const zeroOrder = () => ({ order: { matchesTitle: true, totalText: 'Total\n$0.00' } });
const freeCheckoutOrder = (extra = {}) => ({ order: {
  kind: 'free_checkout', matchesTitle: true,
  checkoutUrl: `https://store.epicgames.com/purchase?offers=1-${GAME.namespace}-${GAME.id}--#/free-checkout`,
  itemPriceText: '¥0.00', hasFreeContent: true, totalText: '', ...extra,
} });

function harness(t, options = {}) {
  const h = {
    now: NOW, injections: [], navigations: [], fetches: [], delays: [],
    getClicks: 0, submitClicks: 0, getAttempts: 0, submitAttempts: 0, cancelled: false,
    initialReads: 0, verificationReads: 0, afterSubmitReads: 0, frameReads: 0, documents: new Map(),
  };
  const priorChrome = globalThis.chrome;
  t.after(() => { if (priorChrome === undefined) delete globalThis.chrome; else globalThis.chrome = priorChrome; });
  t.mock.method(Date, 'now', () => h.now);
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    assert.ok(Number.isFinite(milliseconds) && milliseconds >= 0);
    h.delays.push(milliseconds);
    h.now += milliseconds;
    options.delay?.(h, milliseconds);
    callback(...args);
    return 1;
  });
  t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.ok(url === PROMOTIONS_URL || (options.localized &&
      url === PROMOTIONS_URL.replace('locale=en-US', 'locale=zh-CN')),
    'only the mocked official promotion endpoint and explicit checkout locale are requested');
    assert.ok(request.signal instanceof AbortSignal);
    h.fetches.push(url);
    if (url !== PROMOTIONS_URL) return options.localized(h);
    if (options.fetch) return options.fetch(h);
    const prices = options.apiPrices || [0];
    const price = prices[Math.min(h.fetches.length - 1, prices.length - 1)];
    return { ok: true, json: async () => apiPayload(price) };
  });
  const defaultInspect = frameId => {
    if (frameId !== 0) return zeroOrder();
    if (h.navigations.length > 1) {
      h.verificationReads++;
      if (options.verify) return options.verify(h);
      return owned();
    }
    if (h.submitClicks) {
      h.afterSubmitReads++;
      return options.afterSubmit ? options.afterSubmit(h) : owned();
    }
    if (h.getClicks && options.afterGet) return options.afterGet(h);
    return typeof options.initial === 'function' ? options.initial(h) : options.initial || product();
  };
  const defaultFrame = frameId => ({
    documentId: `document-${h.navigations.length}-${frameId}`,
    url: frameId === 0 ? GAME.url : 'https://www.epicgames.com/purchase',
  });
  globalThis.chrome = {
    tabs: {
      update: async (tabId, update) => {
        assert.equal(tabId, TAB_ID);
        assert.equal(update.url, GAME.url);
        h.navigations.push(update.url);
        return { id: TAB_ID, url: update.url, status: 'complete' };
      },
      get: async tabId => {
        assert.equal(tabId, TAB_ID);
        return options.tab ? options.tab(h) : { id: TAB_ID, url: GAME.url, status: 'complete' };
      },
    },
    scripting: {
      executeScript: async request => {
        assert.equal(request.target.tabId, TAB_ID);
        assert.equal(request.target.frameIds, undefined, 'injections pin a document, never a reusable frame ID');
        assert.equal(request.target.documentIds.length, 1);
        const documentId = request.target.documentIds[0];
        const frameId = h.documents.get(documentId)?.frameId;
        assert.ok(Number.isInteger(frameId), 'injection document must have been observed through getFrame');
        const [action, game] = request.args;
        assert.equal(game.url, GAME.url);
        h.injections.push({ frameId, documentId, action, title: game.title, navigation: h.navigations.length, at: h.now });
        if (action === 'inspect' && frameId === 0 && h.navigations.length === 1 && !h.getAttempts) h.initialReads++;
        if (options.injectionError) { const error = options.injectionError(h, action, frameId); if (error) throw error; }
        let result;
        if (action === 'get') {
          h.getAttempts++;
          result = typeof options.getResult === 'function' ? options.getResult(h) : options.getResult || { clicked: true };
          if (result.clicked) h.getClicks++;
        } else if (action === 'submit') {
          h.submitAttempts++;
          result = options.submitResult || { clicked: true };
          if (result.clicked) h.submitClicks++;
        } else {
          assert.equal(action, 'inspect');
          result = options.inspect ? options.inspect(h, frameId, defaultInspect, game) : defaultInspect(frameId);
        }
        return [{ frameId, documentId: options.resultDocumentId ? options.resultDocumentId(h, documentId, action) : documentId, result }];
      },
    },
    webNavigation: {
      getFrame: async ({ tabId, frameId }) => {
        assert.equal(tabId, TAB_ID);
        h.frameReads++;
        const frame = options.frame ? options.frame(h, frameId, defaultFrame) : defaultFrame(frameId);
        if (frame?.documentId) h.documents.set(frame.documentId, { ...frame, frameId });
        return frame;
      },
      getAllFrames: async ({ tabId }) => {
        assert.equal(tabId, TAB_ID);
        return options.frames || [
          { frameId: 0, url: GAME.url },
          { frameId: 1, url: 'https://www.epicgames.com/purchase' },
        ];
      },
    },
  };
  h.run = () => claimGame(TAB_ID, GAME, () => h.cancelled);
  return h;
}

test('the API fixture satisfies the real strict eligibility rules', () => {
  assert.equal(selectWeeklyPcGames(apiPayload(), NOW)[0].url, GAME.url);
  assert.deepEqual(selectWeeklyPcGames(apiPayload(1), NOW), []);
});

for (const [name, initial] of [
  ['nonzero product price', product({ freeTexts: ['$19.99'] })],
  ['missing product price', product({ freeTexts: [] })],
  ['a Buy Now CTA despite a Free label', product({ cta: 'Buy Now' })],
  ['a requires-base-game CTA', product({ cta: 'Requires base game' })],
]) {
  test(`${name} never invokes Get or Submit`, async t => {
    const h = harness(t, { initial });
    assert.equal((await h.run()).status, 'needs_attention');
    assert.equal(h.getClicks, 0);
    assert.equal(h.submitClicks, 0);
  });
}

test('an API offer already changed to paid prevents the first Get', async t => {
  const h = harness(t, { apiPrices: [1] });
  assert.equal((await h.run()).status, 'needs_attention');
  assert.equal(h.fetches.length, 1);
  assert.equal(h.getClicks, 0);
  assert.equal(h.submitClicks, 0);
});

test('an API offer changed to paid after Get prevents order submission', async t => {
  const h = harness(t, { apiPrices: [0, 1] });
  assert.equal((await h.run()).status, 'needs_attention');
  assert.equal(h.fetches.length, 2);
  assert.equal(h.getClicks, 1);
  assert.equal(h.submitClicks, 0);
});

for (const [name, order] of [
  ['nonzero total', { matchesTitle: true, totalText: 'Total\n$1.00' }],
  ['missing total', { matchesTitle: true, totalText: 'Discount\n$0.00' }],
  ['a different product title', { matchesTitle: false, totalText: 'Total\n$0.00' }],
]) {
  test(`checkout with ${name} does not submit`, async t => {
    const h = harness(t, { inspect: (state, frameId, fallback) => frameId === 1 ? { order } : fallback(frameId) });
    assert.equal((await h.run()).status, 'needs_attention');
    assert.equal(h.getClicks, 1);
    assert.equal(h.submitClicks, 0);
  });
}

test('already-owned is confirmed in the newly opened document without an extra reload', async t => {
  const h = harness(t, { initial: owned() });
  assert.equal((await h.run()).status, 'already_owned');
  assert.equal(h.navigations.length, 1);
  assert.equal(h.verificationReads, 0);
  assert.equal(h.initialReads, 3);
  assert.equal(h.now - NOW, 1500);
  assert.equal(h.getAttempts + h.submitAttempts, 0);
  assert.equal(h.fetches.length, 0);
});

test('an ownership flash that stays Get is unconfirmed at the page deadline without clicking', async t => {
  const h = harness(t, { initial: state => state.initialReads === 1 ? owned() : product() });
  assert.equal((await h.run()).status, 'needs_attention');
  assert.ok(h.now - NOW >= 35000 && h.now - NOW < 36000);
  assert.equal(h.getAttempts + h.submitAttempts, 0);
});

for (const [name, loadingStates] of [
  ['multiple initial Get placeholders', [product(), product(), product()]],
  ['disabled Loading placeholders', [product({ cta: 'Loading', ready: false }), product({ cta: '加载中', ready: false })]],
  ['Get followed by disabled Loading', [product(), product({ cta: 'Loading', ready: false }), product()]],
  ['a logged-out navigation placeholder', [product({ loggedIn: 'false' }), product({ loggedIn: null })]],
  ['Owned followed by loading', [owned(), product({ cta: 'Loading', ready: false }), product()]],
]) {
  test(`initial ownership check waits through ${name} before stable ownership`, async t => {
    const h = harness(t, { initial: state => loadingStates[state.initialReads - 1] || owned() });
    assert.equal((await h.run()).status, 'already_owned');
    assert.equal(h.navigations.length, 1);
    assert.equal(h.initialReads, loadingStates.length + 3);
    assert.equal(h.getAttempts + h.submitAttempts, 0);
  });
  test(`post-claim verification waits through ${name} before stable ownership`, async t => {
    const h = harness(t, { afterGet: () => owned(),
      verify: state => loadingStates[state.verificationReads - 1] || owned() });
    assert.equal((await h.run()).status, 'claimed');
    assert.equal(h.navigations.length, 2);
    assert.equal(h.verificationReads, loadingStates.length + 3);
    assert.equal(h.getClicks, 1);
    assert.equal(h.submitAttempts, 0);
  });
}

test('Get throughout fresh verification remains unconfirmed without further clicks', async t => {
  const h = harness(t, { afterGet: () => owned(), verify: () => product() });
  assert.equal((await h.run()).status, 'needs_attention');
  assert.ok(h.now - NOW >= 38000 && h.now - NOW < 39000);
  assert.equal(h.getAttempts, 1);
  assert.equal(h.submitAttempts, 0);
});

test('the old document is never inspected after tabs.update resolves', async t => {
  const h = harness(t, { initial: owned(), frame: (state, frameId, fallback) =>
    frameId === 0 && state.navigations.length === 1 && state.now - NOW < 2250
      ? { ...fallback(frameId), documentId: 'document-0-0' } : fallback(frameId) });
  assert.equal((await h.run()).status, 'already_owned');
  assert.equal(h.injections.some(call => call.documentId === 'document-0-0'), false);
  assert.equal(h.injections[0].at - NOW, 2250);
  assert.equal(h.getAttempts + h.submitAttempts, 0);
});

test('post-claim verification rejects stale same-URL Owned before the new document loads', async t => {
  let refreshedAt;
  const h = harness(t, { afterGet: () => owned(),
    frame: (state, frameId, fallback) => {
      if (frameId === 0 && state.navigations.length === 2) {
        refreshedAt ??= state.now;
        if (state.now - refreshedAt < 2250) return { ...fallback(frameId), documentId: 'document-1-0' };
      }
      return fallback(frameId);
    },
    verify: state => state.verificationReads < 3 ? product({ cta: 'Loading', ready: false, loggedIn: 'false' }) : owned(),
  });
  assert.equal((await h.run()).status, 'claimed');
  assert.equal(h.verificationReads, 5);
  assert.ok(h.injections.filter(call => call.navigation === 2).every(call => call.documentId === 'document-2-0'));
  assert.equal(h.getAttempts, 1);
  assert.equal(h.submitAttempts, 0);
});

for (const ownedOnly of [false, true]) {
  test(`${ownedOnly ? 'post-claim' : 'initial'} inspection waits for the expected product URL`, async t => {
    const wrong = { ...owned(), url: 'https://store.epicgames.com/p/previous-game' };
    const h = harness(t, ownedOnly
      ? { afterGet: () => owned(), verify: state => state.verificationReads === 1 ? wrong : owned() }
      : { initial: state => state.initialReads === 1 ? wrong : owned() });
    assert.equal((await h.run()).status, ownedOnly ? 'claimed' : 'already_owned');
    assert.equal(h.getAttempts, ownedOnly ? 1 : 0);
    assert.equal(h.submitAttempts, 0);
  });
}

for (const [name, blockedState, status] of [
  ['a security challenge', { challenge: true }, 'needs_attention'],
  ['a login page', product({ needsLogin: true }), 'needs_login'],
]) {
  test(`ownership verification immediately stops at ${name}`, async t => {
    const h = harness(t, { afterGet: () => owned(), verify: () => blockedState });
    assert.equal((await h.run()).status, status);
    assert.equal(h.verificationReads, 1);
    assert.equal(h.now - NOW, 3000);
    assert.equal(h.getAttempts, 1);
    assert.equal(h.submitAttempts, 0);
  });
}

test('a persistently logged-out current account needs login without any clicks', async t => {
  const h = harness(t, { initial: product({ loggedIn: 'false' }) });
  assert.equal((await h.run()).status, 'needs_login');
  assert.ok(h.now - NOW >= 35000 && h.now - NOW < 36000);
  assert.equal(h.getAttempts + h.submitAttempts, 0);
});

test('logout during ownership confirmation does not reuse the earlier account evidence', async t => {
  const h = harness(t, { initial: state => state.initialReads === 1 ? owned() : product({ loggedIn: 'false' }) });
  assert.equal((await h.run()).status, 'needs_login');
  assert.equal(h.getAttempts + h.submitAttempts, 0);
});

test('a one-click claim also requires stable ownership after refreshing the product', async t => {
  const h = harness(t, { afterGet: () => owned() });
  assert.equal((await h.run()).status, 'claimed');
  assert.equal(h.navigations.length, 2);
  assert.equal(h.verificationReads, 3);
  assert.equal(h.getClicks, 1);
  assert.equal(h.submitClicks, 0);
});

test('a one-click ownership signal followed by Get on refresh is not claimed', async t => {
  const h = harness(t, { afterGet: () => owned(), verify: () => product() });
  assert.equal((await h.run()).status, 'needs_attention');
  assert.equal(h.getClicks, 1);
  assert.equal(h.submitClicks, 0);
});

test('a captcha on arrival stops immediately without any claim clicks or polling', async t => {
  const h = harness(t, { initial: { challenge: true } });
  assert.equal((await h.run()).status, 'needs_attention');
  assert.equal(h.getClicks + h.submitClicks, 0);
  assert.equal(h.fetches.length, 0);
  assert.deepEqual(h.delays, []);
});

test('a captcha after Get stops without submitting or retrying Get', async t => {
  const h = harness(t, { afterGet: () => ({ challenge: true }) });
  assert.equal((await h.run()).status, 'needs_attention');
  assert.equal(h.getClicks, 1);
  assert.equal(h.submitClicks, 0);
  assert.equal(h.now - NOW, 3000);
});

test('a captcha in the trusted checkout frame stops before Submit', async t => {
  const h = harness(t, { inspect: (state, frameId, fallback) => frameId === 1 ? { challenge: true } : fallback(frameId) });
  assert.equal((await h.run()).status, 'needs_attention');
  assert.equal(h.getClicks, 1);
  assert.equal(h.submitClicks, 0);
});

test('cancellation before the run prevents even navigation and injection', async t => {
  const h = harness(t);
  h.cancelled = true;
  assert.equal((await h.run()).status, 'failed');
  assert.equal(h.navigations.length, 0);
  assert.equal(h.injections.length, 0);
});

test('cancellation during the final API recheck prevents Submit', async t => {
  const h = harness(t, { fetch: async state => {
    if (state.fetches.length === 2) state.cancelled = true;
    return { ok: true, json: async () => apiPayload() };
  } });
  assert.equal((await h.run()).status, 'failed');
  assert.equal(h.getClicks, 1);
  assert.equal(h.fetches.length, 2);
  assert.equal(h.submitClicks, 0);
});

test('cancellation while the final tab-origin check is awaiting prevents Submit', async t => {
  const h = harness(t, { tab: state => {
    if (state.fetches.length === 2) state.cancelled = true;
    return { id: TAB_ID, url: GAME.url, status: 'complete' };
  } });
  assert.equal((await h.run()).status, 'failed');
  assert.equal(h.getClicks, 1);
  assert.equal(h.submitClicks, 0);
});

test('a top-level navigation to a different Epic product immediately before Submit refuses the order', async t => {
  const h = harness(t, { tab: state => ({
    id: TAB_ID, status: 'complete',
    url: state.fetches.length === 2 ? 'https://store.epicgames.com/p/different-game' : GAME.url,
  }) });
  assert.equal((await h.run()).status, 'needs_attention');
  assert.equal(h.getClicks, 1);
  assert.equal(h.submitClicks, 0);
});

test('a slow successful checkout performs at most one Get and one Submit', async t => {
  const h = harness(t, { afterSubmit: state => state.afterSubmitReads >= 3 ? owned() : product() });
  assert.equal((await h.run()).status, 'claimed');
  assert.equal(h.getClicks, 1);
  assert.equal(h.submitClicks, 1);
  assert.equal(h.verificationReads, 3);
  assert.ok(h.afterSubmitReads >= 3);
});

test('the new free-checkout branch rechecks the API and submits at most once before verifying ownership', async t => {
  const h = harness(t, {
    inspect: (state, frameId, fallback) => frameId === 1 ? freeCheckoutOrder() : fallback(frameId),
    afterSubmit: state => state.afterSubmitReads >= 3 ? owned() : product(),
  });
  assert.equal((await h.run()).status, 'claimed');
  assert.equal(h.fetches.length, 2);
  assert.equal(h.getClicks, 1);
  assert.equal(h.submitClicks, 1);
  assert.equal(h.verificationReads, 3);
});

test('a free-checkout item that became paid in the API never submits', async t => {
  const h = harness(t, {
    apiPrices: [0, 1],
    inspect: (state, frameId, fallback) => frameId === 1 ? freeCheckoutOrder() : fallback(frameId),
  });
  assert.equal((await h.run()).status, 'needs_attention');
  assert.equal(h.fetches.length, 2);
  assert.equal(h.getClicks, 1);
  assert.equal(h.submitClicks, 0);
});

test('the engine independently rejects a free-checkout URL for a different offer', async t => {
  const h = harness(t, {
    inspect: (state, frameId, fallback) => frameId === 1 ? freeCheckoutOrder({
      checkoutUrl: 'https://store.epicgames.com/purchase?offers=1-other-other--#/free-checkout',
    }) : fallback(frameId),
  });
  assert.equal((await h.run()).status, 'needs_attention');
  assert.equal(h.getClicks, 1);
  assert.equal(h.submitClicks, 0);
});

test('an unconfirmed checkout times out without a second order submission', async t => {
  const h = harness(t, { afterSubmit: () => product(), verify: () => product() });
  assert.equal((await h.run()).status, 'needs_attention');
  assert.equal(h.getClicks, 1);
  assert.equal(h.submitClicks, 1);
  assert.ok(h.now - NOW >= 45000);
});

test('a refused initial click is never retried and cannot lead to Submit', async t => {
  const h = harness(t, { getResult: { refused: true } });
  assert.equal((await h.run()).status, 'needs_attention');
  assert.equal(h.getAttempts, 1);
  assert.equal(h.getClicks, 0);
  assert.equal(h.submitClicks, 0);
});

test('an untrusted initial target is rejected before navigation or injection', async t => {
  const h = harness(t);
  const result = await claimGame(TAB_ID, { ...GAME, url: 'https://store.epicgames.com.attacker.example/p/game' });
  assert.equal(result.status, 'needs_attention');
  assert.equal(h.navigations.length, 0);
  assert.equal(h.injections.length, 0);
});

test('a top-level redirect to an attacker origin is never injected into', async t => {
  const h = harness(t, { tab: () => ({ id: TAB_ID, url: 'https://store.epicgames.com.attacker.example/p/weekly-pc-game', status: 'complete' }) });
  const result = await h.run();
  assert.ok(['failed', 'needs_attention'].includes(result.status));
  assert.equal(h.injections.length, 0);
  assert.equal(h.getClicks + h.submitClicks, 0);
});

test('untrusted child origins are skipped while the real Epic checkout can proceed', async t => {
  const h = harness(t, { frames: [
    { frameId: 0, url: GAME.url },
    { frameId: 2, url: 'https://epicgames.com.attacker.example/purchase' },
    { frameId: 3, url: 'http://www.epicgames.com/purchase' },
    { frameId: 4, url: 'https://example.org/purchase' },
    { frameId: 1, url: 'https://www.epicgames.com/purchase' },
  ] });
  assert.equal((await h.run()).status, 'claimed');
  assert.equal(h.injections.some(call => [2, 3, 4].includes(call.frameId)), false);
  assert.equal(h.getClicks, 1);
  assert.equal(h.submitClicks, 1);
});

test('a trusted usable product can be inspected while unrelated resources keep the tab loading', async t => {
  const h = harness(t, { initial: owned(), tab: () => ({ id: TAB_ID, url: GAME.url, status: 'loading' }) });
  assert.equal((await h.run()).status, 'already_owned');
  assert.equal(h.verificationReads, 0);
  assert.equal(h.navigations.length, 1);
});


test('ownership that resolves immediately before Get is confirmed and skipped without a click or reload', async t => {
  const h = harness(t, { getResult: { owned: true }, initial: state => state.getAttempts ? owned() : product() });
  assert.equal((await h.run()).status, 'already_owned');
  assert.equal(h.navigations.length, 1);
  assert.equal(h.getAttempts, 1);
  assert.equal(h.getClicks + h.submitAttempts, 0);
});

test('logout immediately before Get is returned as needs_login without clicking', async t => {
  const h = harness(t, { getResult: { refused: true, needsLogin: true } });
  assert.equal((await h.run()).status, 'needs_login');
  assert.equal(h.getAttempts, 1);
  assert.equal(h.getClicks + h.submitAttempts, 0);
});

for (const [name, initial] of [
  ['a disabled Get button', product({ ready: false })],
  ['an unresolved login state', product({ loggedIn: null })],
]) {
  test(`${name} cannot be treated as owned or clicked`, async t => {
    const h = harness(t, { initial });
    assert.equal((await h.run()).status, 'needs_attention');
    assert.ok(h.now - NOW >= 35000 && h.now - NOW < 36000);
    assert.equal(h.getAttempts + h.submitAttempts, 0);
  });
}

test('an explicit initial login page stops immediately without polling or clicking', async t => {
  const h = harness(t, { initial: product({ needsLogin: true }) });
  assert.equal((await h.run()).status, 'needs_login');
  assert.equal(h.now - NOW, 0);
  assert.equal(h.getAttempts + h.submitAttempts, 0);
});

test('a persistently logged-out fresh verification reports needs_login without another click', async t => {
  const h = harness(t, { afterGet: () => owned(), verify: () => product({ loggedIn: 'false' }) });
  assert.equal((await h.run()).status, 'needs_login');
  assert.ok(h.now - NOW >= 38000 && h.now - NOW < 39000);
  assert.equal(h.getAttempts, 1);
  assert.equal(h.submitAttempts, 0);
});

test('a navigation that never leaves the previous document times out without inspecting it', async t => {
  const h = harness(t, { initial: owned(), frame: (state, frameId, fallback) => ({
    ...fallback(frameId), documentId: 'document-0-0',
  }) });
  assert.equal((await h.run()).status, 'needs_attention');
  assert.ok(h.now - NOW >= 35000 && h.now - NOW < 36000);
  assert.equal(h.injections.length, 0);
});

test('missing frame document IDs are never accepted or injected into', async t => {
  const h = harness(t, { initial: owned(), frame: (state, frameId, fallback) => state.navigations.length
    ? { ...fallback(frameId), documentId: undefined } : fallback(frameId) });
  assert.equal((await h.run()).status, 'needs_attention');
  assert.ok(h.now - NOW >= 35000 && h.now - NOW < 36000);
  assert.equal(h.injections.length, 0);
});

for (const [name, returnedId] of [['missing', undefined], ['mismatched', 'wrong-document']]) {
  test(`${name} injection document IDs cannot prove ownership or authorize clicks`, async t => {
    const h = harness(t, { initial: owned(), resultDocumentId: () => returnedId });
    assert.equal((await h.run()).status, 'needs_attention');
    assert.ok(h.now - NOW >= 35000 && h.now - NOW < 36000);
    assert.equal(h.getAttempts + h.submitAttempts, 0);
  });
}

test('an injection document mismatch resets observation and a later matching document can confirm ownership', async t => {
  const h = harness(t, { initial: owned(), resultDocumentId: (state, id) => state.initialReads === 1 ? 'old-document' : id });
  assert.equal((await h.run()).status, 'already_owned');
  assert.equal(h.initialReads, 4);
  assert.equal(h.now - NOW, 2250);
  assert.equal(h.getAttempts + h.submitAttempts, 0);
});

test('replacement between frame lookup and injection is retried without reading the replaced document', async t => {
  const h = harness(t, { initial: owned(), frame: (state, frameId, fallback) => state.frameReads >= 3
    ? { ...fallback(frameId), documentId: 'replacement-document' } : fallback(frameId) });
  assert.equal((await h.run()).status, 'already_owned');
  assert.ok(h.injections.every(call => call.documentId === 'replacement-document'));
  assert.equal(h.now - NOW, 2250);
  assert.equal(h.getAttempts + h.submitAttempts, 0);
});

test('ownership observations from different documents cannot be combined into a stable result', async t => {
  const h = harness(t, { initial: owned(), frame: (state, frameId, fallback) => state.now - NOW >= 750
    ? { ...fallback(frameId), documentId: 'replacement-document' } : fallback(frameId) });
  assert.equal((await h.run()).status, 'already_owned');
  assert.equal(h.now - NOW, 2250);
  assert.equal(h.injections.filter(call => call.documentId === 'replacement-document').length, 3);
  assert.equal(h.getAttempts + h.submitAttempts, 0);
});

test('known inspection errors caused by a removed document can recover within the page budget', async t => {
  const h = harness(t, { initial: owned(), injectionError: state => state.initialReads === 1
    ? new Error('No document with id old-document in tab with id 17.') : null });
  assert.equal((await h.run()).status, 'already_owned');
  assert.equal(h.initialReads, 4);
  assert.equal(h.getAttempts + h.submitAttempts, 0);
});

test('unrelated injection errors fail immediately without repeated attempts', async t => {
  const h = harness(t, { initial: owned(), injectionError: () => new Error('Missing host permission for the tab') });
  assert.equal((await h.run()).status, 'failed');
  assert.equal(h.injections.length, 1);
  assert.equal(h.now - NOW, 0);
  assert.equal(h.getAttempts + h.submitAttempts, 0);
});

for (const action of ['get', 'submit']) {
  test(`a document error during ${action} never retries the possibly completed action`, async t => {
    const h = harness(t, { injectionError: (state, requested) => requested === action
      ? new Error('No document with id replaced-document in tab with id 17.') : null });
    assert.equal((await h.run()).status, 'failed');
    assert.equal(h.injections.filter(call => call.action === action).length, 1);
    if (action === 'get') assert.equal(h.submitAttempts, 0);
    else assert.equal(h.getAttempts, 1);
  });
}

test('cancellation during the initial hydration wait stops before the next inspection or any click', async t => {
  const h = harness(t, { delay: state => { state.cancelled = true; } });
  assert.equal((await h.run()).status, 'failed');
  assert.equal(h.initialReads, 1);
  assert.equal(h.getAttempts + h.submitAttempts, 0);
  assert.equal(h.fetches.length, 0);
});

test('document replacement immediately before Get refuses to click a newly reused frame', async t => {
  const h = harness(t, { frame: (state, frameId, fallback) => state.fetches.length
    ? { ...fallback(frameId), documentId: 'replacement-document' } : fallback(frameId) });
  assert.equal((await h.run()).status, 'failed');
  assert.equal(h.getAttempts + h.submitAttempts, 0);
});

test('checkout document replacement immediately before Submit never clicks the replacement', async t => {
  const h = harness(t, { frame: (state, frameId, fallback) => state.fetches.length === 2 && frameId === 1
    ? { ...fallback(frameId), documentId: 'replacement-checkout-document' } : fallback(frameId) });
  assert.equal((await h.run()).status, 'failed');
  assert.equal(h.getAttempts, 1);
  assert.equal(h.submitAttempts, 0);
});


const LOCAL_TITLE = '心灵警探';
const LOCAL_CHECKOUT = `https://store.epicgames.com/purchase?lang=zh-CN&offers=1-${GAME.namespace}-${GAME.id}--#/free-checkout`;
function localizedPayload(change = () => {}) {
  const data = apiPayload();
  const item = data.data.Catalog.searchStore.elements[0];
  item.title = LOCAL_TITLE;
  change(item);
  return data;
}
function localizedOptions(extra = {}) {
  return {
    localized: async () => ({ ok: true, json: async () => localizedPayload() }),
    inspect: (state, frameId, fallback, expectedGame) => frameId === 1 ? freeCheckoutOrder({
      checkoutUrl: LOCAL_CHECKOUT, matchesTitle: expectedGame.title === LOCAL_TITLE,
    }) : fallback(frameId),
    ...extra,
  };
}

test('localized checkout resolves the exact official offer then rechecks its DOM and submits once', async t => {
  const h = harness(t, localizedOptions());
  assert.equal((await h.run()).status, 'claimed');
  assert.deepEqual(h.fetches, [PROMOTIONS_URL, PROMOTIONS_URL.replace('en-US', 'zh-CN'), PROMOTIONS_URL]);
  assert.equal(h.getClicks, 1);
  assert.equal(h.submitClicks, 1);
  assert.equal(h.injections.find(x => x.action === 'submit').title, LOCAL_TITLE);
  assert.equal(h.navigations.length, 2, 'a fresh product navigation must confirm ownership');
});

for (const [name, change] of [
  ['another offer ID', item => { item.id = 'other-offer'; }],
  ['another namespace', item => { item.namespace = 'other-namespace'; }],
  ['another product URL', item => { item.catalogNs.mappings[0].pageSlug = 'other-product'; }],
  ['a paid offer', item => { item.price.totalPrice.discountPrice = 1; }],
  ['an expired promotion', item => { item.promotions.promotionalOffers[0].promotionalOffers[0].endDate = '2026-09-11T00:00:00Z'; }],
  ['an unrelated localized title', item => { item.title = 'Different Game'; }],
]) {
  test(`localized title lookup never authorizes ${name}`, async t => {
    const h = harness(t, localizedOptions({ localized: async () => ({ ok: true, json: async () => localizedPayload(change) }) }));
    assert.equal((await h.run()).status, 'needs_attention');
    assert.equal(h.getClicks, 1);
    assert.equal(h.submitAttempts, 0);
  });
}

for (const [name, order] of [
  ['nonzero price', { itemPriceText: '¥1.00' }],
  ['wrong checkout offer', { checkoutUrl: LOCAL_CHECKOUT.replace(GAME.id, 'other-offer') }],
  ['missing free-content notice', { hasFreeContent: false }],
  ['unknown query parameter', { checkoutUrl: LOCAL_CHECKOUT.replace('#', '&cartId=other#') }],
  ['missing locale', { checkoutUrl: LOCAL_CHECKOUT.replace('lang=zh-CN&', '') }],
  ['invalid locale', { checkoutUrl: LOCAL_CHECKOUT.replace('zh-CN', 'zh-CN-unknown') }],
]) {
  test(`localized mismatch with ${name} stops without a localization request or submit`, async t => {
    const h = harness(t, localizedOptions({ inspect: (state, frameId, fallback) => frameId === 1
      ? freeCheckoutOrder({ checkoutUrl: LOCAL_CHECKOUT, matchesTitle: false, ...order }) : fallback(frameId) }));
    assert.equal((await h.run()).status, 'needs_attention');
    assert.equal(h.fetches.length, 1);
    assert.equal(h.submitAttempts, 0);
  });
}

for (const [name, localized] of [
  ['HTTP failure', async () => ({ ok: false })],
  ['network failure', async () => { throw new Error('mock timeout'); }],
  ['invalid JSON', async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } })],
]) {
  test(`localized lookup ${name} pauses before submission`, async t => {
    const h = harness(t, localizedOptions({ localized }));
    assert.equal((await h.run()).status, 'needs_attention');
    assert.equal(h.submitAttempts, 0);
  });
}

test('cancellation during localized lookup stops before reinspection or submit', async t => {
  const h = harness(t, localizedOptions({ localized: async state => {
    state.cancelled = true;
    return { ok: true, json: async () => localizedPayload() };
  } }));
  assert.equal((await h.run()).status, 'failed');
  assert.equal(h.submitAttempts, 0);
  assert.equal(h.injections.some(x => x.title === LOCAL_TITLE), false);
});

test('price changes while resolving the localized title are rejected by the fresh DOM read', async t => {
  const h = harness(t, localizedOptions({ inspect: (state, frameId, fallback, expectedGame) => frameId === 1
    ? freeCheckoutOrder({ checkoutUrl: LOCAL_CHECKOUT, matchesTitle: expectedGame.title === LOCAL_TITLE,
      itemPriceText: expectedGame.title === LOCAL_TITLE ? '¥1.00' : '¥0.00' }) : fallback(frameId) }));
  assert.equal((await h.run()).status, 'needs_attention');
  assert.equal(h.submitAttempts, 0);
});

test('final eligibility recheck still blocks an offer that became paid after localized matching', async t => {
  const h = harness(t, localizedOptions({ apiPrices: [0, 0, 1] }));
  assert.equal((await h.run()).status, 'needs_attention');
  assert.equal(h.fetches.length, 3);
  assert.equal(h.submitAttempts, 0);
});
