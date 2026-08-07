// Vercel Node function: POST /api/llm — the production mount of the LLM relay.
// The dev server mounts the same handler as middleware (see vite.config.js).
export { default } from './_llmProxy.js';
