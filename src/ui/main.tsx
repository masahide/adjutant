import { createRoot } from "react-dom/client";

import App from "./App.js";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("root element is required");
}

createRoot(rootElement).render(<App />);
