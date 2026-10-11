import { mkdir } from "node:fs/promises";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";

await mkdir(".cache/mongodb", { recursive: true });
const replica = await MongoMemoryReplSet.create({
  binary: { version: "8.2.3", downloadDir: ".cache/mongodb" },
  instanceOpts: [{ port: 27017 }],
  replSet: { count: 1, ip: "127.0.0.1", storageEngine: "wiredTiger" },
});
console.log(
  "Temporary local MongoDB replica set on 127.0.0.1:27017. Data is discarded when stopped.",
);
await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await replica.stop();
