import { Client, Connection } from "@temporalio/client";
import { MongoClient } from "mongodb";
import { readConfig } from "../config.js";
import { MongoStore } from "../store/mongo.js";
import { reconcile } from "../temporal/relay.js";
import { createServer } from "./server.js";

const config = readConfig();
const mongo = new MongoClient(config.MONGODB_URI);
await mongo.connect();
const store = new MongoStore(mongo, mongo.db(config.MONGODB_DATABASE), config.AGENT_TOKEN_SECRET);
await store.initialize();
const connection = await Connection.connect({
  address: config.TEMPORAL_ADDRESS,
});
const client = new Client({ connection, namespace: config.TEMPORAL_NAMESPACE });
const server = createServer(store, {
  operatorToken: config.ADMIN_TOKEN,
  agentSecret: config.AGENT_TOKEN_SECRET,
});
let closing = false;
async function relayLoop() {
  while (!closing) {
    try {
      await reconcile(store, client, config.TEMPORAL_TASK_QUEUE);
    } catch (error) {
      console.error(
        `Coordination relay unavailable: ${error instanceof Error ? error.name : "UnknownError"}`,
      );
    }
    if (!closing) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
const relay = relayLoop();
await server.listen({ host: config.API_HOST, port: config.API_PORT });
console.log(`atoi API listening on ${config.API_HOST}:${config.API_PORT}`);
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  await relay;
  await connection.close();
  await mongo.close();
}
process.once("SIGTERM", () => {
  void close();
});
process.once("SIGINT", () => {
  void close();
});
