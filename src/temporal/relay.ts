import {
  type Client,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import type { MongoStore } from "../store/mongo.js";

export async function reconcile(
  store: MongoStore,
  client: Client,
  taskQueue: string,
): Promise<void> {
  // The Atlas run record itself is a durable supervisor-start request. A failed
  // API response or missed outbox wakeup cannot strand an accepted run.
  for (const run of await store.runs.find({ status: "active" }).toArray()) {
    try {
      await client.workflow.start("runSupervisor", {
        workflowId: `run/${run._id}`,
        taskQueue,
        args: [run._id, run.deadline.getTime()],
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
    // A failure-report Activity may itself fail while Atlas is unavailable.
    // Inspect closed workflows before dispatching any new wakeup for leased work.
    for (const agent of await store.agents
      .find({
        runId: run._id,
        runtimeEnabled: true,
        status: { $in: ["pending", "running"] },
      })
      .toArray()) {
      if (
        !(await store.deliveries.findOne({
          recipientId: agent._id,
          status: { $in: ["pending", "processing"] },
        }))
      )
        continue;
      try {
        const execution = await client.workflow.getHandle(`agent/${agent._id}`).describe();
        if (
          ["FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT"].includes(execution.status.name) ||
          (execution.status.name === "COMPLETED" && agent.status === "running")
        )
          await store.uncertain(
            agent._id,
            agent.invocationId,
            `Agent workflow ${execution.status.name} with outstanding work; inspect before resuming`,
          );
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) throw error;
      }
    }
  }
  // Acknowledging a cleanup dispatch is not the same as successful termination.
  // Retain failed outcomes and retry a bounded number of cleanup workflows.
  for (const run of await store.runs.find({ status: "stopping" }).toArray()) {
    for (const event of await store.outbox
      .find({ runId: run._id, kind: "stop", status: "sent" })
      .toArray()) {
      const execution = await client.workflow.getHandle(`cleanup/${event.recipientId}`).describe();
      if (["FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT"].includes(execution.status.name)) {
        await store.outbox.updateOne(
          { _id: event._id },
          {
            $set: {
              status: (event.attempts ?? 0) >= 3 ? "sent" : "pending",
              error: `Cleanup ${execution.status.name}; ${(event.attempts ?? 0) >= 3 ? "retry limit reached; operator inspection required" : "queued for retry"}`,
            },
          },
        );
      }
    }
  }
  for (const event of await store.outbox.find({ status: "pending" }).limit(100).toArray()) {
    try {
      const run = await store.getRun(event.runId);
      if (event.kind === "mailbox_wakeup" && run.status === "active") {
        if ((await store.getAgent(event.recipientId)).status === "needs_inspection") continue;
        await client.workflow.signalWithStart("agentWorkflow", {
          workflowId: `agent/${event.recipientId}`,
          taskQueue,
          args: [event.recipientId],
          signal: "wake",
          signalArgs: [],
        });
      } else if (event.kind === "stop") {
        // Cleanup has an independent workflow so a failed planner/agent workflow
        // cannot prevent resource termination.
        try {
          await client.workflow.getHandle(`agent/${event.recipientId}`).signal("stop");
        } catch {
          /* The separate cleanup workflow remains authoritative. */
        }
        try {
          await client.workflow.start("cleanupAgentWorkflow", {
            workflowId: `cleanup/${event.recipientId}`,
            taskQueue,
            args: [event.recipientId],
          });
        } catch (error) {
          if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        }
      }
      await store.outbox.updateOne(
        { _id: event._id },
        { $set: { status: "sent" }, $inc: { attempts: 1 } },
      );
    } catch (error) {
      // Keep the request pending and expose the failure; later reconciliation retries it.
      await store.outbox.updateOne(
        { _id: event._id },
        {
          $set: { error: error instanceof Error ? error.name : "RelayError" },
          $inc: { attempts: 1 },
        },
      );
    }
  }
}
