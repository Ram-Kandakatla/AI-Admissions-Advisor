// Worker entry point for both wrangler configs: backend/wrangler.toml (the API
// alone, for local dev) and the root wrangler.toml (deployed, with the built
// frontend as static assets). It lives under backend/ because module
// resolution walks up from the entry file to find hono in backend/node_modules.

import app from "./app.js";

export default app;
