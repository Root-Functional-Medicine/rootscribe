import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Vite 8 bind the default `localhost` host to IPv6 only (::1), so a
    // caller hitting http://127.0.0.1:44470 (IPv4) hangs — exactly what
    // playwright.config.ts does. Pin to 127.0.0.1 so `pnpm test:e2e` in
    // local mode works without waiting for the webServer timeout.
    host: "127.0.0.1",
    port: 44470,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:44471", changeOrigin: false },
      "/media": { target: "http://127.0.0.1:44471", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
