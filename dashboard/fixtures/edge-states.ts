// Visual QA, not a demo: every agent state, both failure styles, a blocked task with a dependency,
// an agent with no sandbox events, an unknown event type and one malformed event.
import { type Fixture, fixture, OBJECTIVE, REPO, T1 } from "./builder";

export function edgeStates(): Fixture {
  const f = fixture({ runId: "r_edge", start: "2026-10-11T16:00:00Z" });
  f.after(0, {
    type: "run.state",
    status: "starting",
    objective: OBJECTIVE,
    repo: REPO,
    workerLimit: 7,
  });
  f.after(1, { type: "run.state", status: "running" });
  f.spawn(1, "a_orch", "orchestrator", "orchestrator");
  f.provision(0.5, "a_orch", "sb-0a1", "running");
  f.task(1, "a_orch", T1);
  f.task(0.5, "a_orch", {
    id: "T3",
    title: "Benchmark the parser on a 1 GB file",
    status: "blocked",
    dependsOn: ["T1"],
    description: "Measure throughput once quoted-field handling lands.",
    acceptance: ["throughput reported in MB/s"],
  });

  const workers: [string, string][] = [
    ["a_impl", "implementer"],
    ["a_rev", "reviewer"],
    ["a_spec", "specialist"],
    ["a_docs", "docs writer"],
    ["a_qa", "qa"],
    ["a_perf", "performance analyst"],
    ["a_sec", "security auditor"],
  ];
  for (const [id, role] of workers) {
    f.tool(1, "a_orch", "spawn_agent", role);
    f.spawn(0.4, id, role, "worker", "a_orch");
  }

  // running → needs inspection after an interrupted push.
  f.provision(0.5, "a_impl", "sb-1b2", "running");
  f.updateTask(0.5, "a_impl", "T1", { status: "in_progress", ownerId: "a_impl" });
  f.tool(2, "a_impl", "bash", "git push origin task/T1");
  f.state(6, "a_impl", "needs_inspection", {
    detail: "Interrupted during git push. The push may or may not have landed.",
  });

  // waiting → stopped.
  f.provision(0.5, "a_rev", "sb-2c3");
  f.checkpoint(1, "a_rev", 1);
  f.state(1, "a_rev", "stopped");
  f.sandbox(0.5, "a_rev", "terminated", "sb-2c3");

  // provisioning failure.
  f.sandbox(0.5, "a_spec", "starting", "sb-3e4");
  f.after(8, {
    type: "failure.recorded",
    agentId: "a_spec",
    failureId: "f_prov_1",
    scope: "provisioning",
    message: "Modal sandbox for specialist did not start: image pull timed out after 3 attempts",
    resolved: false,
  });
  f.state(0.5, "a_spec", "failed", { detail: "provisioning failed after 3 attempts" });
  f.sandbox(0.5, "a_spec", "terminated", "sb-3e4");

  // a_docs stays provisioning and never reports a sandbox, so its sandbox strip is hidden.

  // waiting on a timer.
  f.provision(0.5, "a_qa", "sb-5a6");
  const wakeAt = f.at(600);
  f.state(0.5, "a_qa", "waiting", { wakeAt, detail: "re-check flaky tests in 10 minutes" });

  // checkpointing.
  f.provision(0.5, "a_perf", "sb-6b7", "running");
  f.tool(1, "a_perf", "bash", "node bench/parse.js --size 1g");
  f.state(2, "a_perf", "checkpointing");

  // recovering at generation 2, mid-replacement.
  f.provision(0.5, "a_sec", "sb-7c8");
  f.sandbox(1, "a_sec", "terminated", "sb-7c8");
  f.state(0.5, "a_sec", "recovering", { generation: 2, detail: "replacing sandbox" });
  f.sandbox(0.5, "a_sec", "starting", "sb-8d9");

  // Messages: a mention and a DM, so the chat and one peer link have content.
  const ping = f.team(1, {
    from: "a_orch",
    body: "@qa please hold the flaky-test rerun until T1 lands.",
    mentions: ["a_qa"],
  });
  f.dm(1, {
    from: "a_orch",
    to: "a_impl",
    body: "Did task/T1 reach the remote? Check before pushing again.",
  });
  f.done(0.5, "a_qa", ping.deliveries.a_qa!, ping.messageId);

  // A resolved failure next to the unresolved one.
  f.after(1, {
    type: "failure.recorded",
    failureId: "f_clean_1",
    scope: "cleanup",
    message: "Terminate sb-2c3 timed out",
    resolved: false,
  });
  f.after(4, {
    type: "failure.recorded",
    failureId: "f_clean_1",
    scope: "cleanup",
    message: "Terminated sb-2c3 on retry",
    resolved: true,
  });

  // A type this dashboard doesn't know, and an event that fails validation.
  f.raw(1, { type: "agent.mood", agentId: "a_qa", mood: "curious" });
  f.raw(1, { type: "message.sent", agentId: "a_orch", body: "missing required fields" });

  f.tool(1, "a_orch", "list_tasks", "T1 in progress, T3 blocked");
  return { name: "edge-states", events: f.events() };
}
