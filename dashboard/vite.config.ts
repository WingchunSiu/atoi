/// <reference types="vitest/config" />

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_API_TARGET || "http://localhost:8787";
  return {
    plugins: [react(), tailwindcss()],
    server: { proxy: { "/api": { target, changeOrigin: true } } },
    test: { include: ["tests/**/*.test.ts"], environment: "node" },
  };
});
