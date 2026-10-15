// Pure rules for Epic weekly PC offers, ownership and zero-price checkout.
export const PROMOTIONS_URL = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=en-US';

export function canonicalProductUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'store.epicgames.com'
        || url.username || url.password || url.port || url.search || url.hash) return null;
    const match = url.pathname.match(/^\/(?:[a-z]{2}-[A-Z]{2}\/)?p\/([a-z0-9][a-z0-9-]*)\/?$/i);
    return match ? `https://store.epicgames.com/p/${match[1].toLowerCase()}` : null;
  } catch { return null; }
}

export function selectWeeklyPcGames(payload, now = Date.now()) {
  const elements = payload?.data?.Catalog?.searchStore?.elements;
  if (!Array.isArray(elements) || !Number.isFinite(now)) throw new Error('invalid_promotions_response');
  const selected = new Map();
  for (const item of elements) {
    const price = item?.price?.totalPrice;
    const categories = (item?.categories || []).map(c => c?.path).filter(x => typeof x === 'string');
    if (item?.offerType !== 'BASE_GAME' || !categories.includes('games')
        || !categories.includes('freegames') || categories.some(c => /mobile|android|ios|dlc|addons/i.test(c))
        || !Number.isFinite(price?.originalPrice) || price.originalPrice <= 0 || price.discountPrice !== 0
        || typeof item.id !== 'string' || !item.id || typeof item.namespace !== 'string' || !item.namespace
        || typeof item.title !== 'string' || !item.title.trim()) continue;
    const offers = (item.promotions?.promotionalOffers || []).flatMap(group => group?.promotionalOffers || []);
    const current = offers.find(offer => {
      const start = Date.parse(offer?.startDate);
      const end = Date.parse(offer?.endDate);
      return offer?.discountSetting?.discountType === 'PERCENTAGE'
        && offer.discountSetting.discountPercentage === 0
        && Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end;
    });
    if (!current) continue;
    // Only product-home mappings are accepted. Do not guess from URL slugs,
    // game IDs, collection links, or third-party discovery feeds.
    const mappings = [...(item.catalogNs?.mappings || []), ...(item.offerMappings || [])];
    const mapping = mappings.find(m => m?.pageType === 'productHome'
      && /^[a-z0-9][a-z0-9-]*$/i.test(m.pageSlug || '')
      && !/(?:^|-)(?:ios|android|mobile)(?:-|$)/i.test(m.pageSlug));
    if (!mapping) continue;
    const url = canonicalProductUrl(`https://store.epicgames.com/p/${mapping.pageSlug}`);
    if (!url) continue;
    const game = {
      title: item.title.trim(), url, id: item.id, namespace: item.namespace,
      start: current.startDate, end: current.endDate,
      originalPrice: price.originalPrice, discountPrice: 0,
    };
    const previous = selected.get(url);
    // Conflicting offers for one page cannot be safely tied to its CTA.
    if (previous && (previous.id !== game.id || previous.namespace !== game.namespace)) selected.set(url, null);
    else if (!selected.has(url)) selected.set(url, game);
  }
  return [...selected.values()].filter(Boolean);
}

export const isAllowedFreeCta = text => /^(?:get|claim|claim now|get for free|free|获取|领取|免费|免费获取|免费领取)$/i.test(String(text || '').trim());
export const isOwnedCta = text => /^(?:in library|in your library|owned|already owned|in der bibliothek|in bibliothek|dans la biblioth[eè]que|en la biblioteca|nella libreria|在库中|已在库中|已拥有|已在游戏库中|在游戏库中)$/i.test(String(text || '').trim());

export function isZeroPriceText(text) {
  const value = String(text || '').replace(/\u00a0/g, ' ').trim();
  if (/^(?:free|免费|kostenlos|gratuit|gratis)$/i.test(value)) return true;
  // Strip only known currency notation; never drop arbitrary words, signs,
  // percentages, or nonzero digits from a checkout amount.
  const amount = value.replace(/(?:\b(?:USD|EUR|GBP|CNY|RMB|JPY|HKD|TWD|CAD|AUD|KRW|INR|BRL|RUB)\b|CN¥|US\$|HK\$|NT\$|R\$|[$€£¥￥₽₩₹])/gi, '').trim();
  return /^0+(?:[.,]0{1,3})?$/.test(amount);
}

export function hasZeroCheckoutTotal(text) {
  const lines = String(text || '').split(/[\r\n]+/).map(line => line.trim()).filter(Boolean);
  const totals = [];
  const label = /^(?:total|order total|总计|合计|总额|gesamt|gesamtbetrag)(?:\s*[:：]\s*|\s+|$)(.*)$/i;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(label);
    if (match) totals.push(match[1] || lines[i + 1] || '');
  }
  return totals.length > 0 && totals.every(isZeroPriceText);
}

// Epic's newer free-checkout screen has a single item price instead of a
// Total row. This exception requires that exact route and offer identity;
// an arbitrary zero amount in a normal checkout is never sufficient.
export function isVerifiedZeroCheckout(order, game) {
  return checkoutFailureReason(order, game) === null;
}

export function checkoutFailureReason(order, game) {
  if (!order) return '尚未识别结账订单';
  if (order.kind === undefined || order.kind === 'total') {
    if (!order.matchesTitle) return '结账商品名称与当前游戏不一致';
    return hasZeroCheckoutTotal(order.totalText) ? null : '结账总额缺失或不是零元';
  }
  if (order.kind !== 'free_checkout') return '尚不支持此结账页面结构';
  try {
    const url = new URL(order.checkoutUrl);
    const names = [...url.searchParams.keys()];
    if (url.origin !== 'https://store.epicgames.com' || url.username || url.password || url.port ||
        url.hash !== '#/free-checkout' || new Set(names).size !== names.length ||
        !/^[a-z0-9-]+$/i.test(game?.namespace || '') || !/^[a-z0-9-]+$/i.test(game?.id || '') ||
        !['/purchase', '/checkout'].includes(url.pathname)) return '结账地址或参数不受支持';
    if (url.pathname === '/purchase') {
      const allowedNames = new Set(['offers', 'highlightColor', 'lang', 'showNavigation']);
      if (names.some(name => !allowedNames.has(name))) return '结账地址包含未识别参数';
      if (url.searchParams.getAll('offers').length !== 1 ||
          url.searchParams.get('offers') !== `1-${game.namespace}-${game.id}--`) return '结账商品编号与当前周免不一致';
    } else {
      // pageAction removes the purchase token and returns only a proof from
      // the same document, avoiding checkout credentials in evidence/logs.
      if (names.some(name => name !== 'locale')) return '结账地址包含未识别参数';
      if (order.identity?.tokenBound !== true) return '新版结账缺少可核验的商品身份数据';
      if (order.identity.namespace !== game.namespace || order.identity.offerId !== game.id ||
          order.identity.quantity !== 1) return '结账商品编号或数量与当前周免不一致';
    }
  } catch { return '结账地址无法识别'; }
  if (!order.matchesTitle) return '结账商品名称与当前游戏不一致';
  if (!/[0-9]/.test(order.itemPriceText || '') || !isZeroPriceText(order.itemPriceText)) return '结账商品价格缺失或不是零元';
  if (order.hasFreeContent !== true) return '结账免费说明或唯一添加到库按钮未通过核验';
  if (typeof order.totalText !== 'string' || (order.totalText !== '' && !hasZeroCheckoutTotal(order.totalText))) return '结账总额缺失或不是零元';
  return null;
}

export function summarizeClaim(games, override = null, now = new Date()) {
  const clean = games.map(game => ({ title: game.title, url: game.url, status: game.status }));
  let state = override;
  if (!state) {
    if (!clean.length) state = 'no_free_games';
    else if (clean.some(game => game.status === 'failed')) state = 'failed';
    else if (clean.some(game => !['claimed', 'already_owned'].includes(game.status))) state = 'needs_attention';
    else state = clean.some(game => game.status === 'claimed') ? 'claimed' : 'already_owned';
  }
  return { mode: 'claim', state, games: clean, time: now.toISOString() };
}
