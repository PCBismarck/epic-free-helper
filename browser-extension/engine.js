import { PROMOTIONS_URL, canonicalProductUrl, selectWeeklyPcGames, isOwnedCta,
  isAllowedFreeCta, isZeroPriceText, isVerifiedZeroCheckout } from './rules.js';

// This function runs in the extension's isolated world, only in its own tab.
// It returns price and state evidence; no cookies, credentials or account names.
export function pageAction(action, game) {
  const visible = el => !!el && el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const text = el => (el?.innerText || '').trim();
  const normalize = value => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const canonical = value => {
    try {
      const url = new URL(value);
      const slug = url.pathname.match(/^\/(?:[a-z]{2}-[a-z]{2}\/)?p\/([a-z0-9-]+)\/?$/i)?.[1];
      return url.protocol === 'https:' && url.hostname === 'store.epicgames.com' &&
        !url.search && !url.hash && slug ? `https://store.epicgames.com/p/${slug.toLowerCase()}` : null;
    } catch { return null; }
  };
  const zero = value => {
    value = String(value || '').replace(/\u00a0/g, ' ').trim();
    if (/^(free|免费|kostenlos|gratuit|gratis)$/i.test(value)) return true;
    value = value.replace(/(?:\b(?:USD|EUR|GBP|CNY|RMB|JPY|HKD|TWD|CAD|AUD|KRW|INR|BRL|RUB)\b|CN¥|US\$|HK\$|NT\$|R\$|[$€£¥￥₽₩₹])/gi, '').trim();
    return /^0+(?:[.,]0{1,3})?$/.test(value);
  };
  const body = (document.body?.innerText || '').slice(0, 60000);
  const blocked = /one more step|please complete a security check|verify you are human|验证您是真人/i.test(body) ||
    [...document.querySelectorAll('iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[src*="challenges.cloudflare.com"]')].some(visible);
  if (blocked) return { challenge: true };
  const nav = document.querySelector('egs-navigation');
  const button = [...document.querySelectorAll('button[data-testid="purchase-cta-button"]')].find(visible);
  const freeTexts = new Set();
  let scope = button?.parentElement;
  for (let depth = 0; scope && depth < 6; depth++, scope = scope.parentElement) {
    if (scope.tagName === 'BODY' || scope.querySelectorAll('button[data-testid="purchase-cta-button"]').length !== 1 || text(scope).length > 2000) break;
    for (const el of scope.querySelectorAll('[data-testid*="price" i], [data-component*="price" i], [class*="price" i]')) {
      if (visible(el)) freeTexts.add(text(el));
    }
    for (const el of scope.querySelectorAll('span,div')) {
      if (!el.children.length && visible(el) && /^(free|免费|kostenlos|gratuit|gratis)$/i.test(text(el))) freeTexts.add(text(el));
    }
  }
  const evidence = {
    url: location.href, cta: text(button), ready: !!button && !button.disabled,
    loggedIn: nav?.getAttribute('isloggedin') || null, freeTexts: [...freeTexts],
    needsLogin: /\/id\/login|\/login(?:\/|$)/i.test(location.pathname),
  };
  const allowedGet = /^(get|claim|claim now|get for free|free|获取|领取|免费|免费获取|免费领取)$/i;
  if (action === 'get') {
    if (canonical(location.href) !== game.url || evidence.loggedIn !== 'true') return { refused: true, needsLogin: evidence.loggedIn === 'false' };
    const owned = /^(?:in library|in your library|owned|already owned|in der bibliothek|in bibliothek|dans la biblioth[eè]que|en la biblioteca|nella libreria|在库中|已在库中|已拥有|已在游戏库中|在游戏库中)$/i;
    if (owned.test(evidence.cta)) return { owned: true };
    if (!evidence.ready ||
        !allowedGet.test(evidence.cta) || !evidence.freeTexts.some(zero)) return { refused: true };
    button.click();
    return { clicked: true };
  }
  // Restrict root-document checkout to a visible dialog. In child frames,
  // only an Epic HTTPS origin and a matching game title can supply an order.
  const orderScopes = window.top === window
    ? [...document.querySelectorAll('[role="dialog"]')].filter(visible)
    : [document.body].filter(Boolean);
  const orderPattern = /^(add to library|place order|添加到库|添加至游戏库|添加到游戏库|下单|获取|zur bibliothek hinzufügen|bestellung abschließen)$/i;
  for (const order of orderScopes) {
    const submit = [...order.querySelectorAll('button')].find(el => visible(el) && !el.disabled && orderPattern.test(text(el)));
    if (!submit) continue;
    const lines = text(order).split(/[\r\n]+/).map(v => v.trim()).filter(Boolean);
    const totals = [];
    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(/^(?:total|order total|总计|合计|总额|gesamt|gesamtbetrag)(?:\s*[:：]\s*|\s+|$)(.*)$/i);
      if (match) totals.push(match[1] || lines[index + 1] || '');
    }
    const totalText = totals.map(value => `Total\n${value}`).join('\n');
    let matchesTitle = !!normalize(game.title) && normalize(text(order)).includes(normalize(game.title));
    let verified = matchesTitle && totals.length > 0 && totals.every(zero);
    evidence.order = { kind: 'total', matchesTitle, totalText };
    // Captured Windows zh-CN checkout: one adjacent title/price pair, a
    // free-content heading, and "添加到库". There is no Total row. Bind the
    // exception to the exact free-checkout URL and sole API offer, then
    // recompute all DOM evidence again on the later submit invocation.
    if (location.hash === '#/free-checkout') {
      const url = new URL(location.href);
      const names = [...url.searchParams.keys()];
      const allowedNames = new Set(['offers', 'highlightColor', 'lang', 'showNavigation']);
      const matchesOffer = url.origin === 'https://store.epicgames.com' &&
        !url.username && !url.password && !url.port && url.pathname === '/purchase' &&
        names.every(name => allowedNames.has(name)) &&
        new Set(names).size === names.length && url.searchParams.getAll('offers').length === 1 &&
        /^[a-z0-9-]+$/i.test(game.namespace || '') && /^[a-z0-9-]+$/i.test(game.id || '') &&
        url.searchParams.get('offers') === `1-${game.namespace}-${game.id}--`;
      const itemCards = [...order.querySelectorAll('div')].flatMap(el => {
        const children = [...el.children];
        const content = children.filter(child => text(child));
        const decorations = children.filter(child => !text(child));
        const itemLines = text(el).split(/[\r\n]+/).map(value => value.trim()).filter(Boolean);
        // The live card also has a text-free DIV containing its cover image.
        // Only the two adjacent text spans identify the item and its price;
        // collect every such card before checking the sole expected title.
        if (!visible(el) || content.length !== 2 ||
            !content.every(child => child.tagName === 'SPAN' && visible(child)) ||
            content[0].nextElementSibling !== content[1] || decorations.length > 1 ||
            !decorations.every(child => child.tagName === 'DIV' && child.querySelector('img') &&
              !child.querySelector('a,button,input,select,textarea')) ||
            itemLines.length !== 2 || text(content[0]) !== itemLines[0] || text(content[1]) !== itemLines[1]) return [];
        return [{ titleText: text(content[0]), priceText: text(content[1]) }];
      });
      matchesTitle = itemCards.length === 1 && !!normalize(game.title) &&
        normalize(itemCards[0].titleText) === normalize(game.title);
      const itemPriceText = itemCards.length === 1 ? itemCards[0].priceText : '';
      const hasFreeContent = [...order.querySelectorAll('h5')].some(el => visible(el) &&
        normalize(text(el)) === normalize('这是免费内容。添加到库即可开始体验。'));
      const addButtons = [...order.querySelectorAll('button')].filter(el => visible(el) &&
        !el.disabled && /^(添加到库|add to library)$/i.test(text(el)));
      verified = matchesOffer && matchesTitle && hasFreeContent && addButtons.length === 1 &&
        addButtons[0] === submit && /[0-9]/.test(itemPriceText) && zero(itemPriceText) && totals.every(zero);
      evidence.order = { kind: 'free_checkout', matchesTitle, checkoutUrl: location.href,
        itemPriceText, hasFreeContent: hasFreeContent && addButtons.length === 1 && addButtons[0] === submit, totalText };
    }
    if (action === 'submit') {
      const host = location.hostname;
      if (location.protocol !== 'https:' || !(host === 'epicgames.com' || host.endsWith('.epicgames.com')) ||
          !verified) return { refused: true };
      submit.click();
      return { clicked: true };
    }
    break;
  }
  return evidence;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function inspect(tabId, frame, game, action = 'inspect') {
  if (!frame?.documentId) throw new Error('missing_document_id');
  const results = await chrome.scripting.executeScript({
    target: { tabId, documentIds: [frame.documentId] }, func: pageAction, args: [action, game],
  });
  const result = results[0];
  if (results.length !== 1 || result?.documentId !== frame.documentId || result.frameId !== frame.frameId) {
    throw new Error('document_mismatch');
  }
  return { ...result.result, documentId: result.documentId };
}

// Retry only inspections interrupted by a document being replaced. Get and
// Submit never use this retry path, because their effects may have happened.
const isNavigationReadError = error => /^(?:missing_document_id|document_changed|document_mismatch)$/.test(error?.message || '') ||
  /^(?:No document with id |No frame with id |Frame with ID .* was removed|The frame was removed)/i.test(error?.message || '');

async function stillFree(game) {
  const response = await fetch(PROMOTIONS_URL, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) return false;
  return selectWeeklyPcGames(await response.json()).some(current => current.url === game.url &&
    current.id === game.id && current.namespace === game.namespace);
}

async function localizedCheckoutGame(game, order) {
  const locale = new URL(order.checkoutUrl).searchParams.get('lang');
  if (!locale || !/^[a-z]{2}(?:-[a-z]{2})?$/i.test(locale)) return null;
  const endpoint = new URL(PROMOTIONS_URL);
  endpoint.searchParams.set('locale', locale);
  const response = await fetch(endpoint.href, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) return null;
  // The translated name must come from the same currently free official offer,
  // never from the checkout DOM or a fuzzy title comparison.
  const localized = selectWeeklyPcGames(await response.json()).find(current =>
    current.url === game.url && current.id === game.id && current.namespace === game.namespace);
  return localized ? { ...game, title: localized.title } : null;
}

export async function claimGame(tabId, game, isCancelled = () => false) {
  const attention = reason => ({ status: 'needs_attention', reason });
  const check = () => { if (isCancelled()) throw new Error('cancelled'); };
  let productDocumentId = null;
  const frameAt = async (frameId = 0) => {
    check();
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId });
    check();
    return frame ? { ...frame, frameId } : null;
  };
  const read = async (frameId = 0, action = 'inspect', expectedDocumentId = null, orderGame = game) => {
    check();
    const tab = await chrome.tabs.get(tabId);
    check();
    if (!/^https:\/\/(?:[a-z0-9-]+\.)*epicgames\.com\//i.test(tab.url || '')) throw new Error('untrusted_page');
    if (action !== 'inspect' && canonicalProductUrl(tab.url) !== game.url) return { refused: true };
    const frame = await frameAt(frameId);
    if (!frame?.documentId) throw new Error('missing_document_id');
    if (expectedDocumentId && frame.documentId !== expectedDocumentId) throw new Error('document_changed');
    if (!/^https:\/\/(?:[a-z0-9-]+\.)*epicgames\.com\//i.test(frame.url || '')) throw new Error('untrusted_page');
    if (action !== 'inspect') {
      const root = frameId === 0 ? frame : await frameAt();
      if (root?.documentId !== productDocumentId || canonicalProductUrl(root?.url) !== game.url) return { refused: true };
    }
    check();
    const state = await inspect(tabId, frame, orderGame, action);
    check();
    return state;
  };
  const navigate = async () => {
    const previous = await frameAt();
    if (previous && !previous.documentId) throw new Error('missing_document_id');
    const oldDocumentId = previous?.documentId || productDocumentId;
    check();
    await chrome.tabs.update(tabId, { url: game.url });
    check();
    return oldDocumentId;
  };
  const waitPage = async ({ oldDocumentId = null, ownedOnly = false, expectedDocumentId = null } = {}) => {
    const deadline = Date.now() + 35000;
    let stable = null;
    let sawOwned = false;
    let loggedOut = false;
    while (Date.now() < deadline) {
      check();
      let state = null;
      try {
        const tab = await chrome.tabs.get(tabId);
        check();
        if (/^https:\/\/(?:[a-z0-9-]+\.)*epicgames\.com\//i.test(tab.url || '')) {
          const frame = await frameAt();
          // tabs.update can resolve before navigation commits. Even an Owned
          // button at the exact same URL is stale until its document changes.
          if (frame?.documentId && frame.documentId !== oldDocumentId &&
              (!expectedDocumentId || frame.documentId === expectedDocumentId)) {
            state = await read(0, 'inspect', frame.documentId);
          }
        } else if (tab.url && tab.url !== 'about:blank') throw new Error('untrusted_page');
      } catch (error) {
        if (!isNavigationReadError(error)) throw error;
      }
      if (state?.challenge || state?.needsLogin) return state;
      if (!state || canonicalProductUrl(state.url) !== game.url) {
        stable = null;
        loggedOut = false;
      } else if (state.loggedIn !== 'true') {
        // The navigation element initially says false while the existing
        // Windows session hydrates. Never click until it positively resolves.
        stable = null;
        loggedOut = state.loggedIn === 'false';
      } else {
        loggedOut = false;
        const owned = isOwnedCta(state.cta);
        if (owned) sawOwned = true;
        const usable = owned || (!ownedOnly && !sawOwned && state.ready && state.cta && !/^loading|加载/i.test(state.cta));
        const signature = owned ? 'owned' : JSON.stringify([state.cta, state.freeTexts]);
        if (!usable) stable = null;
        else if (stable?.documentId !== state.documentId || stable.signature !== signature) {
          stable = { documentId: state.documentId, signature, since: Date.now() };
        } else if (Date.now() - stable.since >= (owned ? 1500 : 3000)) {
          productDocumentId = state.documentId;
          return { ...state, ownedConfirmed: owned };
        }
      }
      await delay(750);
    }
    if (loggedOut) throw new Error('needs_login');
    throw new Error('page_timeout');
  };
  const verify = async () => {
    const oldDocumentId = await navigate();
    try {
      const state = await waitPage({ oldDocumentId, ownedOnly: true });
      if (state.needsLogin) throw new Error('needs_login');
      return !state.challenge && state.ownedConfirmed === true;
    } catch (error) {
      if (error.message === 'page_timeout') return false;
      throw error;
    }
  };
  try {
    if (canonicalProductUrl(game.url) !== game.url) return attention('商品链接未通过校验');
    check();
    const oldDocumentId = await navigate();
    let state = await waitPage({ oldDocumentId });
    if (state.challenge) return attention('浏览器遇到安全验证；自动领取已暂停，请在保留的标签页处理');
    if (state.needsLogin || state.loggedIn === 'false') return { status: 'needs_login', reason: '请在 Windows 浏览器登录 Epic 后重新运行' };
    if (canonicalProductUrl(state.url) !== game.url) return attention('商品页发生了未识别的跳转');
    if (state.ownedConfirmed) return { status: 'already_owned' };
    if (!isAllowedFreeCta(state.cta) || !state.freeTexts?.some(isZeroPriceText) || !await stillFree(game)) return attention('没有确认当前商品仍为零元，已停止');
    const clicked = await read(0, 'get', state.documentId);
    if (clicked.needsLogin) throw new Error('needs_login');
    if (clicked.owned) {
      const confirmed = await waitPage({ ownedOnly: true, expectedDocumentId: clicked.documentId });
      if (confirmed.needsLogin) throw new Error('needs_login');
      return confirmed.ownedConfirmed ? { status: 'already_owned' } : attention('已拥有状态尚未稳定，请在保留的标签页查看');
    }
    if (!clicked.clicked) return attention('领取按钮或免费价格发生变化，已停止');

    const deadline = Date.now() + 45000;
    let submitted = false;
    while (Date.now() < deadline) {
      check();
      try { state = await read(); } catch (error) {
        if (!isNavigationReadError(error)) throw error;
        await delay(900);
        continue;
      }
      if (state.needsLogin) throw new Error('needs_login');
      if (state.challenge) return attention('需要完成安全验证，自动领取已暂停');
      if (canonicalProductUrl(state.url) !== game.url) return attention('结账发生未识别跳转，请在标签页查看');
      if (isOwnedCta(state.cta)) return await verify() ? { status: 'claimed' } : attention('领取后尚未确认入库');
      if (!submitted) {
        const frames = await chrome.webNavigation.getAllFrames({ tabId });
        for (const frame of frames || []) {
          check();
          let url;
          try { url = new URL(frame.url); } catch { continue; }
          if (url.protocol !== 'https:' || !(url.hostname === 'epicgames.com' || url.hostname.endsWith('.epicgames.com'))) continue;
          let checkout;
          try { checkout = frame.frameId === 0 ? state : await read(frame.frameId); } catch (error) {
            if (!isNavigationReadError(error)) throw error;
            continue;
          }
          if (checkout.challenge) return attention('结账要求安全验证，自动领取已暂停');
          if (!checkout.order) continue;
          let orderGame = game;
          if (checkout.order.kind === 'free_checkout' && checkout.order.matchesTitle === false &&
              isVerifiedZeroCheckout({ ...checkout.order, matchesTitle: true }, game)) {
            // Only the title may differ: validate the exact offer, URL and zero
            // amount before looking up its name in the checkout's language.
            try { orderGame = await localizedCheckoutGame(game, checkout.order); }
            catch { check(); return attention('无法从官方列表确认当前语言的商品名称，已停止'); }
            check();
            if (!orderGame) return attention('商品名称未匹配当前语言的官方周免记录，已停止');
            try { checkout = await read(frame.frameId, 'inspect', checkout.documentId, orderGame); }
            catch (error) {
              if (!isNavigationReadError(error)) throw error;
              continue;
            }
            if (checkout.challenge) return attention('结账要求安全验证，自动领取已暂停');
          }
          if (!isVerifiedZeroCheckout(checkout.order, orderGame) || !await stillFree(game)) return attention('订单商品或零元结账未通过核验，已停止');
          if (!(await read(frame.frameId, 'submit', checkout.documentId, orderGame)).clicked) return attention('提交前订单状态变化，已停止');
          submitted = true;
          break;
        }
      }
      await delay(900);
    }
    // One final product reload verifies ownership; never resubmit the order.
    return await verify() ? { status: 'claimed' } : attention('尚未确认入库，请在保留的标签页查看');
  } catch (error) {
    if (error.message === 'needs_login') return { status: 'needs_login', reason: '请在 Windows 浏览器登录 Epic 后重新运行' };
    if (error.message === 'page_timeout') return attention('页面状态未稳定，请在保留的标签页查看');
    return { status: 'failed', reason: error.message === 'cancelled' ? '本次任务已停止' : '页面未完成或状态无法核验；没有重复提交' };
  }
}
