import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./design-tokens.css";
import "./styles.css";

import {reportFailure} from './support/reporting';
window.addEventListener('error',()=>reportFailure('uncaught'));
window.addEventListener('unhandledrejection',()=>reportFailure('uncaught'));

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

const isVaultSpike = new URLSearchParams(window.location.search).get("vaultSpike") === "1";
const isOnboarding = new URLSearchParams(window.location.search).get("onboarding") === "1";
const isBrowserMailbox = new URLSearchParams(window.location.search).get("browserMailbox") === "1";

if (window.location.pathname === "/feedback") {
  void import("./support/Feedback").then(({Feedback})=>createRoot(root).render(<StrictMode><Feedback /></StrictMode>));
} else if (window.location.pathname === "/delete-account") {
  void import("./account/AccountDeletion").then(({AccountDeletion}) => {
    createRoot(root).render(<StrictMode><AccountDeletion /></StrictMode>);
  });
} else if (isVaultSpike) {
  void import("./vault-spike/VaultSpikeApp").then(({ VaultSpikeApp }) => {
    createRoot(root).render(<StrictMode><VaultSpikeApp /></StrictMode>);
  });
} else if (new URLSearchParams(window.location.search).get("cloudVault") === "1") {
  void import("./onboarding/OnboardingApp").then(({ OnboardingApp }) => {
    createRoot(root).render(<StrictMode><OnboardingApp /></StrictMode>);
  });
} else if (isBrowserMailbox || isOnboarding || new URLSearchParams(window.location.search).get("cloudMailbox") === "1" || ["/app", "/app/"].includes(window.location.pathname)) {
  void import("./mail/BrowserMailboxApp").then(({ BrowserMailboxApp }) => {
    createRoot(root).render(<StrictMode><BrowserMailboxApp /></StrictMode>);
  });
} else if (!import.meta.env.PROD) {
  void import("./App").then(({ App }) => {
    createRoot(root).render(<StrictMode><App /></StrictMode>);
  });
} else {
  void import("./mail/BrowserMailboxApp").then(({ BrowserMailboxApp }) => {
    createRoot(root).render(<StrictMode><BrowserMailboxApp /></StrictMode>);
  });
}
