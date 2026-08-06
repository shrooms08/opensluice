import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const gateway = process.env.OPENSLUICE_GATEWAY_URL ?? "http://localhost:8080";

// Single-page app: the swap widget (/) and the swap progress page (/swap/:id)
// share one bundle; a tiny pathname router picks the screen.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": gateway,
      "/dev": gateway,
      // Browser navigations (Accept: text/html) render the local dev page
      // with HMR; data requests (JSON + SSE) fall through to the gateway.
      "/swap": {
        target: gateway,
        bypass(req) {
          if (req.headers.accept?.includes("text/html")) return "/index.html";
          return undefined;
        },
      },
    },
  },
});
