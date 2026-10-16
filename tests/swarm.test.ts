import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { executePiTurn } from "../src/harness/pi-runtime.js";
import { runSwarm } from "../src/harness/swarm.js";
import { swarmConfig } from "../src/harness/swarm-config.js";
import { scriptedPi, tool } from "./scripted-pi.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "atoi-swarm-"));
  roots.push(root);
  const config = swarmConfig.parse({
    controlRoot: path.join(root, "control"),
    objective: "Produce and review answer.txt.",
    communication: "hybrid",
    placement: {
      runId: "team",
      environments: [{ id: "host", stateRoot: path.join(root, "sessions") }],
      workspaces: [
        {
          id: "common",
          environmentId: "host",
          path: path.join(root, "workspace"),
          access: "shared",
        },
      ],
      agents: ["alice", "bob"].map((id) => ({ id, workspaceId: "common" })),
    },
    agents: ["alice", "bob"].map((id) => ({ id, provider: "openai", model: "gpt-4.1" })),
    limits: {
      concurrency: 1,
      turns: 8,
      messages: 12,
      wallTimeMs: 20_000,
      invocation: { timeoutMs: 10_000, toolCalls: 8, modelRequests: 8 },
    },
  });
  return { root, config };
}

it("runs a Pi peer handoff, shared artifact review and checkpointed reply without external services", async () => {
  const { root, config } = await fixture();
  let aliceTurns = 0;
  let restored = "";
  const result = await runSwarm(config, {
    execute: (request, options) =>
      executePiTurn(request, {
        ...options,
        async configureSession(session) {
          if (request.agentId === "alice" && aliceTurns++ === 0) {
            await scriptedPi(session, [
              [tool("write", "write", { path: "answer.txt", content: "42" })],
              [tool("send", "send_message", { to: "bob", body: "Please review answer.txt." })],
              // Simulate a repeated tool call ID: one durable message and wakeup.
              [tool("send", "send_message", { to: "bob", body: "Please review answer.txt." })],
              "Alice private context marker.",
            ]);
          } else if (request.agentId === "bob") {
            expect(request.prompt).toContain("Please review answer.txt.");
            await scriptedPi(
              session,
              [
                [tool("read", "read", { path: "answer.txt" })],
                [
                  tool("review", "write", {
                    path: "review.txt",
                    content: "Verified the value is 42.",
                  }),
                ],
                [
                  tool("reply", "send_message", {
                    to: "alice",
                    body: "Review saved in review.txt.",
                  }),
                ],
                "Reviewed.",
              ],
              (context) => expect(context).not.toContain("Alice private context marker."),
            );
          } else {
            await scriptedPi(session, ["Received review."], (context) => {
              restored = context;
            });
          }
        },
      }),
  });
  expect(result.status).toBe("quiescent");
  expect(result.turns).toHaveLength(3);
  expect(result.messages).toHaveLength(4);
  expect(result.messages.every((message) => message.acknowledgedBy)).toBe(true);
  expect(restored).toContain("Alice private context marker.");
  expect(restored).toContain("Review saved in review.txt.");
  expect(await readFile(path.join(root, "workspace/review.txt"), "utf8")).toBe(
    "Verified the value is 42.",
  );
  expect(
    await runSwarm(config, {
      execute: async () => {
        throw new Error("must not rerun");
      },
    }),
  ).toEqual(result);
});

it("recovers a confirmed Pi invocation after the controller misses its result, without repeating effects", async () => {
  const { root, config } = await fixture();
  config.agents = config.agents.slice(0, 1);
  config.placement.agents = config.placement.agents.slice(0, 1);
  const interrupted = await runSwarm(config, {
    async execute(request, options) {
      await executePiTurn(request, {
        ...options,
        configureSession: (session) =>
          scriptedPi(session, [
            [tool("effect", "bash", { command: "printf once >> effect.txt" })],
            "Done.",
          ]),
      });
      throw new Error("Controller transport lost the confirmed result");
    },
  });
  expect(interrupted.status).toBe("failed");
  expect(interrupted.messages[0]!.acknowledgedBy).toBeUndefined();
  const recovered = await runSwarm(config);
  expect(recovered.status).toBe("quiescent");
  expect(recovered.turns).toHaveLength(1);
  expect(await readFile(path.join(root, "workspace/effect.txt"), "utf8")).toBe("once");
});

it("refuses ambiguous interrupted tool effects and retains unacknowledged deliveries", async () => {
  const { root, config } = await fixture();
  config.agents = config.agents.slice(0, 1);
  config.placement.agents = config.placement.agents.slice(0, 1);
  const first = await runSwarm(config, {
    configureSession: async () => {
      throw new Error("setup interrupted");
    },
  });
  expect(first.status).toBe("failed");
  expect(first.turns[0]!.status).toBe("interrupted");
  const resumed = await runSwarm(config);
  expect(resumed.status).toBe("failed");
  expect(resumed.turns[0]!.error).toContain("active or interrupted");
  expect(resumed.messages[0]!.acknowledgedBy).toBeUndefined();
  await expect(
    readFile(path.join(root, "sessions/team/alice/active-turn/invocation.json"), "utf8"),
  ).resolves.toContain("turn-1");
});

it("enforces one controller and the total turn budget", async () => {
  const { config } = await fixture();
  config.limits.turns = 1;
  let started!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const running = runSwarm(config, {
    configureSession: async (session) => {
      started();
      await gate;
      await scriptedPi(session, ["Done."]);
    },
  });
  await ready;
  await expect(runSwarm(config)).rejects.toThrow("Controller lock exists");
  finish();
  const result = await running;
  expect(result.status).toBe("limited");
  expect(result.turns).toHaveLength(1);
  expect(result.messages.filter((message) => !message.acknowledgedBy)).toHaveLength(1);
});

it("allows file-only collaboration without injecting peer messaging or a privileged planner", async () => {
  const { config } = await fixture();
  config.communication = "files";
  config.limits.concurrency = 2;
  let maximum = 0;
  let active = 0;
  const result = await runSwarm(config, {
    configureSession: async (session) => {
      expect(session.getActiveToolNames()).not.toContain("send_message");
      expect(session.getActiveToolNames()).not.toContain("spawn_agent");
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      await scriptedPi(session, ["Done."]);
    },
  });
  expect(maximum).toBe(2);
  expect(result.status).toBe("quiescent");
});

it("rejects invalid placement and changed configuration on resume", async () => {
  const { config } = await fixture();
  const duplicate = structuredClone(config);
  duplicate.agents[1]!.id = "alice";
  expect(() => swarmConfig.parse(duplicate)).toThrow("identities");
  const invalid = structuredClone(config);
  invalid.controlRoot = config.placement.workspaces[0]!.path;
  expect(() => swarmConfig.parse(invalid)).toThrow("must not overlap");
  await runSwarm(config, { configureSession: (session) => scriptedPi(session, ["Done."]) });
  await expect(runSwarm({ ...config, objective: "Changed" })).rejects.toThrow(
    "different configuration",
  );
});

it("keeps a stale controller lock explicit after process loss", async () => {
  const { root, config } = await fixture();
  await mkdir(path.join(root, "control/team/controller-lock"), { recursive: true });
  await expect(runSwarm(config)).rejects.toThrow("inspect the old process");
});

it("does not turn a confirmed failure into success when restarted", async () => {
  const { config } = await fixture();
  const failed = await runSwarm(config, {
    execute: async (request, options) => {
      const result = await executePiTurn(request, {
        ...options,
        configureSession: (session) => scriptedPi(session, ["Done."]),
      });
      return { ...result, outcome: "failed", error: "Fixture verification transport failed" };
    },
  });
  expect(failed.status).toBe("failed");
  expect(await runSwarm(config)).toEqual(failed);
});
