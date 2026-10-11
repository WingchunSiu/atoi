import { MongoClient } from "mongodb";
import { buildApp } from "./app.js";
import { CoordinationStore } from "./store.js";

const uri = process.env.MONGODB_URI;
const database = process.env.MONGODB_DATABASE;
const adminToken = process.env.ADMIN_TOKEN;
if (!uri || !database || !adminToken)
  throw new Error("MONGODB_URI, MONGODB_DATABASE and ADMIN_TOKEN are required");
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be an integer between 1 and 65535");
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
try {
  await client.connect();
  const store = new CoordinationStore(client, client.db(database));
  await store.initialize();
  const app = buildApp(store, adminToken, true);
  app.addHook("onClose", async () => {
    await client.close();
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
  };
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
  await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
} catch {
  await client.close();
  // Do not dump a driver error that could contain credentials or host details.
  process.stderr.write(
    "Coordination service startup failed. Check MongoDB access, indexes, configuration and port availability.\n",
  );
  process.exitCode = 1;
}
