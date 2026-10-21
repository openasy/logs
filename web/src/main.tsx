import "@openasy/ui/styles.css";
import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { followLinks } from "@openasy/ui";
import { App, PAGES } from "./App.tsx";

followLinks(PAGES);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
