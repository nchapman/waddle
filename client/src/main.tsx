import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider } from "betterbase/auth/react";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";
import { App } from "./App";
import { BB_CLIENT_ID, BB_DOMAIN } from "./lib/config";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider
      domain={BB_DOMAIN}
      clientId={BB_CLIENT_ID}
      scope="openid sync files"
      storagePrefix="betterbase_session_waddle_"
    >
      <App />
    </AuthProvider>
  </StrictMode>,
);
