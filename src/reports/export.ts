import { formatFact, type PlanningReport, type AiResult } from './report.js';
export const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const markdown = (s: unknown) =>
  escapeHtml(s)
    .replace(/[\\`*_{}\[\]()#+.!|>-]/g, '\\$&')
    .replace(/\r?\n/g, ' ');
export const csvCell = (value: unknown) => {
  let s = value == null ? '' : String(value);
  if (typeof value !== 'number' && /^[\s]*[=+@\-\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
};
export function reportCsv(report: PlanningReport): string {
  const rows: unknown[][] = [
    [
      'dataset_id',
      'dataset_sha256',
      'profile',
      'building_id',
      'metric',
      'residents',
      'before_seconds',
      'after_seconds',
      'before_within_threshold',
      'after_within_threshold',
    ],
  ];
  for (const b of report.buildings)
    rows.push([
      report.datasetId,
      report.datasetSha256,
      report.profileId,
      b.id,
      b.metric,
      b.residents,
      b.beforeSeconds,
      b.afterSeconds,
      b.beforeWithin,
      b.afterWithin,
    ]);
  return '\ufeff' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
}
export function reportMarkdown(report: PlanningReport, ai: AiResult | null): string {
  const out = [
    '# Димки AI · Отчёт',
    `${markdown(report.district)} · ${markdown(report.profileName)}`,
    `Сформирован: ${markdown(report.createdAt)}`,
    `SHA256 данных: ${report.datasetSha256}`,
    '',
    '## Показатели расчётного ядра',
    '| Показатель | Значение | Источник |',
    '|---|---|---|',
  ];
  for (const f of report.facts)
    out.push(`| ${markdown(f.label)} | ${markdown(formatFact(f))} | ${markdown(f.id)} |`);
  out.push(
    '',
    '## Изменения',
    ...(report.changes.length ? report.changes : ['Исходное состояние, без изменений.']).map(
      (x) => '- ' + markdown(x),
    ),
  );
  if (ai) {
    out.push(
      '',
      '## AI-помощник · черновик',
      `Модель: ${markdown(ai.model)}. ${markdown(ai.createdAt)}`,
      `Запрос: ${markdown(ai.question)}`,
    );
    for (const [name, items] of [
      ['Выводы', ai.narrative.findings],
      ['Рекомендации', ai.narrative.recommendations],
    ] as const) {
      out.push('', `### ${name}`);
      for (const item of items)
        out.push(
          `**${markdown(item.title)}**`,
          markdown(item.text),
          `Основание: ${item.evidenceIds.map(markdown).join(', ')}`,
          '',
        );
    }
    out.push(...ai.narrative.limitations.map((x) => '- ' + markdown(x)));
  }
  out.push(
    '',
    '## Допущения и ограничения',
    ...report.limitations.map((x) => '- ' + markdown(x)),
    '',
    '## Как рассчитаны показатели',
    ...report.facts.map((f) => `- **${markdown(f.id)}**: ${markdown(f.method)}`),
    '',
    '## Параметры',
    '```json',
    JSON.stringify(report.assumptions, null, 2),
    '```',
  );
  return out.join('\n');
}
export function reportHtml(report: PlanningReport, ai: AiResult | null): string {
  const h = escapeHtml;
  const findings = (items: AiResult['narrative']['findings']) =>
    items
      .map(
        (item) =>
          `<article><h3>${h(item.title)}</h3><p>${h(item.text)}</p><p class="source">Основание: ${item.evidenceIds
            .map((id) => {
              const f = report.facts.find((f) => f.id === id);
              return f ? `${h(f.label)}: ${h(formatFact(f))} [${h(id)}]` : '';
            })
            .join('; ')}</p></article>`,
      )
      .join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Димки AI · Отчёт</title><style>
body{font:14px/1.65 system-ui,sans-serif;color:#1e2d45;margin:40px auto;padding:0 24px;max-width:1000px}h1{font-size:30px;margin-bottom:6px}h2{margin-top:32px;font-size:21px;border-bottom:2px solid #1261ed;padding-bottom:8px}h3{font-size:16px}p{margin:8px 0}small,.source{color:#5c6d83;font-size:12px;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:9px 10px;text-align:left;border-bottom:1px solid #e1e7ef;vertical-align:top}th{background:#edf4ff}tr,article{break-inside:avoid}article{padding:14px 18px;background:#f4f6f9;margin:12px 0;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}li{margin:7px 0}@page{size:A4;margin:16mm}@media print{body{margin:0;padding:0;font-size:11px}h1{font-size:25px}h2{font-size:17px}thead{display:table-header-group}table{font-size:10px}th,td{padding:6px}article{background:white;border:1px solid #e1e7ef}h2,h3{break-after:avoid}}
</style></head><body><h1>Димки AI</h1><p>${h(report.district)} · ${h(report.profileName)}</p><small>Отчёт от ${h(report.createdAt)}<br>Набор: ${h(report.datasetId)} · ${h(report.datasetVersion)}<br>SHA256: ${h(report.datasetSha256)}</small>
<h2>Сравнение сценария</h2><table><thead><tr><th>Категория</th><th>Охват до, %</th><th>Охват после, %</th><th>Изменение пути, мин</th><th>Стало хуже, жителей</th><th>Потеряли путь</th></tr></thead><tbody>${report.metrics.map((m) => `<tr><td>${h(m.name)}</td><td>${h(m.beforeCoverage === null ? '—' : m.beforeCoverage.toFixed(1))}</td><td>${h(m.afterCoverage === null ? '—' : m.afterCoverage.toFixed(1))}</td><td>${h(m.commonMeanChangeMinutes === null ? '—' : m.commonMeanChangeMinutes.toFixed(2))}</td><td>${h(m.worsened)}</td><td>${h(m.lostAccess)}</td></tr>`).join('')}</tbody></table><p class="source">Изменение пути: после − до, только для жителей, достижимых в обоих состояниях. Минус — улучшение. Потерявшие путь входят в число тех, кому стало хуже. Жители разных категорий не суммируются.</p>
<h2>Изменения</h2><ul>${(report.changes.length ? report.changes : ['Исходное состояние, без изменений.']).map((x) => `<li>${h(x)}</li>`).join('')}</ul>
${ai ? `<h2>AI-помощник · черновик</h2><small>Модель: ${h(ai.model)} · ${h(ai.createdAt)}</small><p>Запрос: ${h(ai.question)}</p><h3>Выводы</h3>${findings(ai.narrative.findings)}<h3>Рекомендации</h3>${findings(ai.narrative.recommendations)}<ul>${ai.narrative.limitations.map((x) => `<li>${h(x)}</li>`).join('')}</ul>` : ''}
<h2>Показатели расчётного ядра</h2><table><thead><tr><th>Показатель</th><th>Значение</th><th>Основание</th></tr></thead><tbody>${report.facts.map((f) => `<tr><td>${h(f.label)}</td><td>${h(formatFact(f))}</td><td><small>${h(f.id)}</small><br>${h(f.method)}</td></tr>`).join('')}</tbody></table>
<h2>Допущения и ограничения</h2><ul>${report.limitations.map((x) => `<li>${h(x)}</li>`).join('')}</ul><h2>Параметры расчёта</h2><pre>${h(JSON.stringify(report.assumptions, null, 2))}</pre></body></html>`;
}
export function downloadReport(
  report: PlanningReport,
  ai: AiResult | null,
  format: 'html' | 'md' | 'json' | 'csv',
) {
  const text =
    format === 'html'
      ? reportHtml(report, ai)
      : format === 'md'
        ? reportMarkdown(report, ai)
        : format === 'csv'
          ? reportCsv(report)
          : JSON.stringify({ report, ai }, null, 2);
  const mime = { html: 'text/html', md: 'text/markdown', json: 'application/json', csv: 'text/csv' }[format];
  const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `dimki-ai-${report.datasetId}-${report.createdAt.slice(0, 10)}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function printReport(report: PlanningReport, ai: AiResult | null) {
  const frame = document.createElement('iframe');
  frame.title = 'Печатный отчёт Димки AI';
  frame.style.cssText =
    'position:fixed;width:1px;height:1px;bottom:0;left:0;border:0;opacity:0;pointer-events:none';
  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) return;
    win.onafterprint = () => frame.remove();
    win.focus();
    win.print();
  };
  frame.srcdoc = reportHtml(report, ai);
  document.body.append(frame);
  setTimeout(() => frame.remove(), 120000);
}
