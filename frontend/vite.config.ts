import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend dev server proxies /api to the backend Worker on :8787
// (`wrangler dev`, from backend/).
//
// Phase 7 predicted this proxy would be deleted once Pages served both halves
// from one origin. It stays. Deployed, it is genuinely unused — the Worker
// answers /api itself and this config is not even loaded. But locally there are
// still two servers, because Vite is what gives the frontend hot reload and
// `wrangler dev` is what gives the backend a real D1, and neither Phase 7 nor
// the later move to Workers merged those two processes. What exists instead is
// `npm run preview` at the repo root: one `wrangler dev` serving the built
// frontend and the API together, which is the deployed shape and the thing to
// reach for when a bug looks origin- or routing-related.
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
