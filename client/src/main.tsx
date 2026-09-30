import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { startErrorTracking } from "./lib/errorTracking";
import "./styles.css";

startErrorTracking();

const container = document.getElementById("root");
if (!container) throw new Error("#root container is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
