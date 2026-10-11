import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { mkdir } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { ModalClient } from "modal";
import { MongoClient } from "mongodb";
import { createServer } from "../src/api/server.js";
import { readConfig } from "../src/config.js";
import { ModalAgents } from "../src/modal/provider.js";
import { MongoStore } from "../src/store/mongo.js";
import { createActivities } from "../src/temporal/activities.js";
import { reconcile } from "../src/temporal/relay.js";

// Interactive local development: real Atlas, model and Modal; stays up between objectives.
process.env.BACKEND_PUBLIC_URL ??= "http://127.0.0.1:3200";
const config = readConfig();
if (!Object.keys(config.GITHUB_REPOSITORIES).length)
  throw new Error("Configure GITHUB_REPOSITORIES before starting the live app");
const port = Number(process.env.LIVE_API_PORT ?? 3200);
const stateDirectory = resolve(".atoi/live");
await mkdir(stateDirectory, { recursive: true });
const controlPlaneId = createHash("sha256").update(stateDirectory).digest("hex");
let tunnel: ChildProcess | undefined;
async function publicBackendReady(backendUrl: string): Promise<boolean> {
  // Fresh tunnel names can remain negatively cached by macOS getaddrinfo.
  // Query DNS directly, preserving the original hostname for TLS and HTTP.
  return new Promise((resolve) => {
    const request = httpsGet(
      new URL("/health", backendUrl),
      {
        family: 4,
        lookup: (hostname, _options, callback) => {
          resolve4(hostname).then(
            (addresses) => callback(null, addresses[0]!, 4),
            (error: Error) => callback(error, "", 4),
          );
        },
        timeout: 3000,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on("timeout", () => request.destroy(new Error("Health request timed out")));
    request.on("error", () => resolve(false));
  });
}
async function startTunnel(localUrl: string): Promise<string> {
  const executable = process.env.CLOUDFLARED_PATH ?? "cloudflared";
  tunnel = spawn(
    executable,
    ["tunnel", "--url", localUrl, "--no-autoupdate", "--protocol", "http2"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Cloudflare tunnel startup timed out")), 45000);
    let buffer = "";
    const consume = (chunk: Buffer) => {
      buffer = (buffer + chunk.toString()).slice(-16000);
      const url = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (url) {
        clearTimeout(timer);
        resolve(url[0]);
      }
    };
    tunnel!.stderr!.on("data", consume);
    tunnel!.stdout!.on("data", consume);
    tunnel!.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    tunnel!.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Cloudflare tunnel exited before readiness"));
    });
  });
}
Runtime.install({ logger: new DefaultLogger("ERROR") });
const mongo = new MongoClient(config.MONGODB_URI);
const modal = new ModalClient();
let temporal: TestWorkflowEnvironment | undefined;
let worker: Worker | undefined;
let workerRun: Promise<void> | undefined;
let api: ReturnType<typeof createServer> | undefined;
let closing = false;
let relay: Promise<void> | undefined;
let store: MongoStore | undefined;
const taskQueue = `atoi-local-${controlPlaneId.slice(0, 16)}`;
const owned = { controlPlaneId };
async function reconcileOwned() {
  for (const run of await store!.runs
    .find({ ...owned, status: { $in: ["active", "stopping"] } })
    .toArray())
    await reconcile(store!, temporal!.client, taskQueue, run._id);
}
async function close(stopTeams = true) {
  if (closing) return;
  closing = true;
  await relay;
  // Graceful launcher shutdown stops only teams this launcher created.
  if (stopTeams && store && temporal && worker) {
    for (const run of await store.runs.find({ ...owned, status: "active" }).toArray())
      await store.stopRun(run._id);
    const until = Date.now() + 120000;
    while (
      Date.now() < until &&
      (await store.runs.countDocuments({ ...owned, status: "stopping" }))
    ) {
      await reconcileOwned();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (await store.runs.countDocuments({ ...owned, status: "stopping" }))
      console.error("Cleanup pending; restart this launcher to retry the recorded failures.");
  }
  if (worker?.getState() === "RUNNING") worker.shutdown();
  await workerRun?.catch(() => undefined);
  await api?.close();
  tunnel?.kill();
  await temporal?.teardown();
  modal.close();
  await mongo.close();
}
try {
  await mongo.connect();
  store = new MongoStore(
    mongo,
    mongo.db(config.MONGODB_DATABASE),
    config.AGENT_TOKEN_SECRET,
    controlPlaneId,
  );
  await store.initialize();
  temporal = await TestWorkflowEnvironment.createLocal({
    server: { extraArgs: ["--db-filename", resolve(stateDirectory, "temporal.db")] },
  });
  api = createServer(
    store,
    { operatorToken: config.ADMIN_TOKEN, agentSecret: config.AGENT_TOKEN_SECRET },
    config.GITHUB_REPOSITORIES,
  );
  const localUrl = await api.listen({ host: "127.0.0.1", port });
  console.log(`API listening: ${localUrl}`);
  const backendUrl = process.env.LIVE_BACKEND_URL ?? (await startTunnel(localUrl));
  const until = Date.now() + 60000;
  while (!(await publicBackendReady(backendUrl))) {
    if (Date.now() > until) throw new Error("Public backend readiness timed out");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const provider = new ModalAgents(modal, {
    appName: config.MODAL_APP_NAME,
    imageTag: config.MODAL_IMAGE_TAG,
    modelSecret: config.MODAL_MODEL_SECRET,
    modelApiKey: config.ATOI_MODEL_API_KEY,
    repositorySecrets: config.GITHUB_REPOSITORIES,
  });
  worker = await Worker.create({
    connection: temporal.nativeConnection,
    taskQueue,
    workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)),
    activities: createActivities(store, provider, { ...config, BACKEND_PUBLIC_URL: backendUrl }),
    maxConcurrentActivityTaskExecutions: 4,
  });
  workerRun = worker.run();
  relay = (async () => {
    while (!closing) {
      try {
        await reconcileOwned();
      } catch (error) {
        console.error(
          `Coordination retry pending: ${error instanceof Error ? error.name : "unknown"}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  })();
  process.once("SIGUSR2", () => void close(false));
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  console.log(`Live app ready. Start UI: VITE_API_TARGET=${localUrl} pnpm dev:dashboard`);
  console.log(
    "Objectives leave teams available. Stop or team deadlines clean up sandboxes. Ctrl-C stops this launcher's teams and services.",
  );
  await workerRun;
} catch (error) {
  console.error(
    `Live app startup/runtime failed: ${error instanceof Error ? error.name : "unknown"}`,
  );
  process.exitCode = 1;
} finally {
  await close();
}
