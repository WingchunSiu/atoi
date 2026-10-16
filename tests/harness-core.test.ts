import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { PiInvocation } from "../src/harness/contracts.js";
import { executePiTurn, type PiRuntimeOptions } from "../src/harness/pi-runtime.js";
import { type PlacementPlan, resolvePlacements } from "../src/harness/placement.js";
import { scriptedPi, tool } from "./scripted-pi.js";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const invocation = (agentId: string, invocationId = "turn-1"): PiInvocation => ({
  agentId,
  runId: "team",
  invocationId,
  generation: 1,
  provider: "openai",
  model: "gpt-4.1",
  prompt: "Work on the assigned question.",
  checkpoint: null,
  budget: { timeoutMs: 10000, modelRequests: 8, toolCalls: 8 },
});

async function fixture(shared = false) {
  const root = await mkdtemp(path.join(tmpdir(), "atoi-core-"));
  directories.push(root);
  const plan: PlacementPlan = {
    runId: "team",
    environments: [{ id: "host", stateRoot: path.join(root, "state") }],
    workspaces: shared
      ? [{ id: "common", environmentId: "host", path: path.join(root, "common"), access: "shared" }]
      : ["alice", "bob"].map((id) => ({
          id,
          environmentId: "host",
          path: path.join(root, id),
        })),
    agents: ["alice", "bob"].map((id) => ({ id, workspaceId: shared ? "common" : id })),
  };
  const placements = resolvePlacements(plan);
  await Promise.all([...placements.values()].map((p) => mkdir(p.workspace, { recursive: true })));
  const options = (id: string): PiRuntimeOptions => ({
    placement: placements.get(id)!,
    profile: { id: "test-peers-v1", systemPrompt: "You are a peer. Use your assigned tools." },
  });
  return { root, plan, placements, options };
}

describe("independent agents and environment placement", () => {
  it("runs native Pi agents in separate Git worktrees in the same environment", async () => {
    const f = await fixture();
    const repo = path.join(f.root, "repo");
    await exec("git", ["init", "--initial-branch=main", repo]);
    await exec("git", [
      "-C",
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-m",
      "Fixture base",
    ]);
    for (const id of ["alice", "bob"]) {
      await rm(f.placements.get(id)!.workspace, { recursive: true });
      await exec("git", [
        "-C",
        repo,
        "worktree",
        "add",
        "--detach",
        f.placements.get(id)!.workspace,
      ]);
    }
    const results = await Promise.all(
      ["alice", "bob"].map(async (id) => {
        const result = await executePiTurn(invocation(id), {
          ...f.options(id),
          async configureSession(session) {
            expect(session.getActiveToolNames()).toEqual(
              expect.arrayContaining(["read", "write", "edit", "bash"]),
            );
            expect(session.getActiveToolNames()).not.toContain("get_run");
            expect(session.getActiveToolNames()).not.toContain("spawn_agent");
            await scriptedPi(session, [
              [tool("write", "write", { path: "result.txt", content: id })],
              `${id} private conclusion`,
            ]);
          },
        });
        expect(result.outcome).toBe("completed");
        expect(
          await readFile(path.join(f.placements.get(id)!.workspace, "result.txt"), "utf8"),
        ).toBe(id);
        return result;
      }),
    );
    expect(results[0]!.checkpoint).not.toContain("bob private conclusion");
    expect(results[1]!.checkpoint).not.toContain("alice private conclusion");
    expect(f.placements.get("alice")!.environmentId).toBe(f.placements.get("bob")!.environmentId);
    expect(f.placements.get("alice")!.stateDirectory).not.toBe(
      f.placements.get("bob")!.stateDirectory,
    );
  });

  it("shares files without merging native sessions, then restores the original agent for a follow-up", async () => {
    const f = await fixture(true);
    const first = await executePiTurn(invocation("alice"), {
      ...f.options("alice"),
      async configureSession(session) {
        await scriptedPi(session, [
          [tool("publish", "write", { path: "evidence.txt", content: "Experiment: value is 42." })],
          "Alice-only scratch reasoning.",
        ]);
      },
    });
    let bobContext = "";
    const second = await executePiTurn(invocation("bob"), {
      ...f.options("bob"),
      async configureSession(session) {
        await scriptedPi(
          session,
          [[tool("inspect", "read", { path: "evidence.txt" })], "Read the published evidence."],
          (context) => {
            bobContext = context;
          },
        );
      },
    });
    expect(second.outcome).toBe("completed");
    expect(bobContext).toContain("value is 42");
    expect(bobContext).not.toContain("Alice-only scratch reasoning");
    let followupContext = "";
    const followup = await executePiTurn(
      { ...invocation("alice", "turn-2"), checkpoint: first.checkpoint },
      {
        ...f.options("alice"),
        async configureSession(session) {
          await scriptedPi(session, ["Follow-up complete."], (context) => {
            followupContext = context;
          });
        },
      },
    );
    expect(followup.outcome).toBe("completed");
    expect(followupContext).toContain("Alice-only scratch reasoning");
    expect(followupContext).not.toContain("Read the published evidence");
    expect(
      await readFile(path.join(f.options("bob").placement.workspace, "evidence.txt"), "utf8"),
    ).toContain("42");
  });

  it("injects a peer tool without an HTTP backend or an orchestrator role", async () => {
    const f = await fixture();
    const messages: unknown[] = [];
    const input = invocation("alice");
    const result = await executePiTurn(input, {
      ...f.options("alice"),
      profile: {
        id: "message-fixture-v1",
        systemPrompt: "Send a peer the exact evidence.",
        bind: ({ sessionId, placement, invocation: turn }) => ({
          tools: [
            defineTool({
              name: "send_peer",
              label: "Send peer",
              description: "Fixture transport that records a message without network access.",
              parameters: Type.Object({ to: Type.String(), body: Type.String() }),
              execute: async (callId, message) => {
                messages.push({
                  ...message,
                  from: placement.agentId,
                  sessionId,
                  invocationId: turn.invocationId,
                  callId,
                });
                return { content: [{ type: "text", text: "accepted" }], details: {} };
              },
            }),
          ],
        }),
      },
      async configureSession(session) {
        await scriptedPi(session, [
          [tool("handoff", "send_peer", { to: "bob", body: "Evidence is ready." })],
          "Sent.",
        ]);
      },
    });
    expect(result.outcome).toBe("completed");
    expect(messages).toEqual([
      expect.objectContaining({
        from: "alice",
        to: "bob",
        invocationId: "turn-1",
        body: "Evidence is ready.",
      }),
    ]);
    expect(result.checkpoint).toContain('"role":"toolResult"');
  });

  it("deduplicates confirmed effects and rejects reusing an invocation under another profile", async () => {
    const f = await fixture();
    const options = f.options("alice");
    const result = await executePiTurn(invocation("alice"), {
      ...options,
      async configureSession(session) {
        await scriptedPi(session, [
          [tool("effect", "bash", { command: "printf 'once\\n' >> effects.txt" })],
          "Done.",
        ]);
      },
    });
    expect(await executePiTurn(invocation("alice"), options)).toEqual(result);
    await expect(
      executePiTurn(invocation("alice"), {
        ...options,
        profile: { ...options.profile, id: "another-profile" },
      }),
    ).rejects.toThrow("different input");
    expect(await readFile(path.join(options.placement.workspace, "effects.txt"), "utf8")).toBe(
      "once\n",
    );
    await expect(executePiTurn(invocation("bob"), options)).rejects.toThrow("identity");
  });

  it("rejects overlapping invocations of one agent without blocking a peer", async () => {
    const f = await fixture();
    let started!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = executePiTurn(invocation("alice"), {
      ...f.options("alice"),
      async configureSession(session) {
        started();
        await gate;
        await scriptedPi(session, ["Alice finished."]);
      },
    });
    await ready;
    try {
      await expect(
        executePiTurn(invocation("alice", "overlap"), f.options("alice")),
      ).rejects.toThrow("active or interrupted");
      const peer = await executePiTurn(invocation("bob"), {
        ...f.options("bob"),
        async configureSession(session) {
          await scriptedPi(session, ["Bob finished."]);
        },
      });
      expect(peer.outcome).toBe("completed");
    } finally {
      release();
      expect((await running).outcome).toBe("completed");
    }
  });

  it("reports observer failure and flushes it before publishing a confirmed result", async () => {
    const f = await fixture();
    let closed = false;
    const result = await executePiTurn(invocation("alice"), {
      ...f.options("alice"),
      secrets: ["private-observer-secret"],
      profile: {
        id: "observer-fixture",
        systemPrompt: "Finish the turn.",
        bind: () => ({
          observer: {
            async record() {
              throw new Error("Observer failed private-observer-secret");
            },
            async close() {
              closed = true;
            },
          },
        }),
      },
      async configureSession(session) {
        await scriptedPi(session, ["Done."]);
      },
    });
    expect(closed).toBe(true);
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("Observer failed [REDACTED]");
  });

  it("cancels one Pi turn while preserving a peer's files and ability to work", async () => {
    const f = await fixture(true);
    const controller = new AbortController();
    const cancelled = await executePiTurn(invocation("alice"), {
      ...f.options("alice"),
      signal: controller.signal,
      async configureSession(session) {
        session.agent.subscribe((event) => {
          if (event.type === "tool_execution_start") controller.abort();
        });
        await scriptedPi(session, [
          [tool("work", "bash", { command: "sleep 1" })],
          "Do not continue this agent.",
        ]);
      },
    });
    expect(cancelled.outcome).toBe("failed");
    expect(cancelled.error).toBe("Invocation cancelled");
    const peer = await executePiTurn(invocation("bob"), {
      ...f.options("bob"),
      async configureSession(session) {
        await scriptedPi(session, [
          [tool("save", "write", { path: "peer.txt", content: "still available" })],
          "Finished.",
        ]);
      },
    });
    expect(peer.outcome).toBe("completed");
    expect(
      await readFile(path.join(f.options("bob").placement.workspace, "peer.txt"), "utf8"),
    ).toBe("still available");
  });
});

describe("placement contract validation", () => {
  it("requires explicit workspace sharing and valid environment references", async () => {
    const f = await fixture(true);
    expect(() =>
      resolvePlacements({
        ...f.plan,
        workspaces: [{ ...f.plan.workspaces[0]!, access: "exclusive" }],
      }),
    ).toThrow("explicit shared");
    expect(() =>
      resolvePlacements({
        ...f.plan,
        environments: [{ id: "unknown", stateRoot: path.join(f.root, "state") }],
      }),
    ).toThrow("Unknown environment");
    expect(() =>
      resolvePlacements({ ...f.plan, agents: [{ id: "alice", workspaceId: "missing" }] }),
    ).toThrow("Unknown workspace");
  });

  it("separates state from task paths and rejects duplicate identities", async () => {
    const f = await fixture(true);
    expect(() =>
      resolvePlacements({ ...f.plan, agents: [f.plan.agents[0]!, f.plan.agents[0]!] }),
    ).toThrow("Duplicate agent");
    expect(() =>
      resolvePlacements({
        ...f.plan,
        environments: [{ id: "host", stateRoot: f.plan.workspaces[0]!.path }],
      }),
    ).toThrow("outside task");
    expect(() =>
      resolvePlacements({ ...f.plan, environments: [{ id: "host", stateRoot: f.root }] }),
    ).toThrow("outside task");
    expect(() => resolvePlacements({ ...f.plan, runId: "../escape" })).toThrow();
    expect(() =>
      resolvePlacements({
        ...f.plan,
        workspaces: [{ ...f.plan.workspaces[0]!, path: "relative" }],
      }),
    ).toThrow("absolute path");
  });

  it("allows separate environments with the same guest-local directory layout", async () => {
    const placements = resolvePlacements({
      runId: "team",
      environments: ["one", "two"].map((id) => ({ id, stateRoot: "/state" })),
      workspaces: ["one", "two"].map((id) => ({ id, environmentId: id, path: "/workspace" })),
      agents: ["alice", "bob"].map((id, i) => ({ id, workspaceId: i === 0 ? "one" : "two" })),
    });
    expect(placements.get("alice")!.environmentId).not.toBe(placements.get("bob")!.environmentId);
    expect(placements.get("alice")!.workspace).toBe(placements.get("bob")!.workspace);
  });
});
