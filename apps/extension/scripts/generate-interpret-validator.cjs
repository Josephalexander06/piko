const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const standalone = require('ajv/dist/standalone').default;
for (const name of ['request', 'response']) {
  const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../contracts/interpret-${name}.schema.json`), 'utf8'));
  const ajv = new Ajv({ strict: true, code: { source: true, esm: true } });
  const source = '// Generated from the canonical interpretation contract. No runtime code generation.\n' + standalone(ajv, ajv.compile(schema)).replace(/require\("ajv\/dist\/runtime\/(ucs2length|equal)"\)\.default/g, (_match, helper) => `(${require(`ajv/dist/runtime/${helper}`).default.toString()})`);
  fs.writeFileSync(path.resolve(__dirname, `../src/features/interpretation/${name}-schema.generated.js`), source);
}
