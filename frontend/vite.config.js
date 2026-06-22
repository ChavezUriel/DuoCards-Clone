import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app talks directly to Supabase (Auth + Postgres RPC); there is no local
// API server to proxy to anymore.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
