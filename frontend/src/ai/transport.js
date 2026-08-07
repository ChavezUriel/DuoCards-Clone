// Provider-agnostic request builder / response parser.
//
// Deliberately dependency-free and side-effect-free so the SAME code runs in
// the browser (direct provider calls) and in the /api/llm relay (Node), which
// guarantees a relayed request is byte-for-byte the request the browser would
// have sent. Nothing here reads storage, the DOM, or process.env.

// Hosts the relay is allowed to forward to. Without this an authenticated user
// could turn /api/llm into an open proxy to any host (SSRF).
export const ALLOWED_UPSTREAM_HOSTS = [
  'opencode.ai',
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'openrouter.ai',
];

export function isAllowedUpstream(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_UPSTREAM_HOSTS.some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
    );
  } catch {
    return false;
  }
}

const DEFAULT_MAX_TOKENS = 4096;

// { url, headers, body } for one JSON-returning chat turn.
export function buildLlmRequest({
  transport,
  baseUrl,
  model,
  apiKey,
  system,
  user,
  temperature = 0.2,
  maxTokens = DEFAULT_MAX_TOKENS,
}) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');

  if (transport === 'anthropic') {
    return {
      url: `${base}/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Required for XHR/fetch straight from a page; harmless server-side.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: {
        model,
        max_tokens: maxTokens,
        temperature,
        system,
        messages: [
          { role: 'user', content: user },
          // Prefill the opening brace: the cheapest, most reliable way to stop
          // a chat model from wrapping its JSON in prose or a ``` fence.
          { role: 'assistant', content: '{' },
        ],
      },
    };
  }

  if (transport === 'gemini') {
    return {
      url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: {
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          // Natively enforced, unlike the OpenAI-compat layer, which leaks
          // non-JSON tokens on the lite models.
          responseMimeType: 'application/json',
        },
      },
    };
  }

  // openai-compatible (OpenAI, OpenCode Zen, OpenRouter, …)
  return {
    url: `${base}/chat/completions`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    },
  };
}

// -> { text, usage: { input_tokens, output_tokens } }. Throws when the payload
// carries no assistant text (an error body the HTTP status did not flag).
export function parseLlmResponse(transport, data) {
  if (transport === 'anthropic') {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const text = blocks
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('');
    if (!text) throw new Error('Claude response had no text content');
    return {
      // The assistant turn was prefilled with "{", so the model continues from
      // there and the opening brace is missing from what comes back.
      text: text.trimStart().startsWith('{') ? text : `{${text}`,
      usage: {
        input_tokens: data?.usage?.input_tokens ?? 0,
        output_tokens: data?.usage?.output_tokens ?? 0,
      },
    };
  }

  if (transport === 'gemini') {
    const parts = data?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts) ? parts.map((p) => p?.text ?? '').join('') : '';
    if (!text) {
      const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason;
      throw new Error(`Gemini response had no text content${reason ? ` (${reason})` : ''}`);
    }
    return {
      text,
      usage: {
        input_tokens: data?.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }

  const message = data?.choices?.[0]?.message;
  // Some gateways (OpenCode Zen with glm-*) hand back reasoning models' final
  // answer in `reasoning_content` and leave `content` empty, so fall back to it
  // rather than failing a turn whose answer is right there.
  const text = message?.content || message?.reasoning_content;
  if (!text) {
    const finish = data?.choices?.[0]?.finish_reason;
    throw new Error(
      finish === 'length'
        ? 'Model hit the token limit before returning JSON — try a smaller batch or another model'
        : 'Response had no message content',
    );
  }
  return {
    text,
    usage: {
      input_tokens: data?.usage?.prompt_tokens ?? 0,
      output_tokens: data?.usage?.completion_tokens ?? 0,
    },
  };
}

// GET request for the provider's model catalogue. Model ids move fast (and
// gateways rename them), so the builder offers "Load models" instead of relying
// only on the hard-coded suggestions.
export function buildModelsRequest({ transport, baseUrl, apiKey }) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  if (transport === 'anthropic') {
    return {
      url: `${base}/models?limit=100`,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    };
  }
  if (transport === 'gemini') {
    return { url: `${base}/models?pageSize=200`, headers: { 'x-goog-api-key': apiKey } };
  }
  return { url: `${base}/models`, headers: { authorization: `Bearer ${apiKey}` } };
}

// -> string[] of model ids, whatever the provider's envelope looks like.
export function parseModelsResponse(transport, data) {
  if (transport === 'gemini') {
    return (data?.models ?? [])
      .filter((model) => (model?.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((model) => String(model?.name ?? '').replace(/^models\//, ''))
      .filter(Boolean);
  }
  return (data?.data ?? [])
    .map((model) => String(model?.id ?? ''))
    .filter(Boolean);
}

// Best-effort human-readable message out of a provider error body.
export function describeUpstreamError(status, bodyText) {
  let detail = String(bodyText ?? '').slice(0, 400);
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.error?.message || parsed?.message || parsed?.error?.type || detail;
  } catch {
    /* not JSON — keep the raw snippet */
  }
  if (status === 401 || status === 403) {
    return `The provider rejected the API key (HTTP ${status}). ${detail}`;
  }
  if (status === 404) {
    return `Model or endpoint not found (HTTP 404). ${detail}`;
  }
  if (status === 429) {
    return `Rate limited by the provider (HTTP 429). ${detail}`;
  }
  return `Provider error HTTP ${status}: ${detail}`;
}
