import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ModalClient } from "modal";
import type { createServer } from "../src/api/server.js";
import type { MongoStore } from "../src/store/mongo.js";

export const fixtureObjective = `Read TASK.md. Spawn exactly two workers named implementer and reviewer. Fix parseInteger without changing parser.test.js, package.json, or TASK.md. Create exactly one task, have the implementer claim it, push a new task branch (never main), and have the reviewer fetch and check out the exact pushed commit. Both must run node --test --test-reporter=tap and record actual output. Review must be independent. Require workers to DM you when finished. IMPORTANT: after approval, tell the operator the reviewed commit and wait. Do NOT call complete_objective until the operator sends COMPLETE_OBJECTIVE_NOW; this pause lets the test verify sandbox replacement. End turns while waiting, never poll.`;

type Options = {
  store: MongoStore;
  runId: string;
  api: ReturnType<typeof createServer>;
  headers: { authorization: string };
  modal: ModalClient;
  stopWorker: () => Promise<void>;
  startWorker: () => Promise<void>;
  waitFor: (predicate: () => Promise<boolean>, label: string, timeout?: number) => Promise<void>;
};

/** Real cloud acceptance check. No fixture model or sandbox replacement is used here. */
export async function exerciseOrchestration(o: Options) {
  const { store, runId, api, headers, modal, waitFor } = o;
  await waitFor(
    async () => {
      const run = await store.getRun(runId);
      assert.equal(
        run.status,
        "active",
        "Orchestrator must wait for the recovery check before finishing",
      );
      const agents = await store.agents.find({ runId }).toArray();
      return (
        !!(await store.tasks.findOne({ runId, status: "done" })) &&
        agents.length === 3 &&
        agents.every((agent) => agent.status === "idle") &&
        (await store.deliveries.countDocuments({ runId, status: { $ne: "completed" } })) === 0
      );
    },
    "pushed implementation, independent review and idle team",
    900_000,
  );
  const agents = await store.agents.find({ runId }).toArray();
  const orchestrator = agents.find((agent) => agent.kind === "orchestrator")!;
  const task = (await store.tasks.findOne({ runId, status: "done" }))!;
  const owner = agents.find((agent) => agent._id === task.ownerId)!;
  const reviewer = agents.find((agent) => agent._id === task.reviewerId)!;
  assert.ok(owner && reviewer && owner._id !== reviewer._id);
  assert.equal(task.review?.commit, task.result?.commit);
  const commit = task.result!.commit;
  for (const agent of [owner, reviewer]) {
    const evidence = await store.events
      .find({
        runId,
        actorId: agent._id,
        kind: "tool_execution_end",
        "details.payload.isError": { $ne: true },
      })
      .toArray();
    assert.ok(
      evidence.some((event) => JSON.stringify(event.details).includes("# fail 0")),
      `${agent.role} must execute passing tests`,
    );
  }
  // Independently execute the fixture suite inside the reviewer's cloud workspace.
  const guest = await modal.sandboxes.fromId(reviewer.sandboxId!);
  let verification = "";
  try {
    const process = await guest.exec(
      [
        "bash",
        "-c",
        'set -eu; cd /workspace/repo; test "$(git rev-parse HEAD)" = "$1"; git fetch origin; git diff --exit-code origin/main "$1" -- parser.test.js package.json TASK.md; node --test --test-reporter=tap',
        "verify",
        commit,
      ],
      { timeoutMs: 60000 },
    );
    const [code, stdout] = await Promise.all([
      process.wait(),
      process.stdout.readText(),
      process.stderr.readText(),
    ]);
    assert.equal(code, 0, "Trusted fixture verification failed");
    assert.ok(stdout.includes("# fail 0"));
    verification = stdout;
  } finally {
    guest.detach();
  }

  const before = (await store.checkpoint(owner))!;
  const beforeEntries = before
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id?: string });
  await o.stopWorker();
  const recovery = await api.inject({
    method: "POST",
    url: `/operator/runs/${runId}/agents/${owner._id}/replace`,
    headers,
    payload: { requestId: randomUUID(), commit },
  });
  assert.equal(recovery.statusCode, 200, recovery.body);
  const marker = `recovered-${randomUUID()}`;
  const queued = await api.inject({
    method: "POST",
    url: `/operator/runs/${runId}/messages`,
    headers,
    payload: {
      requestId: randomUUID(),
      recipientId: owner._id,
      body: `Recovery check: use your earlier session to describe the fix and review. Read parser.js, run node --test --test-reporter=tap again, then call send_message with recipientId="operator" and body containing ${marker} and the exact reviewed commit. "operator" is the literal recipient ID for the human, distinct from the orchestrator agent. Do not edit files or create another task. End your turn.`,
    },
  });
  assert.equal(queued.statusCode, 200, queued.body);
  const messageId = queued.json()._id;
  assert.equal((await store.deliveries.findOne({ messageId }))?.status, "pending");
  await o.startWorker();
  await store.transaction((session) =>
    store.event(session, { runId, agentId: "operator" }, "worker.restarted", runId),
  );
  await waitFor(
    async () => {
      const current = await store.getAgent(owner._id);
      return (
        current.status === "idle" &&
        current.recovery?.status === "completed" &&
        current.sandboxId !== owner.sandboxId &&
        !!(await store.messages.findOne({
          runId,
          senderId: owner._id,
          recipients: "operator",
          body: { $regex: marker },
        }))
      );
    },
    "worker restart, sandbox replacement and queued-message reply",
    600_000,
  );
  const recovered = await store.getAgent(owner._id);
  const after = (await store.checkpoint(recovered))!
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id?: string });
  assert.equal(
    after[0]!.id,
    beforeEntries[0]!.id,
    "Native Pi session identity must survive replacement",
  );
  const afterIds = new Set(after.map((entry) => entry.id));
  for (const entry of beforeEntries)
    if (entry.id)
      assert.ok(afterIds.has(entry.id), "Prior native session entries must survive replacement");
  assert.equal((await store.deliveries.findOne({ messageId }))?.status, "completed");
  const finish = await api.inject({
    method: "POST",
    url: `/operator/runs/${runId}/messages`,
    headers,
    payload: {
      requestId: randomUUID(),
      recipientId: orchestrator._id,
      body: `COMPLETE_OBJECTIVE_NOW. Recovery verification passed. Call complete_objective with reviewed commit ${commit} and the outcome, then end your turn.`,
    },
  });
  assert.equal(finish.statusCode, 200, finish.body);
  await waitFor(
    async () => !!(await store.getRun(runId)).completion?.confirmed,
    "objective checkpoint",
    300_000,
  );
  const run = await store.getRun(runId);
  assert.equal(run.status, "active");
  assert.equal(run.completion?.commit, commit);
  const originalIds = (await store.agents.find({ runId }).toArray()).map((a) => a._id).sort();
  // A second, different task after completion proves this is a reusable team.
  const followup = await api.inject({
    method: "POST",
    url: `/operator/runs/${runId}/messages`,
    headers,
    payload: {
      requestId: randomUUID(),
      recipientId: orchestrator._id,
      body: `New objective: reuse your existing implementer and reviewer to add USAGE.md with examples of accepted and rejected parseInteger inputs. Build on reviewed commit ${commit} in a uniquely named new task branch. Keep parser.js, parser.test.js, package.json, and TASK.md unchanged. Create exactly one new task, run node --test --test-reporter=tap, push the documentation commit, and independently review that exact commit. Then call complete_objective for this new objective. The previous objective is already complete; COMPLETE_OBJECTIVE_NOW is not needed again. Reply to the operator with the new commit. Do not spawn more workers or poll.`,
    },
  });
  assert.equal(followup.statusCode, 200, followup.body);
  await waitFor(
    async () => {
      const next = await store.getRun(runId);
      return !!next.completion?.confirmed && next.completion.commit !== commit;
    },
    "follow-up objective completed by same team",
    600_000,
  );
  const followupRun = await store.getRun(runId);
  assert.equal(followupRun.status, "active");
  assert.deepEqual(
    (await store.agents.find({ runId }).toArray()).map((a) => a._id).sort(),
    originalIds,
  );
  assert.equal(await store.tasks.countDocuments({ runId, status: "done" }), 2);
  const updatedReviewer = (await store.agents.findOne({ _id: reviewer._id }))!;
  const followupSandbox = await modal.sandboxes.fromId(updatedReviewer.sandboxId!);
  try {
    const check = await followupSandbox.exec([
      "bash",
      "-c",
      'set -eu; cd /workspace/repo; git fetch origin "$1"; test "$(git rev-parse FETCH_HEAD)" = "$1"; git checkout --detach "$1"; test -s USAGE.md; test -z "$(git diff "$2" "$1" -- parser.js parser.test.js package.json TASK.md)"; node --test --test-reporter=tap',
      "verify",
      followupRun.completion!.commit,
      commit,
    ]);
    const [code, output] = await Promise.all([
      check.wait(),
      check.stdout.readText(),
      check.stderr.readText(),
    ]);
    assert.equal(code, 0, output);
  } finally {
    followupSandbox.detach();
  }
  const stop = await api.inject({
    method: "POST",
    url: `/operator/runs/${runId}/stop`,
    headers,
    payload: {},
  });
  assert.equal(stop.statusCode, 200, stop.body);
  await waitFor(
    async () => (await store.getRun(runId)).status === "stopped",
    "explicit Stop cleans all sandboxes",
    300_000,
  );
  return {
    task,
    verification,
    followupCommit: followupRun.completion!.commit,
    recovery: {
      agentId: owner._id,
      oldSandboxId: owner.sandboxId,
      newSandboxId: recovered.sandboxId,
    },
    checks: [
      "orchestrator dynamically spawned two real Pi workers",
      "implementation pushed and independently reviewed at exact commit",
      "fixture tests unchanged and independently executed inside Modal",
      "Temporal worker restarted with a queued operator message",
      "old sandbox terminated and replaced at the pushed commit",
      "native session identity and prior entries restored in replacement",
      "objective completion retained team and native checkpoints",
      "same agents completed a different follow-up objective",
      "explicit Stop cleaned all sandboxes",
    ],
  };
}
