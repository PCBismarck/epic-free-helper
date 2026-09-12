'use strict';

const elements = Object.fromEntries([
  'status-text', 'status-note', 'status-dot', 'updated-at', 'run-button',
  'stop-button', 'enabled-toggle', 'notice', 'empty-games', 'game-list',
].map(id => [id, document.getElementById(id)]));

const states = {
  idle: ['准备就绪，尚未开始领取', 'neutral'],
  running: ['正在检查并领取本周游戏…', 'active'],
  claimed: ['本周游戏已领取', 'success'],
  already_owned: ['本周游戏已在你的游戏库中', 'success'],
  no_free_games: ['本周暂无符合条件的免费游戏', 'neutral'],
  needs_login: ['请先登录 Epic，本次领取尚未完成', 'attention'],
  needs_attention: ['本次领取需要你处理，尚未确认成功', 'attention'],
  interrupted: ['本次任务已中断，未确认全部领取', 'attention'],
  stopped: ['本次任务已停止，未确认全部领取', 'neutral'],
  failed: ['本次任务未完成，请查看提示后重试', 'attention'],
  completed: ['本次检查已结束，请查看下方领取结果', 'neutral'],
};
const gameStates = {
  claimed: ['已领取', 'success'],
  already_owned: ['已拥有·已跳过', 'success'],
  owned: ['已拥有', 'success'],
  pending: ['待处理', 'neutral'],
  running: ['处理中', 'neutral'],
  failed: ['未完成', 'attention'],
  needs_login: ['待登录', 'attention'],
  needs_attention: ['待确认', 'attention'],
  interrupted: ['已中断', 'attention'],
  stopped: ['已停止', 'neutral'],
  skipped: ['已跳过', 'neutral'],
};

let snapshot = { settings: { enabled: false }, status: { state: 'loading', games: [] }, job: null };
let busy = false;
let loaded = false;

function plainText(value, maximum = 600) {
  return typeof value === 'string' ? value.slice(0, maximum) : '';
}

function showNotice(message = '') {
  elements.notice.textContent = plainText(message);
  elements.notice.hidden = !elements.notice.textContent;
}

function storeLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'store.epicgames.com'
        && !url.username && !url.password && !url.port) return url.href;
  } catch { /* Render an ordinary title when the link is not a trusted store URL. */ }
  return null;
}

function displayTime(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '尚未运行';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '尚未运行';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function renderGames(status) {
  const games = Array.isArray(status.games) ? status.games.filter(game => game && typeof game === 'object') : [];
  elements['game-list'].replaceChildren();
  elements['empty-games'].hidden = games.length > 0;
  elements['empty-games'].textContent = status.state === 'no_free_games'
    ? '本周暂无可领取游戏' : status.running || status.state === 'running'
      ? '正在检查本周游戏…' : '尚无领取记录';
  for (const game of games) {
    const item = document.createElement('li');
    const details = document.createElement('div');
    details.className = 'game-details';
    const url = storeLink(game.url);
    const title = document.createElement(url ? 'a' : 'span');
    title.className = 'game-title';
    title.textContent = plainText(game.title, 200) || '未命名游戏';
    if (url) {
      title.href = url;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
    }
    details.append(title);
    const reason = plainText(game.reason, 300);
    if (reason) {
      const explanation = document.createElement('small');
      explanation.className = 'game-reason';
      explanation.textContent = reason;
      details.append(explanation);
    }
    const badge = document.createElement('span');
    const [label, tone] = Object.hasOwn(gameStates, game.status) ? gameStates[game.status] : ['未确认', 'neutral'];
    badge.className = 'game-state';
    badge.textContent = label;
    badge.dataset.tone = tone;
    item.append(details, badge);
    elements['game-list'].append(item);
  }
}

function render() {
  const status = snapshot.status || {};
  const running = Boolean(status.running) || status.state === 'running';
  const [label, tone] = Object.hasOwn(states, status.state)
    ? states[status.state] : [loaded ? '尚未确认当前领取状态' : '正在读取最近状态…', 'neutral'];
  elements['status-text'].textContent = label;
  elements['status-dot'].dataset.tone = tone;
  elements['status-note'].textContent = plainText(status.note);
  elements['status-note'].hidden = !elements['status-note'].textContent;
  elements['updated-at'].textContent = displayTime(status.updatedAt);
  elements['enabled-toggle'].checked = snapshot.settings?.enabled === true;
  elements['enabled-toggle'].disabled = busy || !loaded;
  elements['run-button'].disabled = busy || !loaded || running;
  elements['stop-button'].disabled = busy || !loaded
    || (!snapshot.job && !running && !Number.isInteger(status.tabId));
  renderGames(status);
}

function acceptSnapshot(response) {
  if (response?.settings && typeof response.settings === 'object') snapshot.settings = response.settings;
  if (response?.status && typeof response.status === 'object') snapshot.status = response.status;
  if (response && Object.hasOwn(response, 'job')) snapshot.job = response.job;
}

async function request(type, extra = {}) {
  busy = true;
  showNotice();
  render();
  try {
    const response = await chrome.runtime.sendMessage({ type, ...extra });
    acceptSnapshot(response);
    if (!response || response.ok === false) {
      showNotice(plainText(response?.error) || '暂时无法完成操作，请稍后重试。');
    } else {
      loaded = true;
    }
  } catch {
    showNotice('暂时无法读取或更新状态，请重新打开助手后重试。');
  } finally {
    busy = false;
    render();
  }
}

elements['run-button'].addEventListener('click', () => request('runNow'));
elements['stop-button'].addEventListener('click', () => request('stop'));
elements['enabled-toggle'].addEventListener('change', event => request('setEnabled', { enabled: event.target.checked }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) snapshot.settings = changes.settings.newValue || { enabled: false };
  if (changes.status) snapshot.status = changes.status.newValue || { state: 'idle', games: [] };
  if (changes.job) snapshot.job = changes.job.newValue || null;
  if (changes.settings || changes.status || changes.job) render();
});

request('getStatus');
