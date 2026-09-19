import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
// Before global.css, so the @font-face rules are registered by the time the
// first rule that names a family is parsed. Self-hosted from public/fonts —
// see scripts/fetch-fonts.mjs for why, and regenerate rather than editing.
import "./styles/fonts.css";
import "./styles/global.css";

// BrowserRouter, not HashRouter: /matches is an address someone can read out
// loud, and the deployed Worker serves the SPA fallback that makes it resolve
// on a cold load (`not_found_handling` in the root wrangler.toml).
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Outside the router, so it also catches a throw in Layout or in the
        route matching itself — the cases the boundary inside Layout is, by
        definition, too deep to see. It renders the same card without the
        chrome around it. */}
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
