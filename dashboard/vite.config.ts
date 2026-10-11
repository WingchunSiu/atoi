/// <reference types="vitest/config" />

import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = {
    ...loadEnv(mode, path.resolve(process.cwd(), ".."), ""),
    ...loadEnv(mode, process.cwd(), ""),
    ...process.env,
  };
  const target = env.VITE_API_TARGET || "http://127.0.0.1:3000";
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "local-operator-gateway",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/api/")) return next();
            const origin = req.headers.origin;
            if (
              (origin && origin !== `http://${req.headers.host}`) ||
              (!["GET", "HEAD"].includes(req.method ?? "GET") &&
                req.headers["x-atoi-browser"] !== "1")
            ) {
              res.statusCode = 403;
              res.end("Same-origin browser request required");
              return;
            }
            if (!env.ADMIN_TOKEN) {
              res.statusCode = 503;
              res.end("Configure ADMIN_TOKEN on the local gateway");
              return;
            }
            next();
          });
        },
      },
    ],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target,
          changeOrigin: true,
          rewrite: (url) => url.replace(/^\/api/, "/operator"),
          headers: { authorization: `Bearer ${env.ADMIN_TOKEN ?? ""}` },
        },
      },
    },
    test: { include: ["tests/**/*.test.ts"], environment: "node" },
  };
});
