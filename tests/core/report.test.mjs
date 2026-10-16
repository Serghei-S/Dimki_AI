import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPlanningEngine } from '../../dist/engine.js';
import { makeReport, aiContext, reportHtml, reportCsv, reportMarkdown, csvCell } from '../../dist/report.js';
const data = JSON.parse(await readFile(new URL('../../data/obninsk-center.json', import.meta.url), 'utf8'));
const engine = await createPlanningEngine(data);
const base = engine.evaluate({ projectIds: [], budgetRub: 8000000 }, ['walk']);
const changed = engine.evaluate(data.scenarios.find((s) => s.projectIds.length) ?? data.scenarios[0], [
  'walk',
]);
const report = makeReport(data, changed, base, 'walk', '2026-10-17T12:00:00.000Z');

test('report reconciles all five criteria and every house with the engine; averages compare common reachable cohorts', () => {
  assert.equal(report.metrics.length, 5);
  assert.equal(report.buildings.length, changed.profiles.walk.perBuilding.length * 5);
  assert.equal(new Set(report.facts.map((f) => f.id)).size, report.facts.length);
  for (const metric of report.metrics) {
    const a = changed.profiles.walk.destinations[metric.id];
    assert.equal(metric.afterCoverage, a.coveragePercent);
    assert.equal(metric.worsened, changed.changesFromBaseline.walk[metric.id].worsenedResidents);
    const rows = report.buildings.filter(
      (r) => r.metric === metric.id && r.beforeSeconds !== null && r.afterSeconds !== null,
    );
    const residents = rows.reduce((s, r) => s + r.residents, 0);
    const mean =
      rows.reduce((s, r) => s + (r.afterSeconds - r.beforeSeconds) * r.residents, 0) / (residents || 1) / 60;
    assert.equal(metric.commonResidents, residents);
    assert.equal(metric.commonMeanChangeMinutes, residents ? mean : null);
  }
  const copy = structuredClone(report);
  copy.scenario.projectIds.push('not-real');
  assert(!changed.scenario.projectIds.includes('not-real'));
});
test('report distinguishes gained/lost reachability and does not claim a mean improvement for disjoint cohorts', () => {
  const b = structuredClone(base),
    a = structuredClone(base);
  for (const value of [a, b]) value.profiles.walk.perBuilding = value.profiles.walk.perBuilding.slice(0, 2);
  const before = b.profiles.walk.perBuilding,
    after = a.profiles.walk.perBuilding;
  before[0].destinations.park = {
    travelSeconds: 100,
    reachable: true,
    withinThreshold: true,
    evaluatedResidents: 10,
  };
  before[1].destinations.park = {
    travelSeconds: null,
    reachable: false,
    withinThreshold: false,
    evaluatedResidents: 20,
  };
  after[0].destinations.park = {
    travelSeconds: null,
    reachable: false,
    withinThreshold: false,
    evaluatedResidents: 10,
  };
  after[1].destinations.park = {
    travelSeconds: 50,
    reachable: true,
    withinThreshold: true,
    evaluatedResidents: 20,
  };
  const metric = makeReport(data, a, b, 'walk').metrics.find((m) => m.id === 'park');
  assert.equal(metric.commonMeanChangeMinutes, null);
  assert.equal(metric.commonResidents, 0);
  assert.equal(metric.gainedAccess, 20);
  assert.equal(metric.lostAccess, 10);
});
test('report snapshots reject mixed datasets and external context omits geometry and per-house data', () => {
  assert.throws(() => makeReport(data, { ...changed, datasetSha256: 'different' }, base, 'walk'));
  assert.throws(() => makeReport(data, changed, base, 'unknown'));
  const context = aiContext(report);
  assert(!('buildings' in context));
  assert(!('scenario' in context));
  assert(!JSON.stringify(context).includes('"xy"'));
  assert(!JSON.stringify(context).includes('"polygon"'));
  assert.deepEqual(context.facts, report.facts);
});
test('HTML/Markdown exports escape user and model content, and CSV preserves raw seconds and blocks formulas', () => {
  const malicious = structuredClone(report);
  malicious.district = '<script>alert(1)</script>';
  malicious.changes = ['</style><img src=x onerror=alert(1)>'];
  const ai = {
    model: '<img src=x>',
    createdAt: 'now',
    question: '<script>question</script>',
    narrative: {
      findings: [{ title: '<script>title</script>', text: '<img onerror=bad>', evidenceIds: ['capex'] }],
      recommendations: [],
      limitations: ['<script>limit</script>'],
    },
  };
  const html = reportHtml(malicious, ai);
  assert(!html.includes('<script>'));
  assert(!html.includes('<img'));
  assert(html.includes('&lt;script&gt;'));
  assert(html.includes("default-src 'none'"));
  assert(html.includes('@page'));
  assert(html.includes('SHA256'));
  const md = reportMarkdown(malicious, ai);
  assert(!md.includes('<script>'));
  const csv = reportCsv(report);
  assert(csv.startsWith('\ufeff'));
  assert(csv.includes('before_seconds'));
  assert(!csv.includes('undefined'));
  for (const x of ['=HYPERLINK("x")', '+1', '-cmd', '@SUM(A1)', '  =cmd'])
    assert(csvCell(x).startsWith('"\''));
  assert.equal(csvCell(-12), '"-12"');
});
