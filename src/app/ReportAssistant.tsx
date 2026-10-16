import { useEffect, useRef, useState } from 'react';
import { Download, FileText, Sparkles, LoaderCircle, X, ArrowUpRight, Check, RefreshCw } from 'lucide-react';
import { formatFact, type PlanningReport, type AiResult } from '../reports/report.js';
import { downloadReport, printReport } from '../reports/export.js';

const modes = [
  {
    id: 'summary',
    label: 'Объяснить результат',
    question: 'Объясни сильные и слабые стороны этого сценария.',
  },
  {
    id: 'risks',
    label: 'Найти риски',
    question: 'Какие ухудшения и ограничения нельзя упустить при принятии решения?',
  },
  {
    id: 'next',
    label: 'Следующий шаг',
    question: 'Предложи следующие гипотезы для проверки расчётом. Не обещай непосчитанный эффект.',
  },
] as const;
const n = (x: number | null) => (x === null ? '—' : x.toLocaleString('ru-RU', { maximumFractionDigits: 1 }));
export function ReportAssistant({ snapshot }: { snapshot: PlanningReport }) {
  const [report, setReport] = useState(snapshot),
    [ai, setAi] = useState<AiResult | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'offline'>('loading');
  const [mode, setMode] = useState<(typeof modes)[number]['id']>('summary'),
    [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [factId, setFactId] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null),
    statusRequest = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const factPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (factId) {
      factPanel.current?.scrollIntoView({ block: 'nearest' });
      factPanel.current?.focus({ preventScroll: true });
    }
  }, [factId]);
  async function checkStatus() {
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;
    setStatus('loading');
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort();
        setStatus('offline');
      }
    }, 8000);
    try {
      const response = await fetch('/api/assistant/status', { signal: controller.signal });
      if (!response.ok) throw new Error();
      const result = (await response.json()) as { configured?: boolean };
      if (!controller.signal.aborted) setStatus(result.configured ? 'ready' : 'missing');
    } catch {
      if (!controller.signal.aborted) setStatus('offline');
    } finally {
      clearTimeout(timer);
    }
  }
  useEffect(() => {
    void checkStatus();
    return () => {
      revision.current++;
      active.current?.abort();
      statusRequest.current?.abort();
    };
  }, []);
  function cancel() {
    revision.current++;
    active.current?.abort();
    active.current = null;
    setPending(false);
    setError('Запрос отменён. Расчётный отчёт сохранён.');
  }
  async function analyze() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const current = ++revision.current;
    setPending(true);
    setError(null);
    setAi(null);
    const timer = setTimeout(() => controller.abort(), 100000);
    try {
      const response = await fetch('/api/assistant/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          datasetId: report.datasetId,
          datasetSha256: report.datasetSha256,
          profileId: report.profileId,
          scenario: report.scenario,
          mode,
          question: question.trim() || modes.find((m) => m.id === mode)!.question,
        }),
      });
      const payload = (await response.json()) as {
        report?: PlanningReport;
        ai?: AiResult;
        error?: string;
        code?: string;
      };
      if (current !== revision.current) return;
      if (!response.ok) {
        if (payload.code === 'NOT_CONFIGURED') setStatus('missing');
        throw new Error(payload.error ?? 'Не удалось получить ответ AI.');
      }
      if (!payload.report || !payload.ai || payload.report.snapshotKey !== snapshot.snapshotKey)
        throw new Error('Ответ относится к другому сценарию. Создайте отчёт заново.');
      setReport(payload.report);
      setAi(payload.ai);
    } catch (err) {
      if (current === revision.current)
        setError(
          controller.signal.aborted
            ? 'Время ожидания истекло. Можно повторить запрос.'
            : err instanceof Error
              ? err.message
              : 'AI недоступен.',
        );
    } finally {
      clearTimeout(timer);
      if (current === revision.current) {
        setPending(false);
        active.current = null;
      }
    }
  }
  const focused = report.facts.find((f) => f.id === factId);
  const cost = report.facts.find((f) => f.id === 'capex')!,
    population = report.facts.find((f) => f.id === 'population')!;
  return (
    <div className="report-workspace">
      <div className="report-meta">
        <span>
          <Check size={14} /> Снимок расчёта
        </span>
        <span>{report.profileName}</span>
        <time dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleString('ru-RU')}</time>
      </div>
      <div className="report-grid">
        <section className="report-main" aria-label="Расчётный отчёт">
          <div className="report-kpis">
            <button onClick={() => setFactId('population')}>
              <span>Население модели</span>
              <strong>{n(population.value)}</strong>
              <small>жителей</small>
            </button>
            <button onClick={() => setFactId('capex')}>
              <span>Стоимость изменений</span>
              <strong>{n(cost.value)}</strong>
              <small>₽ · условные цены</small>
            </button>
          </div>
          <div className="section-heading">
            <h3>Доступность · до и после</h3>
            <span>Охват, %</span>
          </div>
          <div className="report-metrics">
            {report.metrics.map((m) => (
              <div key={m.id} className="report-metric">
                <div>
                  <strong>{m.name}</strong>
                  <span>
                    {n(m.beforeCoverage)} → <b>{n(m.afterCoverage)}%</b>
                  </span>
                </div>
                <div className="report-bars" aria-hidden="true">
                  <i style={{ width: `${m.beforeCoverage ?? 0}%` }} />
                  <b style={{ width: `${m.afterCoverage ?? 0}%` }} />
                </div>
                <div className="report-metric-detail">
                  <button onClick={() => setFactId(`${m.id}.threshold`)}>
                    Порог {n(m.thresholdMinutes)} мин
                  </button>
                  <button onClick={() => setFactId(`${m.id}.coverage.after`)}>
                    Как считается <ArrowUpRight size={12} />
                  </button>
                </div>
                <div className="report-cohorts">
                  <button onClick={() => setFactId(`${m.id}.improved`)}>
                    Ближе <b>{n(m.improved)}</b>
                  </button>
                  <button
                    className={m.worsened ? 'has-loss' : ''}
                    onClick={() => setFactId(`${m.id}.worsened`)}
                  >
                    Дальше <b>{n(m.worsened)}</b>
                  </button>
                  <button
                    className={m.lostAccess ? 'has-loss' : ''}
                    onClick={() => setFactId(`${m.id}.lost`)}
                  >
                    Потеряли путь <b>{n(m.lostAccess)}</b>
                  </button>
                </div>
              </div>
            ))}
          </div>
          <details className="report-detail">
            <summary>Автоматическая сводка по правилам</summary>
            <p>Эта сводка составлена без языковой модели. Жители между категориями не суммируются.</p>
            {report.metrics.map((m) => (
              <p key={m.id}>
                <b>{m.name}.</b>{' '}
                {m.commonMeanChangeMinutes === null
                  ? 'Нет общей достижимой группы для сравнения среднего.'
                  : `Изменение среднего пути для ${n(m.commonResidents)} жителей общей группы: ${n(m.commonMeanChangeMinutes)} мин (после − до).`}{' '}
                Недостижимо после: {n(m.unreachable)} жителей.
              </p>
            ))}
          </details>
          <details className="report-detail">
            <summary>Что изменено · {report.changes.length}</summary>
            {report.changes.length ? (
              <ul>
                {report.changes.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            ) : (
              <p>Исходное состояние района, без изменений.</p>
            )}
          </details>
          <details className="report-detail">
            <summary>Допущения и качество данных</summary>
            <ul>
              {report.limitations.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
            <pre>{JSON.stringify(report.assumptions, null, 2)}</pre>
            <small>
              Данные: {report.datasetId} · {report.datasetVersion}
              <br />
              SHA256: {report.datasetSha256}
            </small>
          </details>
        </section>
        <section className="report-assistant" aria-label="AI-помощник отчёта">
          <div className="report-ai-heading">
            <span>
              <Sparkles size={20} />
            </span>
            <div>
              <h3>Второй взгляд</h3>
              <p>AI-помощник по вашему сценарию</p>
            </div>
          </div>
          <div className={`report-ai-status report-ai-status--${status}`}>
            <i />
            {status === 'ready'
              ? 'Ключ настроен · бесплатный режим'
              : status === 'loading'
                ? 'Проверяем настройки…'
                : status === 'missing'
                  ? 'Готов к подключению'
                  : 'Сервер AI недоступен'}
            <button
              onClick={() => void checkStatus()}
              aria-label="Проверить подключение AI"
              disabled={pending}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          {status === 'missing' && (
            <details className="report-setup" open>
              <summary>Подключить бесплатный AI</summary>
              <ol>
                <li>
                  Создайте ключ в{' '}
                  <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">
                    OpenRouter ↗
                  </a>
                  .
                </li>
                <li>
                  Скопируйте <code>.env.example</code> в <code>.env.local</code> в папке проекта и заполните{' '}
                  <code>OPENROUTER_API_KEY</code>.
                </li>
                <li>Нажмите проверку подключения выше. Ключ остаётся на локальном сервере.</li>
              </ol>
              <p>Обычный отчёт и все форматы выгрузки уже доступны.</p>
            </details>
          )}
          {status === 'offline' && (
            <p className="studio-note">
              Запустите приложение через <code>npm run dev</code> или локальный <code>npm run preview</code>.
              Статический хостинг не содержит AI-сервер.
            </p>
          )}
          <div className="report-prompts">
            {modes.map((m) => (
              <button
                key={m.id}
                aria-pressed={mode === m.id}
                disabled={pending}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <label className="field-label" htmlFor="report-question">
            На что обратить внимание?
          </label>
          <textarea
            id="report-question"
            placeholder="Например: кому стало хуже и что проверить перед переносом остановки?"
            maxLength={1200}
            value={question}
            disabled={pending}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <p className="report-privacy">
            По нажатию модель получит сводные показатели, названия изменений, допущения и ваш вопрос.
            Координаты и строки по отдельным домам не отправляются. Не добавляйте личные сведения в вопрос.
          </p>
          <div className="report-ai-actions">
            <button
              className="primary-button"
              disabled={pending || status !== 'ready'}
              onClick={() => void analyze()}
            >
              {pending ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{' '}
              {pending ? 'Анализируем…' : 'Проанализировать'}
            </button>
            {pending && (
              <button className="secondary-button" onClick={cancel}>
                <X size={14} />
                Отмена
              </button>
            )}
          </div>
          {pending && (
            <p className="studio-note" role="status">
              Пересчитываем сценарий и ждём бесплатную модель. Это может занять до полутора минут.
            </p>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {ai ? (
            <div className="report-ai-result" aria-live="polite">
              <small>AI-черновик · {ai.model}</small>
              <p className="studio-note">
                Проверьте интерпретацию перед использованием. Числа в основаниях взяты из расчётного ядра.
              </p>
              {(
                [
                  ['Выводы', ai.narrative.findings],
                  ['Что проверить дальше', ai.narrative.recommendations],
                ] as const
              ).map(([title, items]) => (
                <section key={title}>
                  <h4>{title}</h4>
                  {items.map((item, index) => (
                    <article key={index}>
                      <h5>{item.title}</h5>
                      <p>{item.text}</p>
                      <div className="report-evidence">
                        {item.evidenceIds.map((id) => {
                          const f = report.facts.find((f) => f.id === id);
                          return f ? (
                            <button key={id} onClick={() => setFactId(id)}>
                              {f.label}: <b>{formatFact(f)}</b>
                            </button>
                          ) : null;
                        })}
                      </div>
                    </article>
                  ))}
                </section>
              ))}
              <ul>
                {ai.narrative.limitations.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          ) : (
            !pending && (
              <div className="report-ai-empty">
                <FileText size={26} />
                <p>От цифр — к понятным выводам</p>
                <small>
                  Помощник объяснит изменения, отметит потери доступности и предложит гипотезы для следующего
                  расчёта.
                </small>
              </div>
            )
          )}
        </section>
      </div>
      {focused && (
        <section
          ref={factPanel}
          tabIndex={-1}
          className="report-fact"
          aria-live="polite"
          aria-label="Объяснение показателя"
        >
          <button className="icon-button" aria-label="Закрыть пояснение" onClick={() => setFactId(null)}>
            <X size={16} />
          </button>
          <h4>{focused.label}</h4>
          <strong>{formatFact(focused)}</strong>
          <p>{focused.method}</p>
          <small>Источник: {focused.id} · расчётное ядро</small>
        </section>
      )}
      <footer className="report-export">
        <div>
          <Download size={17} />
          <strong>Выгрузить отчёт</strong>
          <small>{ai ? 'С AI-комментарием' : 'Расчётные данные'}</small>
        </div>
        <div>
          <button onClick={() => printReport(report, ai)}>PDF / Печать</button>
          {(['html', 'md', 'json', 'csv'] as const).map((f) => (
            <button
              key={f}
              onClick={() => downloadReport(report, ai, f)}
              title={f === 'csv' ? 'Таблица по домам; время в секундах' : undefined}
            >
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}
