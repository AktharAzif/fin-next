// The kit's entry. The theme comes from ?theme=light|dark (else the system's); data-ready on <body>
// tells the Playwright spec the page has rendered.
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Kit } from "./kit.tsx";

declare const __FIN_KIT__: boolean;

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
if (theme === "light" || theme === "dark")
  document.documentElement.setAttribute("data-theme", theme);

const root = document.getElementById("root");
if (root !== null && __FIN_KIT__) {
  createRoot(root).render(
    <StrictMode>
      <Kit onReady={() => document.body.setAttribute("data-ready", "")} />
    </StrictMode>,
  );
}
