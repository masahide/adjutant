import { createRoot } from "react-dom/client";

import App from "./App.js";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("root element is required");
}

const systemDarkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function applySystemTheme(isDark: boolean): void {
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.style.colorScheme = isDark ? "dark" : "light";
}

applySystemTheme(systemDarkQuery.matches);

const handleThemeChange = (event: MediaQueryListEvent): void => {
  applySystemTheme(event.matches);
};

if (typeof systemDarkQuery.addEventListener === "function") {
  systemDarkQuery.addEventListener("change", handleThemeChange);
} else {
  systemDarkQuery.addListener(handleThemeChange);
}

createRoot(rootElement).render(<App />);
