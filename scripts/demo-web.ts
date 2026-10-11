// Local live browser demo: real Atlas, Modal, Pi and model inference.
// The browser is a client; this process and Temporal own run lifetime.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

await mkdir(".atoi", { recursive: true });
const credentialPath = ".atoi/browser-credentials.json";
let credentials: { operatorToken: string; agentSecret: string };
try {
  credentials = JSON.parse(await readFile(credentialPath, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  credentials = {
    operatorToken: randomBytes(32).toString("hex"),
    agentSecret: randomBytes(32).toString("hex"),
  };
  await writeFile(credentialPath, JSON.stringify(credentials), { mode: 0o600 });
}
process.env.ADMIN_TOKEN ??= credentials.operatorToken;
process.env.AGENT_TOKEN_SECRET ??= credentials.agentSecret;
process.env.BACKEND_PUBLIC_URL ??= "http://127.0.0.1:3000";
process.env.PI_PROVIDER ??= "openai";
process.env.PI_MODEL ??= "gpt-4.1";
const config = readConfig();
const dbName = process.env.UI_DEMO_DATABASE ?? config.MONGODB_DATABASE;
const taskQueue = "atoi-browser-demo-v1";
let tunnel: ChildProcess | undefined;
let vite: ChildProcess | undefined;
let worker: Worker | undefined;
let workerRun: Promise<void> | undefined;
let temporal: TestWorkflowEnvironment | undefined;
let api: ReturnType<typeof createServer> | undefined;
let timer: NodeJS.Timeout | undefined;
let closing = false;
let relayBusy = false;
const mongo = new MongoClient(config.MONGODB_URI);
const modalClient = new ModalClient();
let store: MongoStore | undefined;
async function relay() {
  if (relayBusy || closing || !temporal || !store) return;
  relayBusy = true;
  try {
    await reconcile(store, temporal.client, taskQueue);
  } catch (error) {
    console.error(`Relay unavailable: ${error instanceof Error ? error.name : "unknown error"}`);
  } finally {
    relayBusy = false;
  }
}
async function close() {
  if (closing) return;
  closing = true;
  if (timer) clearInterval(timer);
  if (store && temporal) {
    for (const run of await store.runs
      .find({ status: { $in: ["active", "completing"] } })
      .toArray())
      await store.stopRun(run._id);
    for (let i = 0; i < 60; i++) {
      await reconcile(store, temporal.client, taskQueue);
      if (!(await store.runs.countDocuments({ status: "stopping" }))) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  vite?.kill("SIGTERM");
  if (worker) {
    worker.shutdown();
    await workerRun?.catch(() => undefined);
  }
  await api?.close();
  tunnel?.kill("SIGTERM");
  await temporal?.teardown();
  modalClient.close();
  await mongo.close();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
try {
  await mkdir(".atoi", { recursive: true });
  await mongo.connect();
  store = new MongoStore(mongo, mongo.db(dbName), config.AGENT_TOKEN_SECRET, "browser_");
  await store.initialize();
  Runtime.install({ logger: new DefaultLogger("ERROR") });
  temporal = await TestWorkflowEnvironment.createLocal({
    server: { dbFilename: fileURLToPath(new URL("../.atoi/browser-temporal.db", import.meta.url)) },
  });
  api = createServer(store, {
    operatorToken: config.ADMIN_TOKEN,
    agentSecret: config.AGENT_TOKEN_SECRET,
  });
  const localUrl = await api.listen({ host: "127.0.0.1", port: 3000 });
  tunnel = spawn(
    process.env.CLOUDFLARED_PATH ?? "cloudflared",
    ["tunnel", "--url", localUrl, "--no-autoupdate", "--protocol", "http2"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const publicUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Tunnel startup timed out")), 45000);
    let text = "";
    const consume = (chunk: Buffer) => {
      text = (text + chunk.toString()).slice(-16000);
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    };
    tunnel!.stdout!.on("data", consume);
    tunnel!.stderr!.on("data", consume);
    tunnel!.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  const provider = new ModalAgents(modalClient, {
    appName: config.MODAL_APP_NAME,
    imageTag: config.MODAL_IMAGE_TAG,
    modelSecret: config.MODAL_MODEL_SECRET,
    modelApiKey: config.ATOI_MODEL_API_KEY ?? process.env.OPENAI_API_KEY,
    gitSecret: config.MODAL_GIT_SECRET,
  });
  worker = await Worker.create({
    connection: temporal.nativeConnection,
    taskQueue,
    workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)),
    activities: createActivities(store, provider, { ...config, BACKEND_PUBLIC_URL: publicUrl }),
    maxConcurrentActivityTaskExecutions: 4,
  });
  workerRun = worker.run();
  timer = setInterval(() => void relay(), 1000);
  vite = spawn("pnpm", ["--filter", "atoi-dashboard", "dev"], {
    stdio: "inherit",
    env: { ...process.env, VITE_API_TARGET: localUrl, VITE_DEFAULT_SOURCE: "live" },
  });
  vite.once("exit", () => {
    if (!closing) void close();
  });
  console.log(
    `LIVE browser demo: http://127.0.0.1:5173 · Atlas ${dbName}, isolated browser_* collections`,
  );
  console.log(
    "Isolated browser_* demo records; no automatic reset. Ctrl-C stops its active runs and compute.",
  );
} catch (error) {
  console.error(
    `Browser demo startup failed: ${error instanceof Error ? error.name : "unknown error"}`,
  );
  await close();
  process.exitCode = 1;
}
