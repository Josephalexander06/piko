/**
 * Piko Data Contract Validation Suite
 *
 * Runs schema verification on all contract definitions and tests against
 * valid and invalid test fixtures.
 *
 * Usage: node test/validate-contracts.js
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// Helper to read and parse JSON
function loadJson(relPath) {
  const fullPath = path.resolve(__dirname, '..', relPath);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

console.log('======================================================');
console.log(' Piko Schema & Contract Test Harness');
console.log('======================================================\n');

// 1. Load schemas
const formFieldSchema = loadJson('contracts/form-field.schema.json');
const interpretReqSchema = loadJson('contracts/interpret-request.schema.json');
const interpretResSchema = loadJson('contracts/interpret-response.schema.json');
const approvedBatchSchema = loadJson('contracts/approved-fill-batch.schema.json');

// 2. Validate schemas themselves
console.log('[1/4] Validating schema definitions against JSON Schema meta-schema...');
const schemas = [
  { name: 'FormField', schema: formFieldSchema },
  { name: 'InterpretRequest', schema: interpretReqSchema },
  { name: 'InterpretResponse', schema: interpretResSchema },
  { name: 'ApprovedFillBatch', schema: approvedBatchSchema }
];

schemas.forEach(({ name, schema }) => {
  const isMetaValid = ajv.validateSchema(schema);
  if (!isMetaValid) {
    console.error(`❌ Meta-schema error in ${name}:`, ajv.errorsText());
    process.exit(1);
  }
  console.log(`  ✓ ${name} schema is structurally valid.`);
});

// 3. Register schemas with Ajv
ajv.addSchema(formFieldSchema, 'form-field.schema.json');
const validateFormField = ajv.compile(formFieldSchema);
const validateReq = ajv.compile(interpretReqSchema);
const validateRes = ajv.compile(interpretResSchema);
const validateBatch = ajv.compile(approvedBatchSchema);

console.log('\n[2/4] Testing valid fixture payloads...');

// Test valid InterpretRequest
const validReq = loadJson('test/fixtures/valid-interpret-request.json');
if (validateReq(validReq)) {
  console.log('  ✓ valid-interpret-request.json passed schema validation.');
} else {
  console.error('❌ Failed valid-interpret-request.json:', ajv.errorsText(validateReq.errors));
  process.exit(1);
}

// Test valid InterpretResponse
const validRes = loadJson('test/fixtures/valid-interpret-response.json');
if (validateRes(validRes)) {
  console.log('  ✓ valid-interpret-response.json passed schema validation.');
} else {
  console.error('❌ Failed valid-interpret-response.json:', ajv.errorsText(validateRes.errors));
  process.exit(1);
}

// Test valid ApprovedFillBatch
const validBatch = loadJson('test/fixtures/valid-approved-batch.json');
if (validateBatch(validBatch)) {
  console.log('  ✓ valid-approved-batch.json passed schema validation.');
} else {
  console.error('❌ Failed valid-approved-batch.json:', ajv.errorsText(validateBatch.errors));
  process.exit(1);
}

console.log('\n[3/4] Testing invalid fixture rejection...');

// Test invalid InterpretResponse (malformed fieldId pattern)
const invalidUnknown = loadJson('test/fixtures/invalid-interpret-response-unknown-field.json');
if (!validateRes(invalidUnknown)) {
  console.log('  ✓ Correctly rejected invalid-interpret-response-unknown-field.json:');
  console.log('    Reason:', ajv.errorsText(validateRes.errors));
} else {
  console.error('❌ Security Failure: invalid-interpret-response-unknown-field.json was unexpectedly accepted!');
  process.exit(1);
}

// Test invalid InterpretResponse (unauthorized property & confidence out-of-bounds)
const invalidBadOption = loadJson('test/fixtures/invalid-interpret-response-bad-option.json');
if (!validateRes(invalidBadOption)) {
  console.log('  ✓ Correctly rejected invalid-interpret-response-bad-option.json:');
  console.log('    Reason:', ajv.errorsText(validateRes.errors));
} else {
  console.error('❌ Security Failure: invalid-interpret-response-bad-option.json was unexpectedly accepted!');
  process.exit(1);
}

console.log('\n[4/4] Cross-Schema consistency checks...');
// Assert fieldId patterns match across all schemas
const fieldIdRegex = '^[a-zA-Z0-9_-]{1,64}$';
if (
  formFieldSchema.properties.fieldId.pattern === fieldIdRegex &&
  interpretResSchema.$defs.Update.properties.fieldId.pattern === formFieldSchema.definitions.scannerField.properties.fieldId.pattern &&
  approvedBatchSchema.properties.items.items.properties.fieldId.pattern === formFieldSchema.definitions.scannerField.properties.fieldId.pattern
) {
  console.log('  ✓ Interpretation, scanner and approval IDs are consistent.');
} else {
  console.error('❌ Inconsistent fieldId patterns detected across contracts!');
  process.exit(1);
}

console.log('\n======================================================');
console.log(' 🎉 All Contract & Schema Tests PASSED Successfully!');
console.log('======================================================\n');

