// Server-side relay for LLM providers the browser cannot call directly.
//
// Why it exists: OpenCode Zen does not answer CORS preflight requests, so a
// page-origin fetch with an Authorization header never reaches it. OpenAI,
// Anthropic and Gemini DO allow browser calls and are used directly by default
// (the key then only ever travels to the provider) — this relay is their
// fallback for locked-down networks.
//
// It holds no credentials of its own: the caller supplies the API key per
// request, it is used once for the upstream call, never logged, never stored.
// Forwarding is restricted to the known provider hosts so the endpoint cannot
// be turned into a general-purpose proxy.
//
// Mounted twice from one implementation:
//   * `npm run dev`  — as Vite dev-server middleware (see vite.config.js)
//   * production     — as the Vercel Node function frontend/api/llm.js
//
// Both hosts hand us Node-style (req, res), so this file speaks that.

import {
  buildLlmRequest,
  parseLlmResponse,
  buildModelsRequest,
  parseModelsResponse,
  isAllowedUpstream,
  describeUpstreamError,
} from '../src/ai/transport.js';

const MAX_BODY_BYTES = 512 * 1024;
const UPSTREAM_TIMEOUT_MS = 180_000;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  // The page and this endpoint are same-origin in both deployments; no CORS
  // headers on purpose, so the relay is not usable from other origins.
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  // Vercel pre-parses JSON bodies; the Vite dev server does not.
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) return JSON.parse(req.body);

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function llmProxyHandler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (parseError) {
    sendJson(res, 400, { error: `Invalid request body: ${parseError.message}` });
    return;
  }

  const { op, transport, baseUrl, model, apiKey, system, user, temperature, maxTokens } = payload;
  const wantsModels = op === 'models';
  if (!transport || !baseUrl || !apiKey || (!wantsModels && (!model || !user))) {
    sendJson(res, 400, { error: 'transport, baseUrl, model, apiKey and user are required' });
    return;
  }

  const request = wantsModels
    ? buildModelsRequest({ transport, baseUrl, apiKey })
    : buildLlmRequest({ transport, baseUrl, model, apiKey, system, user, temperature, maxTokens });

  if (!isAllowedUpstream(request.url)) {
    sendJson(res, 400, { error: `Refusing to forward to ${baseUrl} — not a known provider host` });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(request.url, {
      method: wantsModels ? 'GET' : 'POST',
      headers: request.headers,
      ...(wantsModels ? {} : { body: JSON.stringify(request.body) }),
      signal: controller.signal,
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      // Pass the provider's status through so the client's retry logic can tell
      // a rate limit from a bad key.
      sendJson(res, upstream.status, { error: describeUpstreamError(upstream.status, text) });
      return;
    }
    const data = JSON.parse(text);
    sendJson(
      res,
      200,
      wantsModels ? { models: parseModelsResponse(transport, data) } : parseLlmResponse(transport, data),
    );
  } catch (requestError) {
    const aborted = requestError?.name === 'AbortError';
    sendJson(res, aborted ? 504 : 502, {
      error: aborted
        ? `Provider did not respond within ${Math.round(UPSTREAM_TIMEOUT_MS / 1000)}s`
        : `Could not reach the provider: ${requestError.message}`,
    });
  } finally {
    clearTimeout(timer);
  }
}

export default llmProxyHandler;
