// Durability story: the reviewer sleeps, wakes on a DM and on a timer, keeps its place through a
// Temporal worker restart, and survives a sandbox replacement while a message waits in its inbox.
import { type Fixture, fixture, OBJECTIVE, REPO, T1 } from "./builder";

export function recovery(): Fixture {
  const f = fixture({ runId: "r_recovery", start: "2026-10-11T14:00:00Z" });

  // 1. Quick setup: three agents, all waiting; the reviewer is checkpointed and suspended.
  f.after(0, {
    type: "run.state",
    status: "starting",
    objective: OBJECTIVE,
    repo: REPO,
    workerLimit: 2,
  });
  f.after(1, { type: "run.state", status: "running" });
  f.spawn(1, "a_orch", "orchestrator", "orchestrator");
  f.provision(0.5, "a_orch", "sb-0a1");
  f.spawn(1, "a_impl", "implementer", "worker", "a_orch");
  f.spawn(0.5, "a_rev", "reviewer", "worker", "a_orch");
  f.provision(0.5, "a_impl", "sb-1b2", "running");
  f.provision(0.5, "a_rev", "sb-2c3");
  f.task(0.5, "a_orch", { ...T1, status: "in_progress", ownerId: "a_impl" });
  f.after(1, { type: "checkpoint", agentId: "a_rev", action: "saved", version: 3 });
  f.sandbox(1, "a_rev", "suspended", "sb-2c3");
  f.tool(2, "a_impl", "edit", "src/parse.ts");

  // 2. Wake on a DM.
  const question = f.dm(3, {
    from: "a_impl",
    to: "a_rev",
    body: "Quick check: does T1 need the Windows fixture?",
  });
  f.wake(1, "a_rev", "dm", question.messageId);
  f.sandbox(0.5, "a_rev", "running", "sb-2c3");
  f.tool(2, "a_rev", "read_channel", "dm with implementer, 1 message");
  const answer = f.dm(3, {
    from: "a_rev",
    to: "a_impl",
    replyTo: question.messageId,
    body: "No. T1 only needs the quoted-newline cases. The Windows fixture belongs to the CRLF work.",
  });
  f.done(0.5, "a_rev", question.deliveryId, question.messageId);
  f.checkpoint(1, "a_rev", 4);
  const wakeAt = f.at(121.4);
  f.sleep(0.5, "a_rev", { wakeAt, detail: "re-run the full suite in 2 minutes" });
  f.sandbox(0.6, "a_rev", "suspended", "sb-2c3");
  f.done(1, "a_impl", answer.deliveryId, answer.messageId);
  f.tool(4, "a_impl", "bash", "npm test");

  // 3. Wake on the timer.
  f.wake((Date.parse(wakeAt) - Date.parse(f.at())) / 1000, "a_rev", "timer", "timer_1");
  f.sandbox(0.5, "a_rev", "running", "sb-2c3");
  f.tool(2, "a_rev", "bash", "npm test");
  f.checkpoint(20, "a_rev", 5);
  f.sleep(0.5, "a_rev");
  f.sandbox(0.6, "a_rev", "suspended", "sb-2c3");

  // 4. A DM waits while the Temporal worker restarts; the reviewer wakes once afterwards.
  f.tool(3, "a_impl", "bash", "git push origin task/T1");
  f.push(2, "a_impl", "task/T1", "b4e5f6a", "Handle quoted newlines and CRLF in CSV fields");
  const pending = f.dm(2, {
    from: "a_impl",
    to: "a_rev",
    body: "Pushed b4e5f6a to task/T1. Can you run the CRLF cases against it?",
  });
  f.after(1.5, { type: "worker.restarted" });
  f.wake(4, "a_rev", "dm", pending.messageId);
  f.sandbox(0.5, "a_rev", "running", "sb-2c3");
  f.tool(2, "a_rev", "bash", "git fetch origin && git checkout b4e5f6a");
  f.tool(3, "a_rev", "bash", "npm test -- crlf");
  f.verify(9, "a_rev", "b4e5f6a", "npm test -- crlf", true, "4 passed");
  f.done(0.5, "a_rev", pending.deliveryId, pending.messageId);
  f.sleep(0.5, "a_rev");

  // 5. The reviewer's sandbox is lost; a follow-up arrives while it recovers.
  f.sandbox(3, "a_rev", "terminated", "sb-2c3");
  f.state(0.5, "a_rev", "recovering", { generation: 2, detail: "replacing sandbox" });
  const followUp = f.dm(1.5, {
    from: "a_impl",
    to: "a_rev",
    body: "Follow-up: please also check the empty-file case.",
  });

  // 6. A new sandbox restores checkpoint v5 and handles the waiting message.
  f.sandbox(1, "a_rev", "starting", "sb-9d4");
  f.sandbox(5, "a_rev", "running", "sb-9d4");
  f.after(1, { type: "checkpoint", agentId: "a_rev", action: "restored", version: 5 });
  f.wake(1, "a_rev", "dm", followUp.messageId);
  f.tool(2, "a_rev", "bash", "git fetch origin");
  f.tool(3, "a_rev", "bash", "npm test -- empty-file");
  f.done(6, "a_rev", followUp.deliveryId, followUp.messageId);
  const checked = f.dm(1, {
    from: "a_rev",
    to: "a_impl",
    replyTo: followUp.messageId,
    body: "Checked the empty-file case on b4e5f6a. It passes.",
  });
  f.checkpoint(1, "a_rev", 6);
  f.sleep(0.5, "a_rev");

  // 7. A relay failure, then the reconciler fixes it.
  f.after(2, {
    type: "failure.recorded",
    failureId: "f_relay_1",
    scope: "relay",
    message: `Wakeup for delivery ${checked.deliveryId} failed to send`,
    resolved: false,
  });
  f.after(6, {
    type: "failure.recorded",
    failureId: "f_relay_1",
    scope: "relay",
    message: `Reconciler resent the wakeup for ${checked.deliveryId}`,
    resolved: true,
  });
  f.done(1, "a_impl", checked.deliveryId, checked.messageId);
  f.tool(2, "a_impl", "read_channel", "dm with reviewer, 1 message");

  return { name: "recovery", events: f.events() };
}
