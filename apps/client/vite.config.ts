import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3001';

// The dev server proxies REST and Socket.IO (including the WebSocket upgrade) to the API,
// so the browser talks to a single origin and the session cookie stays first-party.
const proxy = {
  '/api': { target: apiTarget },
  '/health': { target: apiTarget },
  '/socket.io': { target: apiTarget, ws: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: { port: Number(process.env.CLIENT_PORT ?? 5173), strictPort: true, proxy },
  preview: { port: Number(process.env.CLIENT_PORT ?? 4173), strictPort: true, proxy },
});
