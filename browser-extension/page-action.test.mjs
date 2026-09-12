import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { pageAction } from './engine.js';
import { isVerifiedZeroCheckout } from './rules.js';

const GAME = {
  title: 'Luftrausers', url: 'https://store.epicgames.com/p/luftrausers',
  namespace: '639daf403b554ee9b02eee5eedafc302', id: 'c76046dddcdb43619c33ce0395941033',
};
const OFFER = `1-${GAME.namespace}-${GAME.id}--`;
const URL_BASE = `https://store.epicgames.com/purchase?highlightColor=0078f2&lang=zh-CN&offers=${OFFER}&showNavigation=true`;
const CHECKOUT_URL = `${URL_BASE}#/free-checkout`;
const NOTICE = '这是免费内容。添加到库即可开始体验。';
const LIVE_CARD = readFileSync(new URL('./fixtures/free-checkout-card.html', import.meta.url), 'utf8').trim();

function fixture(t, options = {}) {
  const title = options.title ?? GAME.title;
  const amount = options.amount ?? '¥0.00';
  const card = options.card ?? LIVE_CARD.replace('<div ', '<div id="item-card" ')
    .replace('>Luftrausers</span>', `>${title}</span>`).replace('>¥0.00</span>', `>${amount}</span>`);
  const markup = options.markup ?? `<div><div>${card}<h5>${options.notice ?? NOTICE}</h5></div>
    ${options.extra ?? ''}<button>${options.button ?? '添加到库'}</button><p>购买即表示你同意服务条款。</p></div>`;
  const { document, HTMLElement } = parseHTML(`<html><body>${markup}</body></html>`);
  // Linkedom supplies real DOM selectors/ancestry, but has no layout engine.
  // These two layout shims reproduce the captured visible flex-column card:
  // its direct title/price spans render as exactly two lines in Windows Chrome.
  HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{}]; };
  const itemCard = document.querySelector('#item-card');
  itemCard?.removeAttribute('id');
  for (const container of document.querySelectorAll('div')) {
    if ([...container.children].some(child => child.tagName === 'SPAN')) {
      Object.defineProperty(container, 'innerText', {
        configurable: true, get() { return [...this.children].map(child => child.innerText).filter(Boolean).join('\n'); },
      });
    }
  }
  const browsingWindow = { top: {} };
  if (options.root) browsingWindow.top = browsingWindow;
  const values = { document, window: browsingWindow,
    location: new URL(options.url ?? CHECKOUT_URL),
    getComputedStyle: el => ({ visibility: el.hidden ? 'hidden' : 'visible', display: el.hidden ? 'none' : 'block' }) };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => { for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
  let clicks = 0;
  for (const button of document.querySelectorAll('button')) button.addEventListener('click', () => clicks++);
  // Chrome serializes pageAction for injection; a fresh VM also ensures it
  // cannot accidentally rely on imports or other extension-module closures.
  const invoke = action => JSON.parse(JSON.stringify(runInNewContext(`(${pageAction.toString()})(action, game)`, {
    action, game: GAME, URL, document, window: globalThis.window, location: globalThis.location,
    getComputedStyle: globalThis.getComputedStyle,
  })));
  return { document, itemCard, itemPrice: () => [...itemCard.children].filter(child => child.tagName === 'SPAN')[1],
    inspect: () => invoke('inspect'), get: () => invoke('get'), submit: () => invoke('submit'), clicks: () => clicks };
}

test('captured Chinese free-checkout DOM proves the single offer without inventing a Total', t => {
  const page = fixture(t);
  const order = page.inspect().order;
  assert.equal(order.kind, 'free_checkout');
  assert.equal(order.itemPriceText, '¥0.00');
  assert.equal(order.totalText, '');
  assert.equal(isVerifiedZeroCheckout(order, GAME), true);
  assert.equal(page.clicks(), 0);
  assert.deepEqual(page.submit(), { clicked: true });
  assert.equal(page.clicks(), 1);
});

for (const [name, options] of [
  ['nonzero item price', { amount: '¥0.01' }],
  ['missing item price', { card: '<div id="item-card"><span>Luftrausers</span></div>' }],
  ['Free text instead of numeric zero', { amount: '免费' }],
  ['a zero discount elsewhere', { amount: '¥19.99', extra: '<div>Discount<span>¥0.00</span></div>' }],
  ['detached price with no adjacent title', { card: '<div><span>Luftrausers</span></div><div><span>¥0.00</span></div>' }],
  ['an extra discount line inside the item card', { card: '<div id="item-card"><span>Luftrausers</span><span>Discount</span><span>¥0.00</span></div>' }],
  ['the wrong game title', { title: 'Different Game' }],
  ['a title that merely contains the expected game title', { title: 'Luftrausers DLC' }],
  ['the wrong offer ID', { url: CHECKOUT_URL.replace(GAME.id, 'other-offer') }],
  ['the wrong namespace', { url: CHECKOUT_URL.replace(GAME.namespace, 'other-namespace') }],
  ['two offers in one parameter', { url: `${URL_BASE.replace(OFFER, `${OFFER},1-other-other--`)}#/free-checkout` }],
  ['duplicate offers parameters', { url: `${URL_BASE}&offers=${OFFER}#/free-checkout` }],
  ['duplicate other query parameters', { url: `${URL_BASE}&lang=en-US#/free-checkout` }],
  ['an unexpected orderId parameter', { url: `${URL_BASE}&orderId=other#/free-checkout` }],
  ['an unexpected cartId parameter', { url: `${URL_BASE}&cartId=other#/free-checkout` }],
  ['an unexpected array of offers', { url: `${URL_BASE}&offers[]=other#/free-checkout` }],
  ['an offer quantity other than one', { url: CHECKOUT_URL.replace(`offers=1-`, 'offers=2-') }],
  ['no offers parameter', { url: 'https://store.epicgames.com/purchase#/free-checkout' }],
  ['a different route', { url: CHECKOUT_URL.replace('/purchase?', '/cart?') }],
  ['a different hash route', { url: CHECKOUT_URL.replace('#/free-checkout', '#/checkout') }],
  ['another Epic origin', { url: CHECKOUT_URL.replace('store.epicgames.com', 'www.epicgames.com') }],
  ['an untrusted origin', { url: CHECKOUT_URL.replace('store.epicgames.com', 'store.epicgames.com.example.org') }],
  ['HTTP instead of HTTPS', { url: CHECKOUT_URL.replace('https:', 'http:') }],
  ['URL credentials', { url: CHECKOUT_URL.replace('https://', 'https://user:pass@') }],
  ['a missing explicit free-content notice', { notice: '查看游戏说明。' }],
  ['a different order button', { button: 'Place Order' }],
  ['a nonzero real total despite a zero item price', { extra: '<div>Total</div><div>¥9.99</div>' }],
  ['conflicting actual totals', { extra: '<div>Total</div><div>¥0.00</div><div>总计</div><div>¥1.00</div>' }],
  ['a second free product card', { extra: '<div><span>Other Game</span><span>¥0.00</span></div>' }],
  ['a second paid product card', { extra: '<div><span>Other Game</span><span>¥9.99</span></div>' }],
  ['a duplicate expected product card', { extra: LIVE_CARD }],
]) {
  test(`free-checkout rejects ${name} on inspection and submission`, t => {
    const page = fixture(t, options);
    assert.equal(isVerifiedZeroCheckout(page.inspect().order, GAME), false);
    assert.notEqual(page.submit().clicked, true);
    assert.equal(page.clicks(), 0);
  });
}

test('an actual zero total remains valid on the free-checkout route', t => {
  const page = fixture(t, { extra: '<div>总计</div><div>¥0.00</div>' });
  assert.equal(isVerifiedZeroCheckout(page.inspect().order, GAME), true);
  assert.deepEqual(page.submit(), { clicked: true });
});

test('a hidden adjacent item price cannot supply zero-price evidence', t => {
  const page = fixture(t);
  page.itemPrice().hidden = true;
  assert.equal(isVerifiedZeroCheckout(page.inspect().order, GAME), false);
  assert.notEqual(page.submit().clicked, true);
  assert.equal(page.clicks(), 0);
});

for (const [name, mutate] of [
  ['item price changes', page => { page.itemPrice().textContent = '¥1.00'; }],
  ['offer identity changes', () => { globalThis.location = new URL(CHECKOUT_URL.replace(GAME.id, 'other')); }],
  ['free-content notice disappears', page => { page.document.querySelector('h5').remove(); }],
  ['button becomes disabled', page => { page.document.querySelector('button').disabled = true; }],
]) {
  test(`submission re-reads live evidence when ${name} after inspection`, t => {
    const page = fixture(t);
    assert.equal(isVerifiedZeroCheckout(page.inspect().order, GAME), true);
    mutate(page);
    assert.notEqual(page.submit().clicked, true);
    assert.equal(page.clicks(), 0);
  });
}

for (const [name, total, valid] of [
  ['zero total', '<div>Total</div><div>$0.00</div>', true],
  ['paid total', '<div>Total</div><div>$1.00</div>', false],
  ['a discount without a total', '<div>Discount</div><div>$0.00</div>', false],
]) {
  test(`legacy checkout DOM with ${name} keeps the explicit Total requirement`, t => {
    const page = fixture(t, { url: 'https://www.epicgames.com/purchase',
      markup: `<div><h3>Luftrausers</h3>${total}<button>Place Order</button></div>` });
    const order = page.inspect().order;
    assert.equal(order.kind, 'total');
    assert.equal(isVerifiedZeroCheckout(order, GAME), valid);
    assert.equal(page.submit().clicked === true, valid);
    assert.equal(page.clicks(), valid ? 1 : 0);
  });
}

test('a top-level free-checkout-looking body does not bypass the visible-dialog restriction', t => {
  const page = fixture(t, { root: true });
  assert.equal(page.inspect().order, undefined);
  assert.notEqual(page.submit().clicked, true);
  assert.equal(page.clicks(), 0);
});


function productFixture(t, { cta = 'Get', loggedIn = 'true', disabled = false } = {}) {
  const page = fixture(t, { root: true, url: GAME.url,
    markup: `<egs-navigation${loggedIn === null ? '' : ` isloggedin="${loggedIn}"`}></egs-navigation>
      <div><button data-testid="purchase-cta-button">${cta}</button><span>Free</span></div>` });
  page.document.querySelector('button').disabled = disabled;
  return page;
}

for (const cta of ['In Library', '已在库中', '已拥有']) {
  test(`Get invocation recognizes ${cta} without clicking its disabled button`, t => {
    const page = productFixture(t, { cta, disabled: true });
    assert.equal(page.inspect().ready, false);
    assert.deepEqual(page.get(), { owned: true });
    assert.equal(page.clicks(), 0);
  });
}

test('a disabled Get button never supplies an ownership signal', t => {
  const page = productFixture(t, { disabled: true });
  assert.deepEqual(page.get(), { refused: true });
  assert.equal(page.clicks(), 0);
});

test('ownership that resolves between inspection and Get is returned without clicking', t => {
  const page = productFixture(t);
  assert.equal(page.inspect().cta, 'Get');
  const button = page.document.querySelector('button');
  button.textContent = 'In Library';
  button.disabled = true;
  assert.deepEqual(page.get(), { owned: true });
  assert.equal(page.clicks(), 0);
});

for (const loggedIn of ['false', null]) {
  test(`Get cannot click while the current login state is ${loggedIn}`, t => {
    const page = productFixture(t, { loggedIn });
    assert.deepEqual(page.get(), { refused: true, needsLogin: loggedIn === 'false' });
    assert.equal(page.clicks(), 0);
  });
}

test('Get rechecks the live login state instead of reusing the earlier account evidence', t => {
  const page = productFixture(t);
  assert.equal(page.inspect().loggedIn, 'true');
  page.document.querySelector('egs-navigation').setAttribute('isloggedin', 'false');
  assert.deepEqual(page.get(), { refused: true, needsLogin: true });
  assert.equal(page.clicks(), 0);
});

test('a current signed-in zero-price Get still clicks exactly once', t => {
  const page = productFixture(t);
  assert.deepEqual(page.get(), { clicked: true });
  assert.equal(page.clicks(), 1);
});
