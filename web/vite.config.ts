import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/operator": "http://127.0.0.1:3000" },
  },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
