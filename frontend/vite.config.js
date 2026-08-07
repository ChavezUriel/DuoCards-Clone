import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { llmProxyHandler } from './api/_llmProxy.js';

// The app talks directly to Supabase (Auth + Postgres RPC); there is no local
// API server to proxy to anymore. The one exception is the AI deck builder's
// LLM relay (/api/llm), which exists because some providers refuse browser
// calls — in production it is the Vercel function frontend/api/llm.js, and in
// dev this plugin mounts the very same handler on the dev server.
function llmProxyPlugin() {
  return {
    name: 'ai-deck-builder-llm-proxy',
    configureServer(server) {
      server.middlewares.use('/api/llm', (req, res, next) => {
        llmProxyHandler(req, res).catch(next);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), llmProxyPlugin()],
  server: {
    host: '0.0.0.0',
    // PORT is set by tooling (e.g. preview sessions); default stays 5173.
    port: Number(process.env.PORT) || 5173,
  },
});
