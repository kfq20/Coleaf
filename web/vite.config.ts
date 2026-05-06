import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind on all interfaces so a tunnel (ngrok / cloudflared) can reach us.
    host: true,
    // Accept any Host header — needed when the browser hits us through a
    // tunnel like ngrok with a hostname that isn't `localhost`.
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
