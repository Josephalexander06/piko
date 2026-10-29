const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { test } = require('node:test');
const createLoader = require('./helpers/load-typescript.cjs');
const root = path.resolve(__dirname, '../apps/extension/src');
const cases = require('./fixtures/interpretation-cases.json').filter(c => c.kind !== 'fault');
const origin = `chrome-extension://${'a'.repeat(32)}`;
const token = 'T'.repeat(43);
const { isInterpretResponse, isInterpretMessage, eligibleMetadata } = createLoader()(path.join(root, 'features/interpretation/interpretation.validation.ts'));
function responseFor(c) {
  const updates = c.expectedUpdates.map(update => ({ ...structuredClone(update), evidence: { source: c.request.knownFacts.length ? 'fact' : 'transcript', factId: c.request.knownFacts[0]?.factId ?? null, quote: c.request.knownFacts[0]?.text ?? c.request.transcript } }));
  return { scanId: c.request.scanId, updates, clarifications: c.expectedClarificationFields.map(id => ({ question: 'Please clarify.', targetFieldIds: [id] })), missingFields: c.request.fields.filter(f => f.required && !updates.some(u => u.fieldId === f.fieldId)).map(f => ({ fieldId: f.fieldId, question: `What should I enter for ${f.label}?` })) };
}
test('generated TS runtime schemas validate all 40 synthetic response shapes and exact message properties', () => {
  for (const c of cases) {
    assert.equal(isInterpretResponse(responseFor(c), c.request), true, c.id);
    const message = { type: 'PIKO_INTERPRET', requestId: `request_${'a'.repeat(32)}`, tabId: 7, payload: c.request };
    assert.equal(isInterpretMessage(message), true);
    for (const extra of [{ model: 'cloud' }, { url: 'https://remote.test' }, { token }, { authorized: true }]) assert.equal(isInterpretMessage({ ...message, ...extra }), false);
  }
});
test('response validation rejects mismatched scan, unknown IDs, wrong target kind/options, duplicates and forged evidence', () => {
  const c = cases[0];
  for (const change of [r => {r.scanId = `scan_${'f'.repeat(32)}`;}, r => {r.updates[0].fieldId = `field_${'f'.repeat(32)}`;}, r => {r.updates.push(structuredClone(r.updates[0]));}, r => {r.updates[0].target = { kind: 'checkbox', checked: true };}, r => {r.updates[0].evidence.quote = 'invented';}, r => {r.updates[0].evidence.factId = `fact_${'f'.repeat(32)}`;}, r => {r.updates[0].approved = true;}, r => {r.missingFields.push({fieldId: c.request.fields[0].fieldId,question:'forged'});}, r => {r.updates[0].target.value = 'Invented Person';}]) {
    const r = responseFor(c); change(r); assert.equal(isInterpretResponse(r,c.request),false);
  }
  const optionCase = cases[10]; const r = responseFor(optionCase); r.updates[0].target.optionId = `option_${'f'.repeat(32)}`;
  assert.equal(isInterpretResponse(r,optionCase.request),false);
});
test('metadata preparation drops ineligible fields and disabled options without exposing page state or unrelated metadata', () => {
  const c = cases[10];
  const field = { ...c.request.fields[0], fieldType: 'select', eligible: true, currentValue: 'PRIVATE', selector: 'input', options: [...c.request.fields[0].options.map(o=>({...o,disabled:false})), {optionId:`option_${'f'.repeat(32)}`,label:'Disabled',disabled:true}] };
  const metadata = eligibleMetadata([field,{...field,eligible:false,fieldId:`field_${'f'.repeat(32)}`}]);
  assert.deepEqual(metadata,c.request.fields); assert.equal(JSON.stringify(metadata).includes('PRIVATE'),false);
});
function setup() {
  const key = 'piko.localService.session.v1';
  const data = { [key]: { token, origin, expiresAt: Date.now()+100000, pendingRevocation: false } };
  const calls = [];
  let http = async () => new Response(JSON.stringify(responseFor(cases[0])),{headers:{'Content-Type':'application/json'}});
  const chrome = { runtime:{getURL:suffix=>`${origin}/${suffix}`},storage:{session:{get:async()=>structuredClone(data),setAccessLevel:async()=>{},remove:async k=>{delete data[k];}}} };
  const { ConnectionManager } = createLoader({chrome})(path.join(root,'background/connection-manager.ts'));
  const manager = new ConnectionManager(async (url, options)=>{calls.push({url,options});return http(url,options);});
  return { manager, data, key, calls, setHttp:fn=>{http=fn;} };
}
test('interpret uses authenticated companion only, bounds/parses response and never stores personal values', async () => {
  const s = setup(); const original = structuredClone(s.data);
  const result = await s.manager.interpret(cases[0].request,new AbortController().signal);
  assert.equal(isInterpretResponse(result,cases[0].request),true);
  assert.deepEqual(s.data, original);
  assert.equal(s.calls[0].url,'http://127.0.0.1:8765/v1/interpret');
  assert.equal(s.calls[0].options.headers.Authorization,`Bearer ${token}`);
  assert.equal(s.calls[0].options.redirect,'error'); assert.equal(s.calls[0].options.credentials,'omit');
  assert.deepEqual(JSON.parse(s.calls[0].options.body),cases[0].request);
  assert.equal(s.calls.some(c=>c.url.includes('11434')),false);
});
test('interpret rejects revoked sessions, malformed output and upstream diagnostics; errors do not expose content', async () => {
  for (const [body,status,code] of [[{error:'PRIVATE raw model output'},502,'invalid-response'],[{error:'interpretation-timeout'},504,'interpretation-timeout'],[responseFor(cases[0]),401,'session-expired'],[{...responseFor(cases[0]),token},200,'invalid-response']]) {
    const s=setup(); s.setHttp(async()=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
    await assert.rejects(s.manager.interpret(cases[0].request,new AbortController().signal),{code,message:code});
  }
  const s=setup(); s.setHttp(async()=>{delete s.data[s.key];return new Response(JSON.stringify(responseFor(cases[0])),{headers:{'Content-Type':'application/json'}});});
  await assert.rejects(s.manager.interpret(cases[0].request,new AbortController().signal),{code:'session-expired'});
});
test('interpret cancels HTTP and rejects concurrent submissions', async () => {
  const s=setup(); let entered;
  const ready=new Promise(resolve=>{entered=resolve;});
  s.setHttp((_url,options)=>new Promise((_resolve,reject)=>{entered();options.signal.addEventListener('abort',()=>reject(Error('PRIVATE')));}));
  const abort=new AbortController(); const first=s.manager.interpret(cases[0].request,abort.signal); await ready;
  await assert.rejects(s.manager.interpret(cases[0].request,new AbortController().signal),{code:'interpretation-busy'});
  abort.abort(); await assert.rejects(first,{code:'request-cancelled'});
});
test('interpretation target contract matches fill-engine kinds and proposal UI has no automatic fill call', () => {
  const text = fs.readFileSync(path.join(root,'features/filling/fill.types.ts'),'utf8');
  assert.match(text,/FillValue = InterpretTarget/);
  const ui = fs.readFileSync(path.join(root,'features/interpretation/InterpretationPanel.tsx'),'utf8');
  assert.equal(/requestFill|PIKO_FILL_APPROVE|executeScript|storage\./.test(ui),false);
});
