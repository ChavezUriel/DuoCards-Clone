// Multi-provider LLM chat client for the card generator.
//
// All providers expose the same `chatJson({ system, user, temperature })` shape
// (returns a parsed JSON object), so callers don't care which backend runs.
// Selection is via OLLAMA_PROVIDER:
//
//   ollama  (default)  local Ollama   POST /api/chat (format:"json")              — no key
//   go                 OpenCode Go   POST /v1/chat/completions                 — Bearer key
//   gemini             Google Gemini POST /v1beta/models/<m>:generateContent     — x-goog-api-key
//                                      (native API w/ responseMimeType JSON — the
//                                       OpenAI-compat layer doesn't strictly
//                                       enforce JSON for lite models)
//
// Override the model / base URL via OLLAMA_MODEL / OLLAMA_BASE_URL as before;
// defaults depend on the provider. Cloud API key via OLLAMA_API_KEY, or the
// provider-specific OPENCODE_GO_API_KEY / GEMINI_API_KEY.
//
// Requires Node 18+ (global fetch / AbortController).

const PROVIDERS = {
  ollama: {
    defaultModel: 'gpt-oss:20b',
    defaultBaseUrl: 'http://127.0.0.1:11434',
    keyEnv: 'OLLAMA_API_KEY',
    transport: 'ollama',
  },
  go: {
    defaultModel: 'glm-5.2',
    defaultBaseUrl: 'https://opencode.ai/zen/go/v1',
    keyEnv: 'OPENCODE_GO_API_KEY',
    transport: 'openai',
    chatPath: '/chat/completions',
  },
  gemini: {
    defaultModel: 'gemini-2.5-flash',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyEnv: 'GEMINI_API_KEY',
    transport: 'gemini',
  },
};

const PROVIDER = String(process.env.OLLAMA_PROVIDER || 'ollama').toLowerCase();
const providerCfg = PROVIDERS[PROVIDER];
if (!providerCfg) {
  throw new Error(
    `Unknown OLLAMA_PROVIDER "${PROVIDER}". Valid: ${Object.keys(PROVIDERS).join(', ')}`
  );
}

const MODEL = process.env.OLLAMA_MODEL || providerCfg.defaultModel;
const BASE_URL = (process.env.OLLAMA_BASE_URL || providerCfg.defaultBaseUrl).replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 600000); // 10 min; local Ollama is slow
const MAX_ATTEMPTS = Number(process.env.OLLAMA_MAX_ATTEMPTS || 3);
const API_KEY = process.env.OLLAMA_API_KEY || process.env[providerCfg.keyEnv] || '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Strip ```json fences and grab the outermost {...} if the model wrapped its JSON.
// All failure paths throw a friendly "did not return valid JSON" message (never a
// raw V8 SyntaxError), so chatJson's retry regex can match every JSON failure.
function extractJsonObject(text) {
  let s = String(text).trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  }
  try {
    return JSON.parse(s);
  } catch (_) {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch (_e) {
        // fall through to friendly error
      }
    }
    throw new Error('Model did not return valid JSON. Raw:\n' + s.slice(0, 800));
  }
}

// Build the request + parser for the active provider. Ollama speaks its own
// /api/chat shape; go speaks OpenAI /chat/completions; gemini uses its native
// generateContent API (responseMimeType application/json is strictly enforced,
// unlike the OpenAI-compat layer which leaks non-JSON tokens on lite models).
function buildRequest({ system, user, temperature }) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  if (providerCfg.transport === 'openai') {
    return {
      url: BASE_URL + providerCfg.chatPath,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature,
          response_format: { type: 'json_object' },
        }),
      },
      parse: (data) => {
        const choices = Array.isArray(data.choices) ? data.choices : [];
        const content = choices[0] && choices[0].message && choices[0].message.content;
        if (!content) {
          throw new Error(`${PROVIDER} response missing choices[0].message.content`);
        }
        return content;
      },
    };
  }

  if (providerCfg.transport === 'gemini') {
    return {
      url: `${BASE_URL}/models/${encodeURIComponent(MODEL)}:generateContent`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(API_KEY ? { 'x-goog-api-key': API_KEY } : {}),
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            temperature,
            responseMimeType: 'application/json',
          },
        }),
      },
      parse: (data) => {
        const cand = Array.isArray(data.candidates) ? data.candidates[0] : null;
        const parts = cand && cand.content && cand.content.parts;
        const content = Array.isArray(parts) && parts[0] && parts[0].text;
        if (!content) {
          throw new Error(`${PROVIDER} response missing candidates[0].content.parts[0].text`);
        }
        return content;
      },
    };
  }

  return {
    url: `${BASE_URL}/api/chat`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        think: false,
        format: 'json',
        options: { temperature },
        messages,
      }),
    },
    parse: (data) => {
      const content = data && data.message && data.message.content;
      if (!content) throw new Error('Ollama response missing message.content');
      return content;
    },
  };
}

// One chat turn. Returns the parsed JSON object from message.content.
async function chatJson({ system, user, temperature = 0.2 }) {
  if (providerCfg.transport !== 'ollama' && !API_KEY) {
    throw new Error(
      `${PROVIDER} provider needs an API key — set ${providerCfg.keyEnv} (or OLLAMA_API_KEY).`
    );
  }

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const { url, init, parse } = buildRequest({ system, user, temperature });
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`${PROVIDER} HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = await res.json();
      return extractJsonObject(parse(data));
    } catch (err) {
      lastErr = err;
      const transient =
        err.name === 'AbortError' ||
        /HTTP 5\d\d|ECONNREFUSED|fetch failed|did not return valid JSON|Unexpected token|is not valid JSON|SyntaxError/.test(
          String(err.message)
        );
      if (attempt < MAX_ATTEMPTS && transient) {
        await sleep(1000 * attempt);
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `${PROVIDER} chat failed after ${MAX_ATTEMPTS} attempt(s): ${lastErr && lastErr.message}`
  );
}

module.exports = { chatJson, MODEL, BASE_URL, PROVIDER };