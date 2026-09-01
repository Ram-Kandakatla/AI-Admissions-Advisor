import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend dev server proxies /api to the backend Worker on :8787
// (`wrangler dev`, from backend/). Phase 7 removes the proxy entirely when
// Pages serves the frontend and the API from one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
