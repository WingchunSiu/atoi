import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { ModalClient } from "modal";
import { MongoClient } from "mongodb";
import { readConfig } from "../config.js";
import { ModalAgents } from "../modal/provider.js";
import { MongoStore } from "../store/mongo.js";
import { createActivities } from "./activities.js";

const config = readConfig();
const mongo = new MongoClient(config.MONGODB_URI);
await mongo.connect();
const store = new MongoStore(mongo, mongo.db(config.MONGODB_DATABASE), config.AGENT_TOKEN_SECRET);
await store.initialize();
const modalClient = new ModalClient();
const modal = new ModalAgents(modalClient, {
  appName: config.MODAL_APP_NAME,
  imageTag: config.MODAL_IMAGE_TAG,
  modelSecret: config.MODAL_MODEL_SECRET,
  modelApiKey: config.ATOI_MODEL_API_KEY,
  gitSecret: config.MODAL_GIT_SECRET,
});
const connection = await NativeConnection.connect({
  address: config.TEMPORAL_ADDRESS,
});
try {
  const worker = await Worker.create({
    connection,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: config.TEMPORAL_TASK_QUEUE,
    workflowsPath: fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts") ? "./workflows.ts" : "./workflows.js",
        import.meta.url,
      ),
    ),
    activities: createActivities(store, modal, config),
    maxConcurrentActivityTaskExecutions: 4,
  });
  await worker.run();
} finally {
  modalClient.close();
  await connection.close();
  await mongo.close();
}
