import { createRoot } from "react-dom/client";
import "./tokens.css";
import "./styles.css";
import { App } from "./app.js";
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
