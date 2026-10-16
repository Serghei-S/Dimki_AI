declare module '*.mjs' {
  interface Validator {
    (data: unknown): boolean;
    errors?: {instancePath: string; message?: string; keyword: string; params: unknown}[] | null;
  }
  const validators: Record<'dataset' | 'scenario' | 'options' | 'optimization' | 'request' | 'envelope', Validator>;
  export default validators;
}
