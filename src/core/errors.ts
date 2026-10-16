export type ErrorCode = 'INVALID_DATASET' | 'INVALID_INPUT' | 'UNKNOWN_ID' | 'INVALID_SCENARIO'
  | 'BUDGET_EXCEEDED' | 'PROJECT_CONFLICT' | 'DEPENDENCY_ERROR' | 'INVALID_STATE'
  | 'SEARCH_LIMIT' | 'CANCELLED' | 'DATASET_MISMATCH' | 'WORKER_DISPOSED';
export class EngineError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details: unknown = null) {
    super(message);
    this.name = 'EngineError';
  }
}
export function requireCondition(condition: unknown, code: ErrorCode, message: string, details: unknown = null): asserts condition {
  if (!condition) throw new EngineError(code, message, details);
}
export function serializeError(error: unknown): { code: ErrorCode; message: string; details: unknown } {
  return error instanceof EngineError ? { code: error.code, message: error.message, details: error.details }
    : { code: 'INVALID_INPUT', message: error instanceof Error ? error.message : String(error), details: null };
}
