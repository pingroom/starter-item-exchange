import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const key = value => word(value) && value.length <= 8 && !['prototype','__proto__'].includes(value);
export function validateInput(input) {
  if (!keys(input,['exchangeId','title','items']) || !word(input.exchangeId) || !line(input.title,60)
    || !Array.isArray(input.items) || input.items.length < 2 || input.items.length > 5) throw new Error('Provide an exchange ID, title and two to five declared items.');
  const ids = new Set(), owners = new Set();
  for (const item of input.items) {
    if (!keys(item,['id','label','ownerKey']) || !key(item.id) || !key(item.ownerKey) || !line(item.label,30)
      || ids.has(item.id) || owners.has(item.ownerKey)) throw new Error('Each item needs a unique short ID, label and unique owner key; exactly one item per owner.');
    ids.add(item.id); owners.add(item.ownerKey);
  }
  return {...structuredClone(input),items:structuredClone(input.items).sort((a,b)=>compare(a.id,b.id))};
}
export function validateConfig(config,rawInput) {
  if (!keys(config,['participants']) || !Array.isArray(config.participants) || config.participants.length < 2 || config.participants.length > 5) throw new Error('Config requires two to five named participants.');
  const ids = new Set(), ownerKeys = new Set();
  for (const person of config.participants) {
    if (!keys(person,['key','id','label']) || !key(person.key) || !isId(person.id) || !line(person.label,30)
      || ids.has(person.id) || ownerKeys.has(person.key)) throw new Error('Participants need unique short keys, exact unique UUIDs and labels.');
    ids.add(person.id); ownerKeys.add(person.key);
  }
  if (rawInput !== undefined) {
    const input = validateInput(rawInput);
    if (ownerKeys.size !== input.items.length || input.items.some(item=>!ownerKeys.has(item.ownerKey))) throw new Error('Participants must exactly cover every declared item owner.');
  }
  return {participants:structuredClone(config.participants).sort((a,b)=>compare(a.key,b.key))};
}
export function tasksFor(raw) {
  return validateInput(raw).items.map(item=>({id:item.ownerKey,ownItemId:item.id})).sort((a,b)=>compare(a.id,b.id));
}
export function parseRanking(text,itemIds) {
  if (text === 'Unknown') return {kind:'unknown',ranking:null};
  if (!Array.isArray(itemIds) || itemIds.length < 2 || itemIds.length > 5 || new Set(itemIds).size !== itemIds.length || itemIds.some(id=>!key(id))) throw new Error('Invalid item domain.');
  if (typeof text !== 'string' || text.length > 44) throw new Error('Answer with every item ID once, comma separated, or exactly Unknown.');
  const ranking=text.split(',');
  if (ranking.length !== itemIds.length || new Set(ranking).size !== itemIds.length || ranking.some(id=>!itemIds.includes(id))) throw new Error('Answer with every item ID once, comma separated without spaces, or exactly Unknown.');
  return {kind:'ranking',ranking};
}
export function requestFor(rawInput,rawConfig,taskId,attemptId) {
  const input=validateInput(rawInput),config=validateConfig(rawConfig,input),task=tasksFor(input).find(item=>item.id===taskId);
  if (!task || !isId(attemptId)) throw new Error('Invalid participant or attempt.');
  const person=config.participants.find(person=>person.key===task.id), own=input.items.find(item=>item.id===task.ownItemId);
  const prompt=`${input.title}\nItems: ${input.items.map(item=>`${item.id}=${item.label}`).join('; ')}\nDeclared own: ${own.id}.\nRank ALL item IDs best to worst, once each, comma separated with no spaces or ties. Or type Unknown. Ranking is not permission to transfer; room history is visible.`;
  if (prompt.length>500) throw new Error('Ranking prompt exceeds 500 characters.');
  const key=`exchange-${attemptId}`;
  return {prompt,context:`To ${person.id}`,text_input:{placeholder:'All IDs in order, or Unknown',max_length:60},
    responder_scope:'direct',target_user_id:person.id,ttl:TTL,correlation_id:key,
    data:{input_hash:hash(input),task_id:taskId,item_ids:input.items.map(item=>item.id),attempt_id:attemptId},idempotencyKey:key};
}
export function validateState(state,rawInput) {
  const input=validateInput(rawInput), tasks=tasksFor(input);
  if (!keys(state,['version','inputHash','config','room','credentialHash','startedAt','attempts']) || state.version!==1
    || state.inputHash!==hash(input) || typeof state.room!=='string' || !ROOM.test(state.room)
    || typeof state.credentialHash!=='string' || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length>tasks.length || iso(state.startedAt)!==state.startedAt) throw new Error('Invalid state or changed exchange manifest. Restore the original inputs.');
  validateConfig(state.config,input);
  const ids=new Set(),questionIds=new Set();let previous=state.startedAt,askerId;
  for (const [index,attempt] of state.attempts.entries()) {
    if (!keys(attempt,['id','taskId','createdAt','request','questionId','status','observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.taskId!==tasks[index].id || iso(attempt.createdAt)!==attempt.createdAt || attempt.createdAt<previous
      || hash(attempt.request)!==hash(requestFor(input,state.config,attempt.taskId,attempt.id))
      || !['creating','pending','answered','expired','cancelled','invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved ranking request.');
    ids.add(attempt.id);previous=attempt.createdAt;
    if (attempt.status==='creating') {
      if (attempt.questionId!==null || attempt.observation!==null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);validateObservation(attempt.observation,attempt.status,attempt.request);
      if (Date.parse(attempt.observation.createdAt)<Date.parse(attempt.createdAt)-CLOCK_SKEW_MS || attempt.observation.checkedAt<attempt.createdAt) throw new Error('Observation predates creation intent.');
      previous=attempt.observation.checkedAt;
      if (askerId!==undefined && attempt.observation.askerId!==askerId) throw new Error('Questions belong to different asking registrations.');
      askerId=attempt.observation.askerId;
    }
    if (['creating','pending'].includes(attempt.status) && index!==state.attempts.length-1) throw new Error('Only the last task may have an active Question.');
  }
  return state;
}
/** Pure allocation of declared rankings. Use report() to validate saved Question evidence. */
export function allocate(rawInput,rawRankings) {
  const input=validateInput(rawInput),tasks=tasksFor(input),itemIds=input.items.map(item=>item.id);
  if (!Array.isArray(rawRankings) || rawRankings.length !== tasks.length) throw new Error('Every owner needs one complete ranking.');
  const rankings=new Map();
  for (const row of rawRankings) {
    if (!keys(row,['ownerKey','ranking']) || !tasks.some(task=>task.id===row.ownerKey) || rankings.has(row.ownerKey)
      || !Array.isArray(row.ranking) || row.ranking.some(value=>typeof value!=='string')) throw new Error('Invalid or duplicate owner ranking.');
    const parsed=parseRanking(row.ranking.join(','),itemIds);
    if (parsed.kind!=='ranking' || hash(parsed.ranking)!==hash(row.ranking)) throw new Error('Every owner needs a strict ranking.');
    rankings.set(row.ownerKey,parsed.ranking);
  }
  const originalOwner=new Map(input.items.map(item=>[item.id,item.ownerKey]));
  const endowed=new Map(input.items.map(item=>[item.ownerKey,item.id]));
  const remaining=new Set(tasks.map(task=>task.id)),allocations=[],rounds=[];
  while (remaining.size) {
    const owners=[...remaining].sort(compare);
    const choices=new Map(owners.map(owner=>[owner,rankings.get(owner).find(item=>remaining.has(originalOwner.get(item)))]));
    const points=new Map(owners.map(owner=>[owner,originalOwner.get(choices.get(owner))]));
    const seen=new Set(),cycles=[];
    for (const start of owners) {
      if (seen.has(start)) continue;
      const path=[],indices=new Map(); let cursor=start;
      while (!seen.has(cursor) && !indices.has(cursor)) { indices.set(cursor,path.length);path.push(cursor);cursor=points.get(cursor); }
      if (indices.has(cursor)) {
        const cycle=path.slice(indices.get(cursor)), smallest=[...cycle].sort(compare)[0],offset=cycle.indexOf(smallest);
        cycles.push([...cycle.slice(offset),...cycle.slice(0,offset)]);
      }
      for (const owner of path) seen.add(owner);
    }
    cycles.sort((a,b)=>compare(a[0],b[0]));
    if (!cycles.length) throw new Error('Allocation failed to make progress.');
    const assignments=cycles.flatMap(cycle=>cycle.map(owner=>({ownerKey:owner,fromOwnerKey:originalOwner.get(choices.get(owner)),
      ownItemId:endowed.get(owner),itemId:choices.get(owner),keepsOwn:choices.get(owner)===endowed.get(owner)})));
    rounds.push({round:rounds.length+1,remainingOwnerKeys:owners,pointers:owners.map(owner=>({ownerKey:owner,itemId:choices.get(owner),toOwnerKey:points.get(owner)})),cycles,assignments});
    allocations.push(...assignments);
    for (const row of assignments) remaining.delete(row.ownerKey);
  }
  allocations.sort((a,b)=>compare(a.ownerKey,b.ownerKey));
  if (new Set(allocations.map(row=>row.ownerKey)).size!==tasks.length || new Set(allocations.map(row=>row.itemId)).size!==input.items.length
    || allocations.some(row=>rankings.get(row.ownerKey).indexOf(row.itemId)>rankings.get(row.ownerKey).indexOf(row.ownItemId))) throw new Error('Allocation invariants failed.');
  return {allocations,rounds,transfersExecuted:false};
}
export function report(state,rawInput) {
  const input=validateInput(rawInput);validateState(state,input);
  const rankings=tasksFor(input).map(task=>{
    const attempt=state.attempts.find(item=>item.taskId===task.id),answer=attempt?.observation?.answer;
    return {ownerKey:task.id,ownItemId:task.ownItemId,status:attempt?.status==='creating'?'create_unknown':attempt?.status??'unasked',
      text:answer?.text??null,ranking:answer?.ranking??null,kind:answer?.kind??null,questionId:attempt?.questionId??null,attemptId:attempt?.id??null,
      responderId:answer?.responderId??null,answeredAt:answer?.answeredAt??null,askerId:attempt?.observation?.askerId??null,observedAt:attempt?.observation?.checkedAt??null};
  });
  const known=rankings.every(row=>row.kind==='ranking'),active=rankings.find(row=>['create_unknown','pending'].includes(row.status));
  const status=active?.status??(rankings.some(row=>row.status==='unasked')?'ready':known?'complete':'incomplete');
  return {exchangeId:input.exchangeId,title:input.title,inputHash:hash(input),status,participants:state.config.participants,rankings,
    unknownOwnerKeys:rankings.filter(row=>row.kind==='unknown').map(row=>row.ownerKey),
    proposal:known?allocate(input,rankings.map(({ownerKey,ranking})=>({ownerKey,ranking}))):null,transfersExecuted:false};
}
function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['text', 'kind', 'ranking', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || hash(parseRanking(answer.text,request.data.item_ids)) !== hash({ kind: answer.kind, ranking: answer.ranking })
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved ranking evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered tasks must not contain ranking evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || hash(q.text_input) !== hash(request.text_input) || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== 0) throw new Error('Question does not match the saved task, room, or participant.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.value !== null || answer.label !== null || answer.responder?.id !== request.target_user_id || typeof answer.text !== 'string' || answer.text.length > 60) throw new Error('Invalid text answer.');
      observation.answer = { text: answer.text, ...parseRanking(answer.text,request.data.item_ids), responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms,room,participantIds) {
  if (!Array.isArray(rooms)||rooms.length>1000) throw new Error('Invalid room inventory.');
  const matches=rooms.filter(item=>item?.invite_code===room),selected=matches[0];
  if (matches.length!==1 || selected.type!=='standard' || selected.is_public!==false || !Array.isArray(selected.members)
    || selected.members.length>1000 || participantIds.some(id=>!selected.members.some(member=>member?.user_id===id))) throw new Error('Use a granted standard private room containing every named participant.');
}
