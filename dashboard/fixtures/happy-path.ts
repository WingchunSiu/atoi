// Collaboration story: the orchestrator spawns an implementer and a reviewer, the reviewer rejects
// the first commit, a fix is approved, and the orchestrator completes the run.
import { USER_ID } from "../src/contract/events";
import { type Fixture, type FixtureBuilder, fixture, OBJECTIVE, REPO, T1, T2 } from "./builder";

/** Steps 1-5: start the run, spawn the team and hand out T1. Shared with third-worker. */
export function kickoff(f: FixtureBuilder, workerLimit: number) {
  f.after(0, {
    type: "run.state",
    status: "starting",
    objective: OBJECTIVE,
    repo: REPO,
    workerLimit,
  });
  f.after(1, { type: "run.state", status: "running" });

  f.spawn(1, "a_orch", "orchestrator", "orchestrator");
  f.provision(0.5, "a_orch", "sb-0a1");

  // The operator gives the orchestrator its brief.
  const brief = f.dm(1.5, {
    from: USER_ID,
    to: "a_orch",
    body: `${OBJECTIVE} in ${REPO}. parse('"a\\nb",c') should return [['a\\nb', 'c']], and existing tests must keep passing. Use an implementer and a reviewer.`,
  });
  f.wake(1, "a_orch", "dm", brief.messageId);
  f.tool(1, "a_orch", "read_channel", "dm with you, 1 message");
  f.done(0.3, "a_orch", brief.deliveryId, brief.messageId);
  f.dm(1.5, {
    from: "a_orch",
    to: USER_ID,
    replyTo: brief.messageId,
    body: "On it. I'll spawn an implementer and a reviewer, put T1 on the task list, and report back with the reviewed commit.",
  });

  f.tool(3, "a_orch", "list_agents", "1 agent: orchestrator");
  f.tool(4, "a_orch", "create_task", "T1 Handle quoted newlines in CSV fields");
  f.task(0.4, "a_orch", T1);

  f.tool(3, "a_orch", "spawn_agent", "implementer");
  f.spawn(0.6, "a_impl", "implementer", "worker", "a_orch");
  f.tool(2, "a_orch", "spawn_agent", "reviewer");
  f.spawn(0.6, "a_rev", "reviewer", "worker", "a_orch");
  f.provision(0.5, "a_impl", "sb-1b2");
  f.provision(0.5, "a_rev", "sb-2c3");

  f.tool(3, "a_orch", "send_message", "team: @implementer please take T1…");
  const msg = f.team(0.5, {
    from: "a_orch",
    body: "@implementer please take T1. @reviewer review it once it's in review.",
    mentions: ["a_impl", "a_rev"],
  });
  f.checkpoint(1, "a_orch", 1);
  f.sleep(0.5, "a_orch");

  f.wake(1, "a_impl", "mention", msg.messageId);
  f.wake(0.4, "a_rev", "mention", msg.messageId);

  // The reviewer has nothing to do until T1 is in review.
  f.tool(2, "a_rev", "read_channel", "team, 1 message");
  f.done(0.5, "a_rev", msg.deliveries.a_rev!, msg.messageId);
  f.checkpoint(1, "a_rev", 1);
  f.sleep(0.5, "a_rev");

  f.tool(1, "a_impl", "read_channel", "team, 1 message");
  f.tool(2, "a_impl", "claim_task", "T1");
  f.updateTask(0.3, "a_impl", "T1", { status: "in_progress", ownerId: "a_impl" });
  f.done(0.5, "a_impl", msg.deliveries.a_impl!, msg.messageId);
}

/** Step 7-9: first attempt, pushed and rejected. Returns the reviewer's feedback DM. */
export function firstAttempt(f: FixtureBuilder) {
  f.tool(4, "a_impl", "bash", "git checkout -b task/T1");
  f.tool(6, "a_impl", "read", "src/parse.ts");
  f.tool(14, "a_impl", "edit", "src/parse.ts");
  f.tool(9, "a_impl", "bash", "npm test");
  f.tool(
    12,
    "a_impl",
    "bash",
    "git commit -am 'Handle quoted newlines' && git push origin task/T1",
  );
  f.push(3, "a_impl", "task/T1", "a1b2c3d", "Handle quoted newlines in CSV fields");
  f.verify(0.5, "a_impl", "a1b2c3d", "npm test", true, "14 passed");
  f.tool(1, "a_impl", "update_task", "T1 in review at a1b2c3d");
  f.updateTask(0.3, "a_impl", "T1", { status: "in_review", resultCommit: "a1b2c3d" });

  const ready = f.dm(2, {
    from: "a_impl",
    to: "a_rev",
    body: "T1 is ready for review at a1b2c3d on task/T1.",
  });
  f.checkpoint(1, "a_impl", 1);
  f.sleep(0.5, "a_impl");

  f.wake(1, "a_rev", "dm", ready.messageId);
  f.tool(3, "a_rev", "bash", "git fetch origin && git checkout a1b2c3d");
  f.tool(5, "a_rev", "bash", "npm test");
  f.verify(
    18,
    "a_rev",
    "a1b2c3d",
    "npm test",
    false,
    "13 passed, 1 failed: quoted field with CRLF",
  );
  const feedback = f.dm(8, {
    from: "a_rev",
    to: "a_impl",
    replyTo: ready.messageId,
    body: "a1b2c3d fails when a quoted field contains \\r\\n (parse_crlf_quoted). Can you handle CRLF too?",
  });
  f.done(0.5, "a_rev", ready.deliveryId, ready.messageId);
  return feedback;
}

/** Step 12-13: the orchestrator completes the run and everything shuts down. */
export interface Worker {
  id: string;
  sandbox: string;
  checkpoint: number;
}

export function finish(
  f: FixtureBuilder,
  approved: { messageId: string; deliveries: Record<string, string> },
  finalCommit: string,
  workers: Worker[],
) {
  f.wake(1, "a_orch", "mention", approved.messageId);
  f.tool(3, "a_orch", "list_tasks", "all tasks done");
  f.tool(4, "a_orch", "finish_run", finalCommit);
  f.after(0.5, {
    type: "run.state",
    status: "completing",
    finalCommit,
    outcome: `T1 reviewed and approved on task/T1 at ${finalCommit}`,
  });
  f.done(0.5, "a_orch", approved.deliveries.a_orch!, approved.messageId);
  f.dm(1, {
    from: "a_orch",
    to: USER_ID,
    body: `Done. T1 is reviewed and approved on task/T1 at ${finalCommit}; the reviewer's npm test run passed. The branch is ready for you to merge.`,
  });
  f.checkpoint(1, "a_orch", 2);
  f.usage(0.3, "a_orch");

  for (const w of workers) f.checkpoint(0.8, w.id, w.checkpoint);
  for (const w of [{ id: "a_orch", sandbox: "sb-0a1" }, ...workers]) {
    f.state(0.6, w.id, "stopped");
    f.sandbox(1, w.id, "terminated", w.sandbox);
  }
  f.after(1, { type: "run.state", status: "completed" });
}

export function happyPath(): Fixture {
  const f = fixture({ runId: "r_demo", start: "2026-10-11T13:50:00Z" });
  kickoff(f, 2);
  const feedback = firstAttempt(f);
  f.checkpoint(1, "a_rev", 2);
  f.sleep(0.5, "a_rev");

  // Step 10: the implementer handles CRLF and adds T2 for the regression test.
  f.wake(1, "a_impl", "dm", feedback.messageId);
  f.updateTask(2, "a_impl", "T1", { status: "in_progress" });
  f.tool(2, "a_impl", "create_task", "T2 Add a regression test for CRLF inside quoted fields");
  f.task(0.3, "a_impl", T2);
  f.tool(1, "a_impl", "claim_task", "T2");
  f.updateTask(0.3, "a_impl", "T2", { status: "in_progress", ownerId: "a_impl" });
  f.tool(8, "a_impl", "edit", "src/parse.ts");
  f.tool(10, "a_impl", "edit", "test/parse.test.ts");
  f.tool(6, "a_impl", "bash", "npm test");
  f.tool(
    14,
    "a_impl",
    "bash",
    "git commit -am 'Handle CRLF in quoted fields' && git push origin task/T1",
  );
  f.push(
    3,
    "a_impl",
    "task/T1",
    "b4e5f6a",
    "Handle CRLF inside quoted fields, add parse_crlf_quoted",
  );
  f.verify(0.5, "a_impl", "b4e5f6a", "npm test", true, "15 passed");
  f.updateTask(1, "a_impl", "T2", { status: "done", resultCommit: "b4e5f6a" });
  f.updateTask(0.5, "a_impl", "T1", { status: "in_review", resultCommit: "b4e5f6a" });
  const fixed = f.dm(2, {
    from: "a_impl",
    to: "a_rev",
    replyTo: feedback.messageId,
    body: "Fixed in b4e5f6a. T2 adds parse_crlf_quoted coverage.",
  });
  f.done(0.5, "a_impl", feedback.deliveryId, feedback.messageId);
  f.checkpoint(1, "a_impl", 2);
  f.sleep(0.5, "a_impl");

  // Step 11: the reviewer approves the fix.
  f.wake(1, "a_rev", "dm", fixed.messageId);
  f.tool(3, "a_rev", "bash", "git fetch origin && git checkout b4e5f6a");
  f.tool(5, "a_rev", "bash", "npm test");
  f.verify(18, "a_rev", "b4e5f6a", "npm test", true, "15 passed");
  f.tool(2, "a_rev", "update_task", "T1 done");
  f.updateTask(0.3, "a_rev", "T1", { status: "done" });
  const approved = f.team(2, {
    from: "a_rev",
    body: "@orchestrator T1 is approved at b4e5f6a.",
    mentions: ["a_orch"],
  });
  f.done(0.5, "a_rev", fixed.deliveryId, fixed.messageId);
  f.checkpoint(1, "a_rev", 3);
  f.sleep(0.5, "a_rev");

  finish(f, approved, "b4e5f6a", [
    { id: "a_impl", sandbox: "sb-1b2", checkpoint: 3 },
    { id: "a_rev", sandbox: "sb-2c3", checkpoint: 4 },
  ]);
  return { name: "happy-path", events: f.events() };
}
