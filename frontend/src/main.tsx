import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./styles/global.css";

// BrowserRouter, not HashRouter: /matches is an address someone can read out
// loud, and Cloudflare Pages serves the SPA fallback that makes it resolve on
// a cold load (see public/_redirects).
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
