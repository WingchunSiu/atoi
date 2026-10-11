import { workerRequest } from "../contracts/runtime.js";
import { executeTurn } from "./runtime.js";

// Invoked only inside the assigned guest. No runner filesystem tools are exposed.
const chunks: Buffer[] = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 8_000_000) throw new Error("Invocation payload exceeds the worker limit");
  chunks.push(chunk);
}
try {
  const request = workerRequest.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const result = await executeTurn(request, {
    workspace: "/workspace/repo",
    stateDirectory: "/var/lib/atoi",
  });
  process.stdout.write(JSON.stringify(result));
} catch {
  // Request bodies can contain credentials. Detailed errors are surfaced by recorded
  // invocation results, never by dumping the input or environment to process logs.
  process.stderr.write(
    "Agent worker failed before producing a confirmed result; inspect invocation state.\n",
  );
  process.exitCode = 1;
}
