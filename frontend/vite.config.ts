import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:3001", changeOrigin: true } },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/leaflet")) return "map";
          if (id.includes("node_modules/qrcode")) return "qrcode";
          if (/node_modules\/(react|react-dom|react-router|scheduler)/.test(id))
            return "react";
          if (/frontend\/src\/shared\/(city-catalog|china-cities)/.test(id))
            return "cities";
        },
      },
    },
  },
});
