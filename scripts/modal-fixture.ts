import { AgentBackend } from "../src/agent/backend.js";
import { executeTurn } from "../src/agent/runtime.js";
import { workerRequest } from "../src/contracts/runtime.js";
import { scriptedPi, tool } from "../tests/scripted-pi.js";

// Cloud smoke fixture only: real Pi + real Modal, scripted model and backend.
// This file is never copied into production agent sandboxes by ModalAgents.
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { request: raw, stage } = JSON.parse(input) as {
  request: unknown;
  stage: "first" | "second";
};
const request = workerRequest.parse(raw);
class FixtureBackend extends AgentBackend {
  override async request(path: string): Promise<unknown> {
    return path.startsWith("/agents")
      ? { items: [{ _id: "fixture-reviewer", role: "reviewer" }] }
      : { _id: "fixture-channel", accepted: true, fixture: true };
  }
}
let restoredContext = false;
let nativeTools: string[] = [];
const result = await executeTurn(request, {
  workspace: "/workspace/repo",
  stateDirectory: "/var/lib/atoi/smoke",
  backend: new FixtureBackend(request),
  async configureSession(session) {
    nativeTools = session.getActiveToolNames();
    await scriptedPi(
      session,
      stage === "first"
        ? [
            [
              tool("write-memory", "write", {
                path: "atoi-memory.txt",
                content: "The recovery marker is violet-raven.",
              }),
            ],
            [
              tool("peer-message", "send_message", {
                recipientId: "fixture-reviewer",
                body: "Please verify violet-raven.",
              }),
            ],
            "Remember violet-raven and consult the reviewer on the next task.",
          ]
        : [
            [tool("read-memory", "read", { path: "atoi-memory.txt" })],
            "I retained the workspace and the prior conversation about violet-raven.",
          ],
      (context) => {
        if (context.includes("Remember violet-raven")) restoredContext = true;
      },
    );
  },
});
process.stdout.write(JSON.stringify({ result, restoredContext, nativeTools }));
