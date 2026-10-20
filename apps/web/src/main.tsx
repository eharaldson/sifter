import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

console.log("🚀 Main.tsx loaded");

const rootElement = document.getElementById("root");
console.log("📍 Root element:", rootElement);

if (!rootElement) {
  console.error("❌ Root element not found!");
} else {
  console.log("✅ Root element found, creating React root");
  try {
    const root = createRoot(rootElement);
    console.log("✅ React root created, rendering App");
    root.render(<App />);
    console.log("✅ App rendered successfully");
  } catch (error) {
    console.error("❌ Error creating root or rendering App:", error);
  }
}
