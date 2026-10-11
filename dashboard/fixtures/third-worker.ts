// Like happy-path with a worker limit of 3. Partway through, the orchestrator spawns a specialist,
// which lists agents, DMs the implementer, claims T2 and completes it.
import { type Fixture, fixture, T2 } from "./builder";
import { finish, firstAttempt, kickoff } from "./happy-path";

export function thirdWorker(): Fixture {
  const f = fixture({ runId: "r_third", start: "2026-10-11T15:00:00Z" });
  kickoff(f, 3);
  const feedback = firstAttempt(f);

  // The reviewer flags the failure to the orchestrator, which brings in a specialist.
  const flag = f.team(1, {
    from: "a_rev",
    mentions: ["a_orch"],
    body: "@orchestrator a1b2c3d fails on CRLF inside quoted fields. T1 is back with the implementer; we need a regression test.",
  });
  f.checkpoint(1, "a_rev", 2);
  f.sleep(0.5, "a_rev");

  f.wake(1, "a_orch", "mention", flag.messageId);
  f.tool(2, "a_orch", "create_task", "T2 Add a regression test for CRLF inside quoted fields");
  f.task(0.3, "a_orch", T2);
  f.tool(2, "a_orch", "spawn_agent", "specialist");
  f.spawn(0.6, "a_spec", "specialist", "worker", "a_orch");
  f.provision(0.5, "a_spec", "sb-3e4");
  const assign = f.team(1, {
    from: "a_orch",
    body: "@specialist please take T2.",
    mentions: ["a_spec"],
  });
  f.done(0.5, "a_orch", flag.deliveries.a_orch!, flag.messageId);
  f.checkpoint(1, "a_orch", 2);
  f.sleep(0.5, "a_orch");

  // Meanwhile the implementer starts on the CRLF fix.
  f.wake(1, "a_impl", "dm", feedback.messageId);
  f.updateTask(1, "a_impl", "T1", { status: "in_progress" });
  f.tool(3, "a_impl", "edit", "src/parse.ts");

  // The specialist joins, finds its peers and coordinates directly with the implementer.
  f.wake(1, "a_spec", "mention", assign.messageId);
  f.tool(2, "a_spec", "list_agents", "4 agents: orchestrator, implementer, reviewer, specialist");
  f.tool(1, "a_spec", "claim_task", "T2");
  f.updateTask(0.3, "a_spec", "T2", { status: "in_progress", ownerId: "a_spec" });
  f.done(0.5, "a_spec", assign.deliveries.a_spec!, assign.messageId);
  const hello = f.dm(1, {
    from: "a_spec",
    to: "a_impl",
    body: "I'm on T2 (CRLF regression test). Tell me when your fix is on task/T1 and I'll add parse_crlf_quoted on top.",
  });
  f.tool(4, "a_spec", "bash", "git checkout task/T1");
  f.tool(8, "a_spec", "edit", "test/parse.test.ts");

  f.tool(6, "a_impl", "bash", "npm test");
  f.tool(
    10,
    "a_impl",
    "bash",
    "git commit -am 'Handle CRLF in quoted fields' && git push origin task/T1",
  );
  f.push(3, "a_impl", "task/T1", "b4e5f6a", "Handle CRLF inside quoted fields");
  f.verify(0.5, "a_impl", "b4e5f6a", "npm test", true, "14 passed");
  const pushed = f.dm(1, {
    from: "a_impl",
    to: "a_spec",
    replyTo: hello.messageId,
    body: "Fix is on task/T1 at b4e5f6a.",
  });
  f.done(0.5, "a_impl", hello.deliveryId, hello.messageId);
  f.done(0.5, "a_impl", feedback.deliveryId, feedback.messageId);
  f.checkpoint(1, "a_impl", 2);
  f.sleep(0.5, "a_impl");

  f.tool(2, "a_spec", "bash", "git pull --rebase origin task/T1 && npm test");
  f.tool(8, "a_spec", "bash", "git push origin task/T1");
  f.push(3, "a_spec", "task/T1", "c7d8e9f", "Add parse_crlf_quoted regression test");
  f.verify(0.5, "a_spec", "c7d8e9f", "npm test", true, "15 passed");
  f.updateTask(1, "a_spec", "T2", { status: "done", resultCommit: "c7d8e9f" });
  const testDone = f.dm(1, {
    from: "a_spec",
    to: "a_impl",
    replyTo: pushed.messageId,
    body: "T2 done at c7d8e9f. parse_crlf_quoted passes on top of your fix.",
  });
  f.done(0.5, "a_spec", pushed.deliveryId, pushed.messageId);
  f.checkpoint(1, "a_spec", 1);
  f.sleep(0.5, "a_spec");

  f.wake(1, "a_impl", "dm", testDone.messageId);
  f.updateTask(1, "a_impl", "T1", { status: "in_review", resultCommit: "c7d8e9f" });
  const ready = f.dm(1, {
    from: "a_impl",
    to: "a_rev",
    body: "T1 is ready again at c7d8e9f: CRLF fix plus the specialist's parse_crlf_quoted test.",
  });
  f.done(0.5, "a_impl", testDone.deliveryId, testDone.messageId);
  f.checkpoint(1, "a_impl", 3);
  f.sleep(0.5, "a_impl");

  f.wake(1, "a_rev", "dm", ready.messageId);
  f.tool(3, "a_rev", "bash", "git fetch origin && git checkout c7d8e9f");
  f.tool(5, "a_rev", "bash", "npm test");
  f.verify(18, "a_rev", "c7d8e9f", "npm test", true, "15 passed");
  f.updateTask(1, "a_rev", "T1", { status: "done" });
  const approved = f.team(2, {
    from: "a_rev",
    body: "@orchestrator T1 is approved at c7d8e9f.",
    mentions: ["a_orch"],
  });
  f.done(0.5, "a_rev", ready.deliveryId, ready.messageId);
  f.checkpoint(1, "a_rev", 3);
  f.sleep(0.5, "a_rev");

  finish(f, approved, "c7d8e9f", [
    { id: "a_impl", sandbox: "sb-1b2", checkpoint: 4 },
    { id: "a_rev", sandbox: "sb-2c3", checkpoint: 4 },
    { id: "a_spec", sandbox: "sb-3e4", checkpoint: 2 },
  ]);
  return { name: "third-worker", events: f.events() };
}
