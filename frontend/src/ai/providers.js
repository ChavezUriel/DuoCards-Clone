// Registry of the LLM providers the in-app deck builder can drive with the
// user's OWN API key. Mirrors supabase/scripts/lib/ollama.cjs (the Node CLI) so
// both entry points speak to the same endpoints — this one just runs in the
// browser and takes the key from the user instead of the environment.
//
// `transport` picks the request/response shape:
//   openai     POST {baseUrl}/chat/completions        — Authorization: Bearer
//   anthropic  POST {baseUrl}/messages                — x-api-key + version header
//   gemini     POST {baseUrl}/models/{m}:generateContent — x-goog-api-key
//
// `direct` says whether a browser can call the endpoint itself. Providers that
// don't answer CORS preflights (OpenCode Zen) must go through the bundled
// /api/llm relay — see frontend/api/_llmProxy.js. Everything else defaults to
// direct so the key never leaves the user's machine except toward the provider.

export const PROVIDERS = {
  opencode: {
    id: 'opencode',
    label: 'OpenCode Zen',
    blurb: 'Gateway to hosted open models (GLM, Qwen, Kimi…). One key, many models.',
    transport: 'openai',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    // OpenCode Zen does not answer CORS preflight requests, so the browser can
    // never call it directly — always relay.
    direct: false,
    keysUrl: 'https://opencode.ai/auth',
    keyHint: 'sk-…',
    // Measured on the blueprint prompt: luna ~3s, glm ~4s, kimi ~12s,
    // qwen ~27s. A deck is hundreds of prompts, so the default is the fast one.
    defaultModel: 'gpt-5.6-luna',
    models: ['gpt-5.6-luna', 'glm-5.2', 'kimi-k2.5', 'qwen3.7-plus', 'grok-4.5', 'minimax-m3'],
    modelsPath: '/models',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    blurb: 'GPT models. Fast and reliable JSON; good default for large decks.',
    transport: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    direct: true,
    keysUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-…',
    defaultModel: 'gpt-4.1-mini',
    models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o'],
    modelsPath: '/models',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    blurb: 'Claude models. Strongest at the judging passes that gate card quality.',
    transport: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    direct: true,
    keysUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-…',
    defaultModel: 'claude-sonnet-4-5-20250929',
    models: [
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20251101',
      'claude-haiku-4-5-20251001',
    ],
    modelsPath: '/models',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    blurb: 'Gemini models. Generous free tier — the cheapest way to try a run.',
    transport: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    direct: true,
    keysUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'AIza…',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
    modelsPath: '/models',
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export const DEFAULT_PROVIDER_ID = 'opencode';

export function getProvider(providerId) {
  return PROVIDERS[providerId] ?? PROVIDERS[DEFAULT_PROVIDER_ID];
}

// Never render a key in full — the builder shows this next to a stored key so
// the user can tell two keys apart without exposing either.
export function maskKey(apiKey) {
  const key = String(apiKey ?? '').trim();
  if (!key) return '';
  if (key.length <= 12) return `${key.slice(0, 2)}…${key.slice(-2)}`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
