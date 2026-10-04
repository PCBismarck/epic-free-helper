import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const source = await readFile(new URL('./popup.js', import.meta.url), 'utf8');
const html = await readFile(new URL('./popup.html', import.meta.url), 'utf8');
const game = { title: 'Test game', url: 'https://store.epicgames.com/p/test-game', status: 'already_owned' };
const saved = { settings: { enabled: false }, job: null,
  status: { state: 'already_owned', games: [game], updatedAt: '2026-10-01T16:03:11Z' } };
const flush = () => new Promise(resolve => setImmediate(resolve));

function mount({ data = saved, read, command } = {}) {
  const { document, window } = parseHTML(html);
  const messages = [], reads = [];
  let changed, formatters = 0;
  const chrome = {
    storage: {
      local: { get(keys) { reads.push([...keys]); return read ? read() : Promise.resolve(structuredClone(data)); } },
      onChanged: { addListener(fn) { changed = fn; } },
    },
    runtime: { async sendMessage(message) {
      messages.push(message);
      if (command) return command(message);
      throw new Error('The background worker is unavailable');
    } },
  };
  vm.runInNewContext(source, { chrome, document, URL, Date,
    Intl: { DateTimeFormat: function(...args) { formatters++; return new Intl.DateTimeFormat(...args); } } });
  return {
    document, messages, reads, get formatters() { return formatters; },
    el: id => document.getElementById(id),
    change(update, area = 'local') { changed(update, area); },
    click(id) { document.getElementById(id).dispatchEvent(new window.Event('click')); },
    toggle(enabled) {
      const el = document.getElementById('enabled-toggle');el.checked = enabled;
      el.dispatchEvent(new window.Event('change'));
    },
  };
}

test('saved results open while the background is unavailable, without sending it any messages', async () => {
  const m = mount();await flush();
  assert.deepEqual(m.reads, [['settings', 'status', 'job']]);
  assert.equal(m.messages.length, 0);
  assert.equal(m.el('status-text').textContent, '本周游戏已在你的游戏库中');
  assert.equal(m.el('run-button').disabled, false);
  assert.equal(m.el('game-list').children.length, 1);
  assert.match(m.el('updated-at').textContent, /10.02.*00:03/);
});

test('an empty installation opens idle without waking the worker', async () => {
  const m = mount({ data: {} });await flush();
  assert.equal(m.messages.length, 0);
  assert.equal(m.el('status-text').textContent, '准备就绪，尚未开始领取');
  assert.equal(m.el('run-button').disabled, false);
  assert.equal(m.el('enabled-toggle').checked, false);
});

test('a delayed first storage read keeps commands disabled without falling back to a worker wake', async () => {
  let finish;
  const m = mount({ read: () => new Promise(resolve => { finish = resolve; }) });await flush();
  assert.equal(m.el('run-button').hasAttribute('disabled'), true);
  assert.equal(m.messages.length, 0);
  finish(structuredClone(saved));await flush();
  assert.equal(m.el('run-button').disabled, false);
  assert.equal(m.messages.length, 0);
});

test('storage failure leaves commands disabled and shows a readable error', async () => {
  const m = mount({ read: async () => { throw Error('storage failure'); } });await flush();
  assert.match(m.el('notice').textContent, /无法读取状态/);
  assert.equal(m.el('notice').hidden, false);
  assert.equal(m.el('run-button').disabled, true);
  assert.equal(m.el('enabled-toggle').disabled, true);
  assert.equal(m.messages.length, 0);
});

test('a newer task update received during the initial read cannot be overwritten by stale success', async () => {
  let finish;
  const m = mount({ read: () => new Promise(resolve => { finish = resolve; }) });
  const job = { phase: 'manual', games: [{ ...game, status: 'needs_attention', resumeStage: 'submitted' }] };
  m.change({ status: { newValue: { state: 'needs_attention', note: '请完成验证', games: job.games } },
    job: { newValue: job } });
  finish(structuredClone(saved));await flush();
  assert.match(m.el('status-text').textContent, /需要你处理/);
  assert.equal(m.el('status-note').textContent, '请完成验证');
  assert.equal(m.el('resume-button').hidden, false);
  assert.equal(m.el('resume-button').disabled, false);
  assert.equal(m.el('run-button').hidden, true);
  assert.equal(m.messages.length, 0);
});

test('removing a job during the initial read cannot restore an obsolete Continue button', async () => {
  let finish;
  const job = { phase: 'manual', games: [{ ...game, status: 'needs_attention', resumeStage: 'submitted' }] };
  const m = mount({ read: () => new Promise(resolve => { finish = resolve; }) });
  m.change({ job: {} });finish({ ...structuredClone(saved), job });await flush();
  assert.equal(m.el('resume-button').hidden, true);
  assert.equal(m.el('run-button').disabled, false);
});

test('live updates show a pause and completion without polling the worker', async () => {
  const m = mount();await flush();
  const job = { phase: 'manual', games: [{ ...game, status: 'needs_attention', resumeStage: 'checkout' }] };
  m.change({ status: { newValue: { state: 'needs_attention', games: job.games } }, job: { newValue: job } });
  assert.equal(m.el('resume-button').hidden, false);
  assert.equal(m.el('stop-button').disabled, false);
  m.change({ status: { newValue: saved.status }, job: { newValue: null } });
  assert.equal(m.el('resume-button').hidden, true);
  assert.equal(m.el('run-button').disabled, false);
  assert.equal(m.el('stop-button').disabled, true);
  assert.equal(m.messages.length, 0);
});

test('explicit Run, Continue, Stop and schedule changes still send commands for background validation', async () => {
  for (const [button, type] of [['run-button', 'runNow'], ['resume-button', 'resume'], ['stop-button', 'stop'], ['enabled-toggle', 'setEnabled']]) {
    const paused = { ...saved, status: { state: 'needs_attention', games: [game] },
      job: { phase: 'manual', games: [{ ...game, status: 'needs_attention', resumeStage: 'submitted' }] } };
    const data = ['resume', 'stop'].includes(type) ? paused : saved;
    const m = mount({ data, command: async () => ({ ok: true, ...structuredClone(data) }) });await flush();
    assert.equal(m.messages.length, 0);
    if (type === 'setEnabled') m.toggle(true);else m.click(button);
    await flush();
    assert.deepEqual(m.messages.map(message => message.type), [type]);
    if (type === 'setEnabled') assert.equal(m.messages[0].enabled, true);
  }
});

test('status-only updates preserve game links and reuse the date formatter', async () => {
  const m = mount();await flush();
  const item = m.el('game-list').firstElementChild;
  for (let i = 0; i < 3; i++) {
    m.change({ status: { newValue: { ...structuredClone(saved.status), note: `Progress ${i}` } } });
    assert.equal(m.el('game-list').firstElementChild, item);
  }
  assert.equal(m.formatters, 1);
  m.change({ status: { newValue: { state: 'failed', games: [{ ...game, status: 'failed', reason: 'Not confirmed' }] } } });
  assert.notEqual(m.el('game-list').firstElementChild, item);
  assert.match(m.el('game-list').textContent, /Not confirmed/);
});

test('stored titles remain text, links stay restricted to Epic and the result list stays bounded', async () => {
  const m = mount({ data: { ...saved, status: { state: 'failed', games: Array.from({ length: 100 }, () => ({
    title: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)', status: 'failed', reason: 'x'.repeat(1000),
  })) } } });await flush();
  assert.equal(m.el('game-list').children.length, 10);
  assert.equal(m.el('game-list').querySelector('img,a'), null);
  assert.match(m.el('game-list').textContent, /<img/);
  assert.equal(m.el('game-list').querySelector('.game-reason').textContent.length, 300);
});

test('an explicit command failure leaves saved results visible with an error message', async () => {
  const m = mount();await flush();m.click('run-button');await flush();
  assert.equal(m.messages.length, 1);
  assert.equal(m.el('game-list').children.length, 1);
  assert.match(m.el('notice').textContent, /暂时无法/);
  assert.equal(m.el('run-button').disabled, false);
});
