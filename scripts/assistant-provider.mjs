export const FREE_MODEL = 'nvidia/nemotron-3.5-super-vl:free';
export const FREE_MODEL_NAME = 'NVIDIA Nemotron 3.5 Super VL';
export const FREE_FALLBACK_MODELS = Object.freeze(['openrouter/free']);

export const OPENROUTER_PROVIDER = Object.freeze({
  id: 'openrouter',
  name: 'OpenRouter',
  billing: 'free',
  url: 'https://openrouter.ai/api/v1/chat/completions',
  model: FREE_MODEL,
  modelName: FREE_MODEL_NAME,
  fallbackModels: FREE_FALLBACK_MODELS,
  keyVariable: 'OPENROUTER_API_KEY',
  setupUrl: 'https://openrouter.ai/settings/keys',
});
export function resolveAssistantProvider(env = {}) {
  const id = (env.AI_PROVIDER || 'openrouter').trim().toLowerCase();
  if (id === 'openrouter') return OPENROUTER_PROVIDER;
  if (id !== 'riskradar') throw new Error('Unknown AI_PROVIDER');
  const model = (env.RISKRADAR_MODEL || 'gemini-2.5-flash').trim();
  if (!/^[a-zA-Z0-9._:/-]{1,120}$/.test(model)) throw new Error('Invalid RISKRADAR_MODEL');
  return {
    id: 'riskradar',
    name: 'RiskRadar',
    billing: 'prepaid',
    url: 'https://riskradarai.ru/v1/chat/completions',
    model,
    modelName: model,
    fallbackModels: [],
    keyVariable: 'RISKRADAR_API_KEY',
    setupUrl: 'https://riskradarai.ru/v1',
  };
}
export function providerRequest(provider, messages, responseFormat) {
  if (provider.id === 'openrouter')
    return {
      models: [provider.model, ...provider.fallbackModels],
      provider: { require_parameters: true, max_price: { prompt: 0, completion: 0, request: 0 } },
      temperature: 0.2,
      max_tokens: 6000,
      reasoning: { max_tokens: 1536, exclude: true },
      response_format: responseFormat,
      messages,
    };
  if (provider.id === 'riskradar')
    return {
      model: provider.model,
      temperature: 0.2,
      max_tokens: 3500,
      response_format: responseFormat,
      messages,
    };
  throw new Error('Unsupported assistant provider');
}
