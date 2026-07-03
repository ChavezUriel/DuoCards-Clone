import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app talks directly to Supabase (Auth + Postgres RPC); there is no local
// API server to proxy to anymore.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    // PORT is set by tooling (e.g. preview sessions); default stays 5173.
    port: Number(process.env.PORT) || 5173,
  },
});
