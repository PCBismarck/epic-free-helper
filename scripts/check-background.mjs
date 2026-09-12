import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as rules from '../browser-extension/rules.js';
const source = (await fs.readFile(new URL('../browser-extension/background.js', import.meta.url),'utf8')).replace(/^import .*;\n/gm, '') + '\nglobalThis.internals = {ready, nextBeijingRun, getRun: () => activeRun};';
const game = {title:'Test game',url:'https://store.epicgames.com/p/test-game',id:'test',namespace:'test',start:'2026-09-10T00:00:00Z',end:'2026-09-17T00:00:00Z'};
const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function make({data={},session='browser-a',engine=async()=>({status:'claimed'}),games=[game],fetcher}={}) {
 const local=clone(data), tabs=new Map(), alarms=new Map(), removed=[], created=[], timers=new Map(); let nextTab=100,nextTimer=0;
 const callbacks={};
 const evt=name=>({addListener(fn){callbacks[name]=fn;}});
 const storage=(data)=>({async get(keys){return Object.fromEntries((typeof keys==='string'?[keys]:keys).filter(k=>k in data).map(k=>[k,clone(data[k])]));}, async set(changes){Object.assign(data,clone(changes));}});
 const chrome={runtime:{id:'extension',onMessage:evt('message'),onStartup:evt('startup'),onInstalled:evt('install')},storage:{local:storage(local),session:storage(session?{epicSessionId:session}:{})},alarms:{async create(name,opts){alarms.set(name,{name,scheduledTime:opts.when});},async get(name){return alarms.get(name);},async clear(name){return alarms.delete(name);},onAlarm:evt('alarm')},tabs:{async create(opts){const tab={id:nextTab++,...opts};tabs.set(tab.id,tab);created.push(tab);return tab;},async get(id){if(!tabs.has(id))throw Error('missing tab');return tabs.get(id);},async remove(id){removed.push(id);tabs.delete(id);callbacks.removed?.(id);},onRemoved:evt('removed')}};
 const context={...rules,selectWeeklyPcGames:()=>clone(games),chrome,crypto:{randomUUID},Date,URL,AbortController,console,fetch:fetcher|| (async()=>({ok:true,json:async()=>({})})),claimGame:engine,setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}};
 vm.runInNewContext(source,context); await context.internals.ready;
 async function message(type,extra={}){return new Promise(resolve=>{assert.equal(callbacks.message({type,...extra},{id:'extension'},resolve),true);});}
 async function settle(){for(let i=0;i<15;i++)await tick();}
 return {local,tabs,created,removed,alarms,timers,callbacks,message,settle,context};
}
let count=0;
async function test(name,fn){await fn();console.log(`ok ${++count}: ${name}`);}
await test('fresh install is idle with schedule off and cannot enable before success',async()=>{const m=await make();assert.equal(m.local.settings.enabled,false);assert.equal(m.alarms.size,0);assert.equal((await m.message('setEnabled',{enabled:true})).ok,false);assert.equal(m.created.length,0);});
await test('successful manual run opens and closes exactly its own one tab then enables Beijing schedule',async()=>{const m=await make();m.tabs.set(9,{id:9,url:'https://example.com'});await m.message('runNow');await m.settle();assert.equal(m.local.status.state,'claimed');assert.equal(m.created.length,1);assert.deepEqual(m.removed,[100]);assert.ok(m.tabs.has(9));assert.equal(m.local.job,null);assert.equal((await m.message('setEnabled',{enabled:true})).ok,true);const when=new Date(m.alarms.get('epic-daily').scheduledTime);assert.equal(when.getUTCHours(),15);assert.equal(when.getUTCMinutes(),35);});
await test('verification keeps exactly one tracked tab, disables schedule and rejects another run',async()=>{const m=await make({engine:async()=>({status:'needs_attention',reason:'security_check'})});await m.message('runNow');await m.settle();assert.equal(m.local.job.phase,'manual');assert.equal(m.local.settings.enabled,false);assert.equal(m.created.length,1);assert.deepEqual(m.removed,[]);assert.equal((await m.message('runNow')).ok,false);await m.message('stop');assert.deepEqual(m.removed,[100]);assert.equal(m.local.job,null);});
await test('closing retained tab clears ownership and allows manual run',async()=>{const m=await make({engine:async()=>({status:'needs_login'})});await m.message('runNow');await m.settle();m.tabs.delete(100);m.callbacks.removed(100);await m.settle();assert.equal(m.local.job,null);assert.equal((await m.message('runNow')).ok,true);await m.settle();assert.equal(m.created.length,2);});
await test('concurrent requests open only one tab; stop cancels in-flight engine results',async()=>{let finish;const m=await make({engine:()=>new Promise(resolve=>{finish=resolve;})});const outcomes=await Promise.all([m.message('runNow'),m.message('runNow')]);await m.settle();assert.equal(outcomes.filter(x=>x.ok).length,1);assert.equal(m.created.length,1);await m.message('stop');finish({status:'claimed'});await m.settle();assert.equal(m.local.status.state,'stopped');assert.equal(m.local.job,null);assert.deepEqual(m.removed,[100]);});
await test('deadline alarm stops the current job and stale alarm cannot affect later state',async()=>{const m=await make({engine:()=>new Promise(()=>{})});await m.message('runNow');await m.settle();const alarm=[...m.alarms.values()].find(x=>x.name.startsWith('epic-deadline-'));m.callbacks.alarm(alarm);await m.settle();assert.equal(m.local.status.state,'failed');assert.equal(m.local.settings.enabled,false);assert.equal(m.local.job,null);assert.deepEqual(m.removed,[100]);m.callbacks.alarm(alarm);await m.settle();assert.equal(m.local.status.state,'failed');});
await test('empty or oversized discovery never reports success or opens a tab',async()=>{for(const games of [[],Array.from({length:11},(_,i)=>({...game,id:String(i)}))]){const m=await make({games});await m.message('runNow');await m.settle();assert.ok(['no_free_games','failed'].includes(m.local.status.state));assert.equal(m.created.length,0);assert.equal(m.local.settings.enabled,false);assert.equal((await m.message('setEnabled',{enabled:true})).ok,false);}});
await test('same-session service worker restart cleans interrupted job without resubmission',async()=>{const m=await make({data:{settings:{enabled:true},status:{state:'running',running:true,games:[{...game,status:'pending'}]},job:{runId:'old',sessionId:'browser-a',tabId:4,phase:'running'}}});assert.equal(m.local.status.state,'interrupted');assert.equal(m.local.settings.enabled,false);assert.equal(m.local.job,null);assert.deepEqual(m.removed,[4]);assert.equal(m.created.length,0);});
await test('cross-session IDs are never closed; detached job blocks until explicit stop',async()=>{const m=await make({session:'browser-b',data:{settings:{enabled:true},status:{state:'running',running:true,games:[]},job:{runId:'old',sessionId:'browser-a',tabId:4,phase:'running'}}});assert.deepEqual(m.removed,[]);assert.equal(m.local.job.phase,'detached');assert.equal((await m.message('runNow')).ok,false);await m.message('stop');assert.equal(m.local.job,null);assert.deepEqual(m.removed,[]);});
await test('scheduled run advances one fixed Beijing day without catch-up loops',async()=>{const m=await make({data:{settings:{enabled:true,hour:23,minute:35},status:{state:'already_owned',games:[{...game,status:'already_owned'}]}}});m.callbacks.alarm({name:'epic-daily',scheduledTime:1});await m.settle();assert.equal(m.created.length,1);assert.equal(m.local.status.state,'claimed');assert.equal(m.alarms.get('epic-daily').scheduledTime> Date.now(),true);});
await test('content-script messages cannot start claims',async()=>{const m=await make();assert.equal(m.callbacks.message({type:'runNow'},{id:'extension',tab:{id:9}},()=>{}),false);assert.equal(m.created.length,0);});
await test('stop during a late promotions response preserves stopped state and opens no tab',async()=>{let reply;const m=await make({fetcher:()=>new Promise(resolve=>{reply=resolve;})});await m.message('runNow');await m.settle();await m.message('stop');reply({ok:true,json:async()=>({})});await m.settle();assert.equal(m.local.status.state,'stopped');assert.equal(m.local.job,null);assert.equal(m.created.length,0);});
await test('partial success followed by failure preserves all results and disables schedule',async()=>{let calls=0;const m=await make({games:[game,{...game,title:'Second game',url:'https://store.epicgames.com/p/second-game'}],engine:async()=>({status:++calls===1?'claimed':'failed',reason:'test_failure'})});await m.message('runNow');await m.settle();assert.equal(m.local.status.state,'failed');assert.deepEqual(m.local.status.games.map(x=>x.status),['claimed','failed']);assert.equal(m.local.settings.enabled,false);assert.equal(m.created.length,1);assert.deepEqual(m.removed,[100]);assert.equal((await m.message('setEnabled',{enabled:true})).ok,false);});
await test('already-owned is persisted as skipped while the next game is checked in the same tab',async()=>{
 let finishSecond;const seen=[];
 const m=await make({games:[game,{...game,title:'Second game',url:'https://store.epicgames.com/p/second-game'}],engine:async(tabId,current)=>{
  seen.push({tabId,title:current.title});
  return seen.length===1?{status:'already_owned'}:new Promise(resolve=>{finishSecond=resolve;});
 }});
 await m.message('runNow');await m.settle();
 assert.equal(seen.length,2);assert.equal(m.created.length,1);
 assert.equal(seen[0].tabId,seen[1].tabId);
 assert.equal(m.local.status.games[0].status,'already_owned');
 assert.match(m.local.status.games[0].reason,/已跳过领取/);
 assert.equal(m.local.status.state,'running');
 finishSecond({status:'already_owned'});await m.settle();
 assert.equal(m.local.status.state,'already_owned');
 assert.deepEqual(m.local.status.games.map(item=>item.status),['already_owned','already_owned']);
 assert.equal(m.local.job,null);assert.equal(m.local.settings.enabled,false);
});
console.log(`Passed ${count} mocked lifecycle checks; no browser was launched.`);
