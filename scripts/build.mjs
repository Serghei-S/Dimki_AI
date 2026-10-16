import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {dirname, join} from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const schema = JSON.parse(await readFile(new URL('../data/schema/district.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTuples: false, inlineRefs: false, code: { source: true } });
ajv.addSchema(schema);
const id = {type: 'string', minLength: 1, maxLength: 128};
const ids = {type: 'array', items: id, uniqueItems: true, maxItems: 128};
const money = {type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER};
const ref = name => ({$ref: `${schema.$id}#/$defs/${name}`});
const object = (properties, required = Object.keys(properties)) => ({type: 'object', properties, required, additionalProperties: false});
const scenarioInput = object({projectIds: ids, budgetRub: money, operationalOverrides: {type: 'array', items: ref('operation'), maxItems: 1024}}, ['projectIds', 'budgetRub']);
const scenario = {$id: 'urn:obninsk:engine:scenario', anyOf: [scenarioInput, ref('scenario')]};
const metric = object({id, destinationKinds: {type: 'array', items: schema.$defs.destination.properties.kind, minItems: 1, uniqueItems: true},
  thresholdSeconds: {type: 'number', minimum: 0, maximum: 86400}, populationGroup: {enum: ['all', 'under18', 'age18to64', 'age65plus', 'mobilityNeeds']}});
const options = {$id: 'urn:obninsk:engine:options', ...object({metrics: {type: 'array', items: metric, minItems: 1, maxItems: 64},
  additionalProfiles: {type: 'array', items: ref('profile'), maxItems: 32}, cacheMaxEntries: {type: 'integer', minimum: 0, maximum: 1024},
  cacheMaxBytes: {type: 'integer', minimum: 0, maximum: 1073741824}}, [])};
const optimization = {$id: 'urn:obninsk:engine:optimization', ...object({profileId: id, metricId: id, budgetRub: money,
  candidateProjectIds: ids, requiredProjectIds: ids, operationalOverrides: scenarioInput.properties.operationalOverrides,
  maxCandidates: {type: 'integer', minimum: 1, maximum: 20}, topK: {type: 'integer', minimum: 1, maximum: 20}}, ['profileId', 'metricId', 'budgetRub'])};
optimization.properties.maxFrontierSize = {type: 'integer', minimum: 1, maximum: 65536};
ajv.addSchema(scenario); ajv.addSchema(options); ajv.addSchema(optimization);
const request = {$id: 'urn:obninsk:engine:request', oneOf: [
  object({type: {const: 'init'}, requestId: id, dataset: {$ref: schema.$id}, options: {$ref: options.$id}}, ['type', 'requestId', 'dataset']),
  object({type: {const: 'evaluate'}, requestId: id, scenario: {$ref: scenario.$id}, profileIds: {...ids, minItems: 1}}, ['type', 'requestId', 'scenario']),
  object({type: {const: 'route'}, requestId: id, scenario: {$ref: scenario.$id}, profileId: id, buildingId: id, metricId: id}),
  object({type: {const: 'routes'}, requestId: id, scenario: {$ref: scenario.$id}, profileId: id, buildingIds: {...ids, minItems: 1, maxItems: 1024}, metricId: id}),
  object({type: {const: 'network_access'}, requestId: id, scenario: {$ref: scenario.$id}, profileId: id, metricId: id}),
  object({type: {const: 'map_snapshot'}, requestId: id, scenario: {$ref: scenario.$id}, profileId: id, metricId: id, buildingIds: {...ids, maxItems:1024}}),
  object({type: {const: 'export_scenario'}, requestId: id, scenario: {$ref: scenario.$id}}),
  object({type: {const: 'import_scenario'}, requestId: id, envelope: {anyOf: [{type: 'string'}, {$ref: 'urn:obninsk:engine:envelope'}]}}),
  object({type: {const: 'optimize'}, requestId: id, input: {$ref: optimization.$id}}),
  object({type: {const: 'cancel'}, requestId: id, targetRequestId: id})]};
const envelope = {$id: 'urn:obninsk:engine:envelope', ...object({formatVersion: {const: 1}, datasetId: id, datasetVersion: id,
  datasetSha256: {type: 'string', pattern: '^[a-f0-9]{64}$'}, scenario: scenarioInput})};
ajv.addSchema(request); ajv.addSchema(envelope);
await mkdir('.tools/generated', {recursive: true});
await writeFile('.tools/generated/validators.cjs', standaloneCode(ajv, {dataset: schema.$id, scenario: scenario.$id,
  options: options.$id, optimization: optimization.$id, request: request.$id, envelope: envelope.$id}), 'utf8');
await build({entryPoints: ['.tools/generated/validators.cjs'], outfile: '.tools/generated/validators.mjs',
  bundle: true, platform: 'browser', format: 'esm', minify: true, legalComments: 'eof'});
await mkdir('dist', {recursive: true});
const compiler = spawnSync(process.execPath, [join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc'), '-p', 'tsconfig.json'], {stdio: 'inherit'});
if (compiler.status !== 0) process.exit(compiler.status ?? 1);
await build({entryPoints: {'engine': 'src/core/index.ts', 'engine.worker': 'src/core/engine.worker.ts', 'map-logic': 'src/map/logic.ts'},
  outdir: 'dist', bundle: true, platform: 'browser', format: 'esm', target: 'es2022', sourcemap: true, minify: true, legalComments: 'eof'});
console.log('Built browser ESM, Worker, declarations and precompiled JSON Schema validators.');
