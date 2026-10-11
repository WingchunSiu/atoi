import { build } from "esbuild";

await build({
  entryPoints: {
    worker: "src/agent/worker.ts",
    "modal-fixture": "scripts/modal-fixture.ts",
  },
  outdir: "dist/guest",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
});
