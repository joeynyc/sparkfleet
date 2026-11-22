import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API_PORT = Number(process.env.SPARKFLEET_PORT || 7700);
const API_HOST = `127.0.0.1:${API_PORT}`;

// The control plane only accepts its own Host and Origin, so the dev proxy
// presents both. The session cookie is still required and is never forged here.
const proxyToApi = {
  target: `http://${API_HOST}`,
  changeOrigin: true,
  headers: { origin: `http://${API_HOST}` },
};

export default defineConfig({
  plugins: [react()],
  server: {
    // Same hostname as the control plane, so the session cookie is shared.
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": proxyToApi,
      "/ws": { ...proxyToApi, ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
