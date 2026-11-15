import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

async function boot() {
  // Development-only browser preview with recorded fixtures (removed from production builds).
  if (import.meta.env.DEV && import.meta.env.VITE_RESONA_MOCK === "1") {
    const mock = await import("./dev/mock");
    mock.installMocks();
    const { useStore } = await import("./store");
    const unsub = useStore.subscribe((st) => {
      if (st.ready && st.engineInfo) {
        unsub();
        void mock.runScenario(useStore);
      }
    });
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
