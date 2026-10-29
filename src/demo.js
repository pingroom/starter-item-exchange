import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { readJson } from './storage.js';
import { step } from './engine.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const input=await readJson(new URL('../examples/exchange.json',import.meta.url));
for(const [scenario,rankings,expected] of [
  ['Alex and Blair swap; Casey keeps the tray',['pen,book,tray','book,pen,tray','tray,book,pen'],'complete'],
  ['Everyone keeps their declared item',['book,pen,tray','pen,book,tray','tray,book,pen'],'complete'],
  ['Unknown ranking withholds the allocation',['Unknown','book,pen,tray','tray,book,pen'],'incomplete'],
]) {
  const directory=await mkdtemp(join(tmpdir(),'pingroom-exchange-demo-'));
  try {
    const now=()=>'2026-01-01T09:00:00.000Z',api=mockApi(now);
    const options={client:api.client,directory,input,config:CONFIG,token:'offline-fixture-token',room:ROOM_CODE,now};let result;
    for(const ranking of rankings){result=await step(options);api.answer(result.rankings.find(row=>row.status==='pending').questionId,ranking);result=await step(options);}
    assert.equal(result.status,expected);assert.equal(api.calls.filter(call=>call.method==='POST').length,3);
    assert.equal(result.transfersExecuted,false);
    console.log(JSON.stringify({scenario,status:result.status,proposal:result.proposal,unknownOwnerKeys:result.unknownOwnerKeys,transfersExecuted:result.transfersExecuted},null,2));
  } finally { await rm(directory,{recursive:true,force:true}); }
}
console.log('Offline demo used the pinned SDK with a local mock transport. No phone delivery or item transfers.');
