import { PROMOTIONS_URL, selectWeeklyPcGames, canonicalProductUrl, summarizeClaim } from './rules.js';
import { claimGame } from './engine.js';

const DAILY_ALARM = 'epic-daily';
const DEADLINE_PREFIX = 'epic-deadline-';
const RUN_LIMIT_MS = 5 * 60 * 1000;
const MAX_GAMES = 10;
const DEFAULT_SETTINGS = { enabled: false, hour: 23, minute: 35 };
const EMPTY_STATUS = { state: 'idle', note: '请先手动试领，确认正常后再开启定时。', games: [], running: false, updatedAt: null, nextRunAt: null, tabId: null };
let sessionId;
let activeRun = null;
let mutationTail = Promise.resolve();

// Short state transitions are serialized. The page engine runs outside this
// queue so Stop can cancel it while it is waiting for a page or network request.
function exclusive(action) {
  const result = mutationTail.then(action);
  mutationTail = result.catch(() => {});
  return result;
}

function normalizeSettings(settings = {}) {
  return {
    enabled: settings.enabled === true,
    hour: Number.isInteger(settings.hour) && settings.hour >= 0 && settings.hour <= 23 ? settings.hour : DEFAULT_SETTINGS.hour,
    minute: Number.isInteger(settings.minute) && settings.minute >= 0 && settings.minute <= 59 ? settings.minute : DEFAULT_SETTINGS.minute,
  };
}

async function readState() {
  const data = await chrome.storage.local.get(['settings', 'status', 'job']);
  return { settings: normalizeSettings(data.settings), status: { ...EMPTY_STATUS, ...data.status }, job: data.job || null };
}

async function updateToolbar({ status, settings }) {
  const games = Array.isArray(status.games) ? status.games : [];
  const successful = game => ['claimed', 'already_owned'].includes(game?.status);
  const attention = value => ['failed', 'needs_login', 'needs_attention', 'interrupted'].includes(value);
  const completed = games.filter(successful).length;
  const problem = games.find(game => attention(game?.status));
  let text = '', color = '#64748b', label = '尚未运行';
  if (status.running || status.state === 'running') {
    text = '…'; color = '#2563eb'; label = `正在检查（已确认 ${completed}/${games.length} 款）`;
  } else if (attention(status.state) || problem) {
    text = '!'; color = '#dc2626'; label = '领取未完成，需要处理';
  } else if (['claimed', 'already_owned'].includes(status.state)) {
    // A single successful game must never hide an unconfirmed game.
    if (games.length && completed === games.length) {
      text = '✓'; color = '#15803d'; label = `最近一轮全部确认在库（${completed} 款）`;
    } else {
      text = '!'; color = '#dc2626'; label = '领取结果不完整，需要检查';
    }
  } else if (status.state === 'stopped' || status.state === 'no_free_games') {
    text = '–'; color = '#a16207';
    label = status.state === 'stopped' ? '任务已停止，未确认全部领取' : '本轮没有符合条件的周免游戏';
  }
  const detail = problem
    ? [problem.title, problem.reason].filter(value => typeof value === 'string').join('：')
    : status.note;
  const when = status.updatedAt ? new Date(status.updatedAt) : null;
  const updated = when && Number.isFinite(when.getTime())
    ? `最近更新：${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(when)}` : '';
  const title = ['Epic 周免领取助手', label, typeof detail === 'string' ? detail.slice(0, 300) : '', updated,
    settings.enabled ? '每日定时已开启' : '每日定时已关闭', '点击查看每款游戏的结果'].filter(Boolean).join('\n');
  // Global action state survives popup closure and is restored at worker start.
  // A toolbar API failure must not interrupt saving or completing a claim.
  try {
    await Promise.allSettled([
      chrome.action.setBadgeBackgroundColor({ color }),
      chrome.action.setBadgeTextColor({ color: '#ffffff' }),
      chrome.action.setTitle({ title }),
    ]);
    await chrome.action.setBadgeText({ text });
  } catch { /* Claim state remains available in the popup. */ }
}

async function saveState(changes) {
  await chrome.storage.local.set(changes);
  if (changes.status || changes.settings) await updateToolbar(await readState());
}

async function response(ok = true, error) {
  const { settings, status, job } = await readState();
  return { ok, settings, status, job, ...(error ? { error } : {}) };
}

function nextBeijingRun(settings, now = Date.now()) {
  const shifted = new Date(now + 8 * 60 * 60 * 1000);
  let when = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), settings.hour, settings.minute) - 8 * 60 * 60 * 1000;
  if (when <= now) when += 24 * 60 * 60 * 1000;
  return when;
}

async function syncSchedule(settings, status, reset = false) {
  if (!settings.enabled) {
    await chrome.alarms.clear(DAILY_ALARM);
    return { ...status, nextRunAt: null };
  }
  const existing = reset ? null : await chrome.alarms.get(DAILY_ALARM);
  // Preserve a due alarm when the worker wakes to handle it. An absent alarm
  // is recreated for the next Beijing evening; there is no catch-up loop.
  const when = existing?.scheduledTime ?? nextBeijingRun(settings);
  if (!existing) await chrome.alarms.create(DAILY_ALARM, { when });
  return { ...status, nextRunAt: when };
}

async function recordedTabExists(job) {
  if (!job || job.sessionId !== sessionId || !Number.isInteger(job.tabId)) return false;
  try { await chrome.tabs.get(job.tabId); return true; } catch { return false; }
}

async function closeRecordedTab(job) {
  if (!job || job.sessionId !== sessionId || !Number.isInteger(job.tabId)) return;
  // No tabs.query: only a tab ID returned by our own tabs.create is eligible.
  try { await chrome.tabs.remove(job.tabId); } catch { /* Already closed. */ }
}

async function initialize() {
  const session = await chrome.storage.session.get('epicSessionId');
  sessionId = session.epicSessionId || crypto.randomUUID();
  if (!session.epicSessionId) await chrome.storage.session.set({ epicSessionId: sessionId });
  let { settings, status, job } = await readState();
  if (job) {
    settings.enabled = false;
    await chrome.alarms.clear(`${DEADLINE_PREFIX}${job.runId}`);
    if (job.sessionId !== sessionId || job.phase === 'detached') {
      // Tab IDs must not be trusted across browser sessions. Keep an explicit
      // block until Stop instead of possibly closing somebody else's tab.
      job = { ...job, phase: 'detached', tabId: null };
      status = { ...status, state: 'interrupted', note: '浏览器或扩展已重启，本轮不会继续。请关闭之前的领取页，再点“停止”清除任务记录。', running: false, tabId: null };
    } else if (job.phase === 'manual' && await recordedTabExists(job)) {
      status = { ...status, running: false, tabId: job.tabId };
    } else {
      await closeRecordedTab(job);
      job = null;
      status = { ...status, state: 'interrupted', note: '后台任务中断，已停止并关闭本轮领取页。请先检查上次结果；定时已关闭。', running: false, tabId: null };
    }
    status.updatedAt = new Date().toISOString();
  } else if (status.running) {
    settings.enabled = false;
    status = { ...status, state: 'interrupted', note: '上次任务状态不完整，已停止且关闭定时。', running: false, tabId: null, updatedAt: new Date().toISOString() };
  }
  status = await syncSchedule(settings, status);
  await saveState({ settings, status, job });
}

const ready = exclusive(initialize);

function cancelled(run) {
  return run.cancelled || activeRun !== run || Date.now() >= run.deadline;
}

async function saveProgress(run, note) {
  return exclusive(async () => {
    if (cancelled(run)) return false;
    const data = await readState();
    if (data.job?.runId !== run.runId) return false;
    await saveState({
      job: { ...data.job, tabId: run.tabId, games: run.games },
      status: { ...data.status, note, games: run.games, updatedAt: new Date().toISOString() },
    });
    return true;
  });
}

async function finishRun(run, state, note, keepTab = false) {
  return exclusive(async () => {
    if (activeRun !== run || run.cancelled) return;
    run.cancelled = true;
    clearTimeout(run.timer);
    run.abort?.abort();
    const data = await readState();
    if (data.job?.runId !== run.runId) { activeRun = null; return; }
    await chrome.alarms.clear(`${DEADLINE_PREFIX}${run.runId}`);
    const safeSuccess = ['claimed', 'already_owned'].includes(state);
    if (!safeSuccess) data.settings.enabled = false;
    const preserve = keepTab && await recordedTabExists(data.job);
    if (!preserve) await closeRecordedTab(data.job);
    const status = await syncSchedule(data.settings, {
      ...data.status, state, note, games: run.games,
      running: false, updatedAt: new Date().toISOString(),
      tabId: preserve ? data.job.tabId : null,
    });
    await saveState({
      settings: data.settings, status,
      job: preserve ? { ...data.job, phase: 'manual', games: run.games } : null,
    });
    activeRun = null;
  });
}

async function fetchGames(run) {
  run.abort = new AbortController();
  const timeout = setTimeout(() => run.abort.abort(), 15000);
  try {
    const result = await fetch(PROMOTIONS_URL, { signal: run.abort.signal, credentials: 'omit' });
    if (!result.ok) throw new Error('promotions_unavailable');
    const games = selectWeeklyPcGames(await result.json());
    if (games.length > MAX_GAMES) throw new Error('too_many_games');
    if (games.some(game => canonicalProductUrl(game.url) !== game.url)) throw new Error('invalid_product_url');
    return games.map(game => ({ ...game, status: 'pending' }));
  } finally { clearTimeout(timeout); run.abort = null; }
}

async function executeRun(run) {
  try {
    run.games = await fetchGames(run);
    if (cancelled(run)) return;
    if (!run.games.length) {
      await finishRun(run, 'no_free_games', '没有找到符合规则的 PC 周免游戏；本次没有领取，定时已关闭。');
      return;
    }
    if (!await saveProgress(run, `找到 ${run.games.length} 款 PC 周免，准备逐一检查。`)) return;
    const created = await exclusive(async () => {
      if (cancelled(run)) return false;
      const data = await readState();
      if (data.job?.runId !== run.runId) return false;
      const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
      run.tabId = tab.id;
      try {
        // Persist the returned ID immediately, before navigating or claiming.
        await saveState({ job: { ...data.job, tabId: tab.id, games: run.games } });
      } catch (error) {
        await closeRecordedTab({ sessionId, tabId: tab.id });
        throw error;
      }
      return true;
    });
    if (!created) return;
    for (const game of run.games) {
      if (!await saveProgress(run, `正在检查：${game.title}`)) return;
      const result = await claimGame(run.tabId, game, () => cancelled(run));
      if (cancelled(run)) return;
      if (!['claimed', 'already_owned', 'needs_login', 'needs_attention', 'failed'].includes(result?.status)) throw new Error('invalid_engine_result');
      game.status = result.status;
      if (result.reason) game.reason = String(result.reason).slice(0, 300);
      else if (game.status === 'already_owned') game.reason = '已在当前账号的游戏库中，本轮已跳过领取。';
      if (!['claimed', 'already_owned'].includes(game.status)) {
        const manual = ['needs_login', 'needs_attention'].includes(game.status);
        const note = game.status === 'needs_login'
          ? '需要登录，已保留领取页并关闭定时。完成登录后，关闭该页并重新手动试领。'
          : manual
            ? '需要人工检查或安全验证，已保留领取页并关闭定时。处理后关闭该页，再手动试领。'
            : '本轮领取失败，已关闭领取页和定时。请查看下方结果后再手动试领。';
        await finishRun(run, game.status, note, manual);
        return;
      }
      if (!await saveProgress(run, game.status === 'already_owned'
        ? `已拥有，已跳过：${game.title}` : `已确认入库：${game.title}`)) return;
    }
    const summary = summarizeClaim(run.games);
    await finishRun(run, summary.state, summary.state === 'claimed' ? '本轮游戏已确认领取或已在库中。' : '本轮游戏已全部在库中。');
  } catch (error) {
    if (activeRun !== run || run.cancelled) return;
    const note = error?.message === 'too_many_games'
      ? '周免列表超过本轮 10 款上限，已停止并关闭定时。请人工检查。'
      : '网络、页面或任务执行出错，已停止并关闭定时。请查看结果后再手动试领。';
    await finishRun(run, 'failed', note);
  }
}

async function startRun(source) {
  const data = await readState();
  if (activeRun || data.status.running) return response(false, '本轮仍在运行，请等待或先点“停止”。');
  if (data.job) {
    if (data.job.phase === 'manual' && !await recordedTabExists(data.job)) {
      await saveState({ job: null, status: { ...data.status, tabId: null } });
    } else return response(false, '仍有待处理的领取页或中断记录。请关闭领取页，或点“停止”后再试。');
  }
  if (source === 'scheduled' && !data.settings.enabled) return response();
  const now = Date.now();
  const run = { runId: crypto.randomUUID(), startedAt: now, deadline: now + RUN_LIMIT_MS, tabId: null, games: [], cancelled: false, timer: null, abort: null };
  activeRun = run;
  try {
    await saveState({
      job: { runId: run.runId, sessionId, phase: 'running', source, startedAt: now, deadline: run.deadline, tabId: null, games: [] },
      status: { ...data.status, state: 'running', note: '正在读取 Epic 官方周免列表。', games: [], running: true, updatedAt: new Date().toISOString(), tabId: null },
    });
    await chrome.alarms.create(`${DEADLINE_PREFIX}${run.runId}`, { when: run.deadline });
    run.timer = setTimeout(() => {
      void finishRun(run, 'failed', '本轮已达到 5 分钟上限，已停止并关闭领取页和定时。').catch(() => {});
    }, RUN_LIMIT_MS);
    // The popup receives the start acknowledgement immediately. Progress and
    // results arrive through chrome.storage.onChanged, including after it closes.
    void executeRun(run).catch(() => {});
    return response();
  } catch (error) {
    run.cancelled = true;
    clearTimeout(run.timer);
    await chrome.alarms.clear(`${DEADLINE_PREFIX}${run.runId}`);
    data.settings.enabled = false;
    const status = await syncSchedule(data.settings, { ...data.status, state: 'failed', note: '任务未能启动，已停止并关闭定时。', running: false, tabId: null, updatedAt: new Date().toISOString() });
    await saveState({ settings: data.settings, status, job: null });
    activeRun = null;
    throw error;
  }
}

async function stopRun() {
  const data = await readState();
  if (activeRun) {
    activeRun.cancelled = true;
    clearTimeout(activeRun.timer);
    activeRun.abort?.abort();
  }
  if (data.job) await chrome.alarms.clear(`${DEADLINE_PREFIX}${data.job.runId}`);
  await closeRecordedTab(data.job);
  data.settings.enabled = false;
  const status = await syncSchedule(data.settings, {
    ...data.status, state: 'stopped', note: '已停止，定时已关闭。', running: false,
    tabId: null, updatedAt: new Date().toISOString(),
  });
  await saveState({ settings: data.settings, status, job: null });
  activeRun = null;
  return response();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only our popup/extension pages can start orders, not injected page scripts.
  if (sender.id !== chrome.runtime.id ||
      (sender.tab && !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`))) return false;
  if (!['getStatus', 'runNow', 'setEnabled', 'stop'].includes(message?.type)) return false;
  void ready.then(() => exclusive(async () => {
    if (message.type === 'getStatus') return response();
    if (message.type === 'runNow') return startRun('manual');
    if (message.type === 'stop') return stopRun();
    if (typeof message.enabled !== 'boolean') return response(false, '启用状态无效。');
    const data = await readState();
    if (message.enabled && data.job) return response(false, '请先完成或停止当前任务，再开启定时。');
    if (message.enabled && (!['claimed', 'already_owned'].includes(data.status.state)
        || !data.status.games.length
        || !data.status.games.every(game => ['claimed', 'already_owned'].includes(game.status)))) {
      return response(false, '请先手动领取并确认本轮全部游戏成功或已在库中，再开启定时。');
    }
    data.settings.enabled = message.enabled;
    const status = await syncSchedule(data.settings, data.status, true);
    await saveState({ settings: data.settings, status });
    return response();
  })).then(sendResponse).catch(() => sendResponse({ ok: false, error: '扩展状态保存失败，请重新打开扩展并检查浏览器。' }));
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => {
  void ready.then(async () => {
    if (alarm.name === DAILY_ALARM) {
      await exclusive(async () => {
        const data = await readState();
        if (!data.settings.enabled) return;
        // Always schedule the next Beijing evening, never repeat missed days.
        const status = await syncSchedule(data.settings, data.status, true);
        await saveState({ status });
        await startRun('scheduled');
      });
    } else if (alarm.name.startsWith(DEADLINE_PREFIX)) {
      const run = activeRun;
      if (run && alarm.name === `${DEADLINE_PREFIX}${run.runId}`) {
        await finishRun(run, 'failed', '本轮已达到 5 分钟上限，已停止并关闭领取页和定时。');
      }
    }
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(tabId => {
  void ready.then(() => exclusive(async () => {
    const data = await readState();
    if (data.job?.sessionId !== sessionId || data.job.tabId !== tabId) return;
    if (activeRun?.runId === data.job.runId) {
      activeRun.cancelled = true;
      clearTimeout(activeRun.timer);
      activeRun.abort?.abort();
      activeRun = null;
      await chrome.alarms.clear(`${DEADLINE_PREFIX}${data.job.runId}`);
      data.settings.enabled = false;
      data.status = { ...data.status, state: 'stopped', note: '领取页已关闭，本轮停止且定时已关闭。', running: false };
    }
    const status = await syncSchedule(data.settings, { ...data.status, tabId: null, updatedAt: new Date().toISOString() });
    await saveState({ settings: data.settings, status, job: null });
  })).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => { void ready.catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { void ready.catch(() => {}); });
