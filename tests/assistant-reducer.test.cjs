const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('../apps/extension/node_modules/typescript');

// Compile the actual, browser-independent state modules in memory. This keeps
// the suite compatible with the project's Node 20 baseline without a TS runner.
const modules = new Map();
function loadTypeScript(filename) {
  if (modules.has(filename)) return modules.get(filename).exports;
  const loaded = { exports: {} };
  modules.set(filename, loaded);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  });
  const localRequire = (specifier) => {
    assert.ok(specifier.startsWith('./'), 'State modules must remain browser independent');
    return loadTypeScript(path.resolve(path.dirname(filename), `${specifier}.ts`));
  };
  new Function('exports', 'require', 'module', outputText)(loaded.exports, localRequire, loaded);
  return loaded.exports;
}
const { assistantReducer: reduce, createInitialState, selectedProposals, hasValue } = loadTypeScript(
  path.resolve(__dirname, '../apps/extension/src/features/assistant/assistant.reducer.ts'),
);
test('accepted voice text enters conversation only and never changes proposals or approvals', () => {
  const before = conversation(); const after = reduce(before, { type: 'ACCEPT_TRANSCRIPT', text: 'Edited synthetic voice answer.' });
  assert.equal(after.messages.at(-2).content, 'Edited synthetic voice answer.');
  assert.deepEqual(after.proposals, before.proposals); assert.deepEqual(after.approvedProposals, []); assert.equal(after.draftAnswer, before.draftAnswer);
  assert.equal(reduce(createInitialState(), { type: 'ACCEPT_TRANSCRIPT', text: 'not in conversation' }).stage, 'idle');
  assert.equal(reduce(before, { type: 'ACCEPT_TRANSCRIPT', text: ' ' }), before);
});
function conversation() {
  return ['LOAD_DEMO_FORM', 'FINISH_DEMO_INSPECTION', 'START_CONVERSATION']
    .reduce((state, type) => reduce(state, { type }), createInitialState());
}
function review() {
  return reduce(reduce(conversation(), { type: 'ADD_DEMO_ANSWER' }), { type: 'OPEN_REVIEW' });
}

test('invalid stages cannot approve or edit proposals', () => {
  const idle = createInitialState();
  for (const action of [
    { type: 'SIMULATE_APPROVAL' }, { type: 'FINISH_DEMO_INSPECTION' },
    { type: 'OPEN_REVIEW' }, { type: 'ADD_DEMO_ANSWER' },
    { type: 'UPDATE_PROPOSAL', fieldId: 'demo-name', value: 'Injected answer' },
  ]) assert.equal(reduce(idle, action), idle);
  assert.equal(reduce(conversation(), { type: 'SIMULATE_APPROVAL' }).stage, 'conversation');
});

test('inspection loads five empty fields including a choice and required missing answer', () => {
  const inspecting = reduce(createInitialState(), { type: 'LOAD_DEMO_FORM' });
  assert.equal(inspecting.stage, 'inspecting-demo');
  assert.equal(inspecting.form, null);
  const ready = reduce(inspecting, { type: 'FINISH_DEMO_INSPECTION' });
  assert.equal(ready.stage, 'ready');
  assert.equal(ready.proposals.length, 5);
  assert.deepEqual(new Set(ready.proposals.map((p) => p.type)), new Set(['text', 'email', 'tel', 'select']));
  assert.ok(ready.proposals.every((p) => p.value === null && !p.selected));
  assert.equal(reduce(ready, { type: 'OPEN_REVIEW' }), ready);
});

test('sample answer creates four proposals and asks for organization without inventing it', () => {
  const state = reduce(conversation(), { type: 'ADD_DEMO_ANSWER' });
  assert.equal(state.proposals.filter(hasValue).length, 4);
  const missing = state.proposals.find((p) => p.fieldId === 'demo-organization');
  assert.equal(missing.value, null);
  assert.equal(missing.selected, false);
  assert.match(state.messages.at(-1).content, /Still missing: Organization/);
  assert.ok(state.proposals.every((p) => p.source === 'demo'));
  assert.equal(reduce(state, { type: 'ADD_DEMO_ANSWER' }), state);
});

test('typed answer updates only its explicitly chosen field', () => {
  let state = reduce(conversation(), { type: 'ADD_DEMO_ANSWER' });
  const previous = state.proposals;
  state = reduce(state, { type: 'SET_DRAFT_ANSWER', value: 'Example Research' });
  state = reduce(state, { type: 'ADD_TEXT_ANSWER' });
  assert.equal(state.proposals.find((p) => p.fieldId === 'demo-organization').value, 'Example Research');
  assert.equal(state.proposals.find((p) => p.fieldId === 'demo-organization').source, 'user-provided');
  assert.deepEqual(state.proposals.slice(0, 4), previous.slice(0, 4));
  assert.equal(state.draftAnswer, '');
});

test('typed answer validates before making a proposal and preserves earlier typed answers', () => {
  let state = reduce(conversation(), { type: 'SET_ANSWER_FIELD', fieldId: 'demo-email' });
  state = reduce(state, { type: 'SET_DRAFT_ANSWER', value: 'invalid' });
  state = reduce(state, { type: 'ADD_TEXT_ANSWER' });
  assert.ok(state.validationErrors.answer);
  assert.equal(state.proposals.find((p) => p.fieldId === 'demo-email').value, null);
  state = reduce(state, { type: 'SET_DRAFT_ANSWER', value: 'typed@example.test' });
  state = reduce(state, { type: 'ADD_TEXT_ANSWER' });
  state = reduce(state, { type: 'ADD_DEMO_ANSWER' });
  assert.equal(state.proposals.find((p) => p.fieldId === 'demo-email').value, 'typed@example.test');
});

test('editing and exclusions are reflected in a fixed simulated approval snapshot', () => {
  let state = review();
  state = reduce(state, { type: 'UPDATE_PROPOSAL', fieldId: 'demo-name', value: 'Edited Example' });
  state = reduce(state, { type: 'TOGGLE_PROPOSAL', fieldId: 'demo-phone' });
  assert.equal(selectedProposals(state).length, 3);
  const approved = reduce(state, { type: 'SIMULATE_APPROVAL' });
  assert.equal(approved.stage, 'approval-simulated');
  assert.deepEqual(approved.approvedProposals.map((p) => p.fieldId), ['demo-name', 'demo-email', 'demo-contact']);
  assert.equal(approved.approvedProposals[0].value, 'Edited Example');
  assert.equal(approved.approvedProposals[0].source, 'user-provided');
  assert.notEqual(approved.approvedProposals[0], state.proposals[0]);
  for (const action of [
    { type: 'UPDATE_PROPOSAL', fieldId: 'demo-name', value: 'Changed after approval' },
    { type: 'TOGGLE_PROPOSAL', fieldId: 'demo-email' },
    { type: 'RETURN_TO_CONVERSATION' }, { type: 'OPEN_REVIEW' }, { type: 'SIMULATE_APPROVAL' },
  ]) assert.equal(reduce(approved, action), approved);
});

test('invalid selected values block approval while excluded invalid answers stay excluded', () => {
  let state = reduce(review(), { type: 'UPDATE_PROPOSAL', fieldId: 'demo-email', value: 'invalid' });
  state = reduce(state, { type: 'SIMULATE_APPROVAL' });
  assert.equal(state.stage, 'review');
  assert.ok(state.validationErrors['demo-email']);
  assert.deepEqual(state.approvedProposals, []);
  state = reduce(state, { type: 'TOGGLE_PROPOSAL', fieldId: 'demo-email' });
  assert.equal(reduce(state, { type: 'SIMULATE_APPROVAL' }).stage, 'approval-simulated');
});

test('empty selection and unknown fields cannot authorize values', () => {
  let state = review();
  const original = structuredClone(state.proposals);
  state = reduce(state, { type: 'UPDATE_PROPOSAL', fieldId: 'unknown', value: 'Unknown' });
  state = reduce(state, { type: 'TOGGLE_PROPOSAL', fieldId: 'unknown' });
  assert.deepEqual(state.proposals, original);
  state = reduce(state, { type: 'TOGGLE_PROPOSAL', fieldId: 'demo-organization' });
  assert.equal(state.proposals.at(-1).selected, false);
  for (const proposal of selectedProposals(state)) state = reduce(state, { type: 'TOGGLE_PROPOSAL', fieldId: proposal.fieldId });
  assert.equal(reduce(state, { type: 'SIMULATE_APPROVAL' }), state);
});

test('clearing a selected value excludes it without fabricating a replacement', () => {
  let state = reduce(review(), { type: 'UPDATE_PROPOSAL', fieldId: 'demo-name', value: '' });
  assert.equal(state.proposals[0].value, '');
  assert.equal(state.proposals[0].selected, false);
  state = reduce(state, { type: 'SIMULATE_APPROVAL' });
  assert.equal(state.stage, 'approval-simulated');
  assert.equal(state.approvedProposals.some((p) => p.fieldId === 'demo-name'), false);
});

test('reset clears messages, drafts, proposals and simulated approval from every stage', () => {
  for (const state of [conversation(), review(), reduce(review(), { type: 'SIMULATE_APPROVAL' })]) {
    assert.deepEqual(reduce({ ...state, draftAnswer: 'Temporary answer' }, { type: 'RESET_SESSION' }), createInitialState());
  }
});

test('an explicit error clears session data and can be reset', () => {
  const error = reduce(review(), { type: 'SET_ERROR', message: 'Synthetic failure' });
  assert.equal(error.stage, 'error');
  assert.equal(error.errorMessage, 'Synthetic failure');
  assert.deepEqual(error.proposals, []);
  assert.deepEqual(error.messages, []);
  assert.deepEqual(reduce(error, { type: 'RESET_SESSION' }), createInitialState());
});
