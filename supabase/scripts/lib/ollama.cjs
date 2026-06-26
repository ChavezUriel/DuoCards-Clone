// Minimal Ollama chat client for the card generator.
// Talks to the local Ollama /api/chat endpoint and expects a JSON object back
// (format: "json"). For now the model is hardcoded to gpt-oss:20b; MODEL is a
// single const so adding a fallback chain later is a one-line change.
//
// Requires Node 18+ (global fetch / AbortController).

const MODEL = process.env.OLLAMA_MODEL || 'gpt-oss:20b';
const BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 600000); // 10 min; model is slow
const MAX_ATTEMPTS = Number(process.env.OLLAMA_MAX_ATTEMPTS || 3);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Strip ```json fences and grab the outermost {...} if the model wrapped its JSON.
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
      return JSON.parse(s.slice(start, end + 1));
    }
    throw new Error('Model did not return valid JSON. Raw:\n' + s.slice(0, 800));
  }
}

// One chat turn. Returns the parsed JSON object from message.content.
async function chatJson({ system, user, temperature = 0.2 }) {
  const payload = {
    model: MODEL,
    stream: false,
    think: false,
    format: 'json',
    options: { temperature },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = await res.json();
      const content = data && data.message && data.message.content;
      if (!content) throw new Error('Ollama response missing message.content');
      return extractJsonObject(content);
    } catch (err) {
      lastErr = err;
      const transient = err.name === 'AbortError' || /HTTP 5\d\d|ECONNREFUSED|fetch failed|did not return valid JSON/.test(String(err.message));
      if (attempt < MAX_ATTEMPTS && transient) {
        await sleep(1000 * attempt);
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Ollama chat failed after ${MAX_ATTEMPTS} attempt(s): ${lastErr && lastErr.message}`);
}

module.exports = { chatJson, MODEL, BASE_URL };
