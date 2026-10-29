import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport } from '../src/engine.js';
import { readJson, atomicJson, acquireLock } from '../src/storage.js';
import { validateInput, validateState, tasksFor, parseRanking, allocate, requestFor, validateConfig, hash, iso } from '../src/model.js';
import { loadConnection, loadEnvironment } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/exchange.json', import.meta.url), 65536);
const simple = () => ({...structuredClone(example),items:structuredClone(example.items.slice(0,2))});
const twoItems=simple;
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-exchange-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const config={participants:CONFIG.participants.filter(person=>input.items.some(item=>item.ownerKey===person.key))};
  const api = mockApi(now,config);
  const options = { client: api.client, directory, input, config, token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.rankings.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later rankings; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'pen,book'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options = [{value:'yes',label:'Yes'}]; }, (q) => { q.text_input.max_length = 30; }, (q) => { q.text_input = null; },
    (q) => { q.data.task_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('misattributed, malformed or non-text answers never resolve a ranking', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = '1e2'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'pen,book'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.proposal, null);
    assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across participants', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), 'pen,book'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).observedStatus, 'expired'); assert.equal((await localReport(s.directory, s.options.input)).proposal, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'pen,book');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'pen,book'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'pen,book'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing participant before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'pen,book');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'pen,book'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).proposal, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});

const domain=example.items.map(item=>item.id);
const rows=values=>tasksFor(example).map((task,index)=>({ownerKey:task.id,ranking:values[index]}));
const permutations=list=>list.length===0?[[]]:list.flatMap((value,index)=>permutations(list.filter((_,i)=>i!==index)).map(rest=>[value,...rest]));

test('strict rankings require every exact item ID once; no omissions, ties, spaces, foreign IDs or normalization',()=>{
  for(const ranking of permutations(domain))assert.deepEqual(parseRanking(ranking.join(','),domain),{kind:'ranking',ranking});
  assert.deepEqual(parseRanking('Unknown',domain),{kind:'unknown',ranking:null});
  for(const value of ['book,pen','book,pen,pen','book,pen,other','book, pen,tray','book=pen,tray','Book,pen,tray',' book,pen,tray','book,pen,tray ','unknown','UNKNOWN','','Unknown,book',null,3])assert.throws(()=>parseRanking(value,domain));
});

test('top-trading cycles assigns a swap and a self keep in one canonical round',()=>{
  const result=allocate(example,rows([['pen','book','tray'],['book','pen','tray'],['tray','book','pen']]));
  assert.deepEqual(result.allocations.map(row=>[row.ownerKey,row.itemId,row.keepsOwn]),[['alex','pen',false],['blair','book',false],['casey','tray',true]]);
  assert.deepEqual(result.rounds.map(round=>round.cycles),[[['alex','blair'],['casey']]]);
  assert.equal(result.transfersExecuted,false);
});

test('sequential rounds remove original endowments before remaining owners choose again',()=>{
  const result=allocate(example,rows([['pen','tray','book'],['pen','book','tray'],['book','tray','pen']]));
  assert.deepEqual(result.rounds.map(round=>round.cycles),[[['blair']],[['alex','casey']]]);
  assert.deepEqual(result.rounds[1].remainingOwnerKeys,['alex','casey']);
  assert.deepEqual(result.rounds[1].pointers.map(row=>row.itemId),['tray','book']);
  assert.deepEqual(result.allocations.map(row=>row.itemId),['tray','pen','book']);
});

test('all owners can keep their declared item; there is no forced exchange',()=>{
  const result=allocate(example,rows([['book','pen','tray'],['pen','book','tray'],['tray','book','pen']]));
  assert.deepEqual(result.rounds[0].cycles,[['alex'],['blair'],['casey']]);
  assert.ok(result.allocations.every(row=>row.keepsOwn&&row.itemId===row.ownItemId));
});

// Independent oracle: positive-length reachability closure identifies cycle members.
function closureOracle(input,rankings) {
  const preferences=new Map(rankings.map(row=>[row.ownerKey,row.ranking]));
  const ownerOf=new Map(input.items.map(item=>[item.id,item.ownerKey]));
  let remaining=input.items.map(item=>item.ownerKey).sort();const assigned=new Map();
  while(remaining.length) {
    const chosen=remaining.map(owner=>preferences.get(owner).find(id=>remaining.includes(ownerOf.get(id))));
    const reach=remaining.map((_,i)=>remaining.map(owner=>ownerOf.get(chosen[i])===owner));
    for(let k=0;k<remaining.length;k++)for(let i=0;i<remaining.length;i++)for(let j=0;j<remaining.length;j++)reach[i][j] ||= reach[i][k]&&reach[k][j];
    remaining.forEach((owner,i)=>{if(reach[i][i])assigned.set(owner,chosen[i]);});
    remaining=remaining.filter(owner=>!assigned.has(owner));
  }
  return [...assigned].sort(([a],[b])=>a<b?-1:1);
}

test('all 216 three-owner strict preference profiles match independent cycle oracle and conservation invariants',()=>{
  const orders=permutations(domain);let count=0;
  for(const a of orders)for(const b of orders)for(const c of orders) {
    const rankings=rows([a,b,c]),before=JSON.stringify(rankings),result=allocate(example,rankings);
    assert.deepEqual(result.allocations.map(row=>[row.ownerKey,row.itemId]),closureOracle(example,rankings));
    assert.deepEqual(result.allocations.map(row=>row.ownerKey),['alex','blair','casey']);
    assert.deepEqual(result.allocations.map(row=>row.itemId).sort(),domain);
    for(const row of result.allocations){const ranking=rankings.find(r=>r.ownerKey===row.ownerKey).ranking;assert.ok(ranking.indexOf(row.itemId)<=ranking.indexOf(row.ownItemId));}
    assert.deepEqual(result,allocate({...example,items:[...example.items].reverse()},[...rankings].reverse()));
    assert.equal(JSON.stringify(rankings),before);count++;
  }
  assert.equal(count,216);
});

test('input and config enforce exactly one declared item for each unique identified owner',()=>{
  for(const mutate of [v=>v.items.pop(),v=>v.items.push({...v.items[0]}),v=>v.items[0].ownerKey=v.items[1].ownerKey,
    v=>v.items[0].id='toolongid',v=>v.items[0].id='Unknown',v=>v.items[0].label='x'.repeat(31),v=>v.items[0].extra=true]){
    const input=simple();mutate(input);assert.throws(()=>validateInput(input));
  }
  for(const mutate of [c=>c.participants.pop(),c=>c.participants[0].id=c.participants[1].id,c=>c.participants[0].key='outside',c=>c.participants[0].id=c.participants[0].id.toUpperCase().replace('11111111','AAAAAAAA'),c=>c.participants[0].label='']){
    const config=structuredClone(CONFIG);mutate(config);assert.throws(()=>validateConfig(config,example));
  }
  assert.deepEqual(validateConfig({...CONFIG,participants:[...CONFIG.participants].reverse()},example),CONFIG);
  const valid=rows([domain,domain,domain]);
  for(const value of [valid.slice(1),[valid[0],valid[0],valid[2]],valid.map((r,i)=>i===0?{...r,ranking:['Unknown']}:r),valid.map((r,i)=>i===0?{...r,ranking:['book,pen','tray']}:r)])assert.throws(()=>allocate(example,value));
});

test('maximum five participants fit prompt and normalized ranking bounds and send exactly five targeted Questions',async t=>{
  const input={exchangeId:'boundary',title:'T'.repeat(60),items:Array.from({length:5},(_,i)=>({id:`item000${i}`,label:'L'.repeat(30),ownerKey:`owner00${i}`}))};
  const config={participants:input.items.map((item,i)=>({key:item.ownerKey,id:id(100+i),label:'P'.repeat(30)}))};
  const itemIds=input.items.map(item=>item.id),text=itemIds.join(',');assert.equal(text.length,44);assert.equal(parseRanking(text,itemIds).ranking.length,5);
  for(const task of tasksFor(input)){
    const request=requestFor(input,config,task.id,id(200));assert.ok(request.prompt.length<=500);assert.equal(request.context.length,39);
    assert.ok(request.prompt.includes(`Declared own: ${task.ownItemId}`));for(const item of input.items)assert.ok(request.prompt.includes(`${item.id}=${item.label}`));
  }
  const s=await setup(t);const api=mockApi(s.options.now,config);const options={...s.options,input,config,client:api.client};let result;
  for(const task of tasksFor(input)){
    result=await step(options);const pending=result.rankings.find(row=>row.status==='pending');assert.equal(pending.ownerKey,task.id);
    const q=api.questions.get(pending.questionId);assert.equal(q.target_user_id,config.participants.find(person=>person.key===task.id).id);
    api.answer(q.id,text);result=await step(options);
  }
  assert.equal(result.status,'complete');assert.equal(sends(api),5);await step(options);assert.equal(sends(api),5);
});

test('Unknown and malformed rankings withhold the entire proposal while preserving valid evidence from other people',async t=>{
  for(const bad of ['Unknown','book,book','book','pen, book','unknown']){
    const s=await setup(t),result=await decide(s,[bad,'book,pen']);assert.equal(result.status,'incomplete');assert.equal(result.proposal,null);
    assert.equal(result.rankings[0].kind,bad==='Unknown'?'unknown':null);assert.deepEqual(result.rankings[1].ranking,['book','pen']);
    assert.equal(result.rankings[1].responderId,OTHER);assert.equal(result.rankings[1].askerId,ASKER);assert.equal(sends(s.api),2);
  }
});

test('changing immutable manifest, participant mapping, credential or room fails before any network call',async t=>{
  const s=await setup(t);await s.run();const before=s.api.calls.length;
  for(const extra of [{input:{...s.options.input,title:'Changed'}},{config:{participants:[...s.options.config.participants].map((p,i)=>i===0?{...p,label:'Other'}:p)}},{token:'changed'},{room:'OTHER1234567'}])await assert.rejects(s.run(extra));
  assert.equal(s.api.calls.length,before);
  const reordered={...s.options.input,items:[...s.options.input.items].reverse()};assert.equal((await s.run({input:reordered,config:{participants:[...s.options.config.participants].reverse()}})).status,'pending');
});

test('removing any participant from the room stops the next send, even after earlier answers',async t=>{
  const s=await setup(t);await s.run();s.api.answer(id(1),'pen,book');await s.run();s.api.rooms[0].members.pop();
  await assert.rejects(s.run(),/every named participant/);assert.equal(sends(s.api),1);
  const mismatch=await setup(t);const bad=structuredClone(mismatch.options.config);bad.participants[0].key='outside';
  await assert.rejects(mismatch.run({config:bad}),/exactly cover/);assert.equal(mismatch.api.calls.length,0);
});

test('monotonic observations and later creation intents reject clock regression on live reads and replay',async t=>{
  const s=await setup(t);await s.run();s.clock.value='2026-01-01T09:00:02.000Z';await s.run();
  s.clock.value='2026-01-01T09:00:01.000Z';await assert.rejects(s.run(),/regressed/);
  s.clock.value='2026-01-01T09:00:03.000Z';s.api.answer(id(1),'pen,book');await s.run();
  s.clock.value='2026-01-01T09:00:02.000Z';await assert.rejects(s.run(),/saved ranking request/);assert.equal(sends(s.api),1);
  const saved=await s.saved();saved.attempts[0].observation.checkedAt='2026-01-01T08:59:59.000Z';assert.throws(()=>validateState(saved,s.options.input),/predates/);
});

test('a three-owner cycle rotates to the smallest key and preserves pointer direction',()=>{
  const result=allocate(example,rows([['pen','book','tray'],['tray','pen','book'],['book','tray','pen']]));
  assert.deepEqual(result.rounds[0].cycles,[['alex','blair','casey']]);
  assert.deepEqual(result.allocations.map(row=>row.itemId),['pen','tray','book']);
});
