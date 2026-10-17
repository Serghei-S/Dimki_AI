import { useEffect, useRef, useState } from 'react';
import { Sparkles, LoaderCircle, X } from 'lucide-react';
import { formatFact, type PlanningReport, type AiResult } from '../reports/report.js';

const defaultQuestion =
  'Дай краткую оценку текущего решения: что стало лучше или хуже для жителей, стоит ли сохранять изменения и что проверить дальше. Если изменений нет, назови главную проблему доступности и следующий шаг.';
export function ReportAssistant({ snapshot }: { snapshot: PlanningReport }) {
  const [report, setReport] = useState(snapshot),
    [ai, setAi] = useState<AiResult | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'offline'>('loading');
  const [question, setQuestion] = useState('');
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
          mode: 'summary',
          question: question.trim() || defaultQuestion,
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
  return (
    <div className="report-workspace">
      <section className="report-assistant" aria-label="AI-помощник отчёта">
        <div className="report-ai-heading">
          <span>
            <Sparkles size={20} />
          </span>
          <div>
            <h3>Что это значит для жителей?</h3>
            <p>Краткий вывод и следующий шаг</p>
          </div>
        </div>
        {(status === 'missing' || status === 'offline') && (
          <div className="report-connection-error" role="status">
            <p>
              {status === 'missing' ? 'Помощник ещё не подключён.' : 'Не удалось подключиться к помощнику.'}{' '}
              Расчётный отчёт доступен.
            </p>
            <button className="secondary-button" onClick={() => void checkStatus()} disabled={pending}>
              Повторить подключение
            </button>
          </div>
        )}
        <label className="field-label" htmlFor="report-question">
          Ваш вопрос (необязательно)
        </label>
        <textarea
          id="report-question"
          placeholder="Например: стоит ли оставить остановку здесь?"
          maxLength={1200}
          value={question}
          disabled={pending}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <div className="report-ai-actions">
          <button
            className="primary-button"
            disabled={pending || status !== 'ready'}
            onClick={() => void analyze()}
          >
            {pending ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{' '}
            {pending ? 'Готовим ответ…' : status === 'loading' ? 'Подключаемся…' : 'Получить вывод'}
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
            Оцениваем пользу для жителей и возможные недостатки.
          </p>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {ai ? (
          <div className="report-ai-result" aria-live="polite">
            {(
              [
                ['Главное', ai.narrative.findings],
                ['Что сделать дальше', ai.narrative.recommendations],
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
            <h4>Что пока неизвестно</h4>
            <ul>
              {ai.narrative.limitations.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <details className="report-privacy">
          <summary>Как подготовлен ответ</summary>
          <p>
            AI объясняет расчёт текущего сценария. По нажатию сервис получает сводные показатели, названия
            изменений и ваш вопрос. Координаты и данные отдельных домов не отправляются.
          </p>
          <p>
            Числа под выводами взяты из расчёта; нажмите на показатель, чтобы увидеть пояснение. Ответ AI
            может содержать ошибки.
          </p>
          {ai && (
            <p>
              {ai.provider} · {ai.model}
            </p>
          )}
        </details>
      </section>
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
    </div>
  );
}
