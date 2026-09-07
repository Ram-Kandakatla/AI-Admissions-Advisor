import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend dev server proxies /api to the backend Worker on :8787
// (`wrangler dev`, from backend/).
//
// Phase 7 predicted this proxy would be deleted once Pages served both halves
// from one origin. It stays. Deployed, it is genuinely unused — Pages routes
// /api to the Function itself and this config is not even loaded. But locally
// there are still two servers, because Vite is what gives the frontend hot
// reload and `wrangler dev` is what gives the backend a real D1, and nothing
// about Phase 7 merged those two processes. What Phase 7 added instead is
// `npm run preview` at the repo root: one `wrangler pages dev` serving the
// built frontend and the Function together, which is the deployed shape and
// the thing to reach for when a bug looks origin- or routing-related.
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
