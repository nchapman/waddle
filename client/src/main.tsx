import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider } from "betterbase/auth/react";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";
import { App } from "./App";

const BB_DOMAIN = import.meta.env.VITE_BETTERBASE_DOMAIN ?? "localhost:5377";
const BB_CLIENT_ID = import.meta.env.VITE_BETTERBASE_CLIENT_ID ?? "";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider
      domain={BB_DOMAIN}
      clientId={BB_CLIENT_ID}
      scope="openid sync"
      storagePrefix="betterbase_session_waddle_"
    >
      <App />
    </AuthProvider>
  </StrictMode>,
);
