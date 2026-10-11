import { createHash } from "node:crypto";
import { Context } from "@temporalio/activity";
import { agentToken } from "../api/auth.js";
import type { Config } from "../config.js";
import type { ModalAgents } from "../modal/provider.js";
import type { MongoStore } from "../store/mongo.js";

type SandboxOperations = Pick<
  ModalAgents,
  "create" | "invoke" | "confirmedResult" | "stop" | "stopNamed"
>;
type ActivityConfig = Pick<
  Config,
  | "BACKEND_PUBLIC_URL"
  | "AGENT_TOKEN_SECRET"
  | "PI_PROVIDER"
  | "PI_MODEL"
  | "TURN_TIMEOUT_MS"
  | "TURN_MODEL_REQUESTS"
  | "TURN_TOOL_CALLS"
>;

export function createActivities(
  store: MongoStore,
  modal: SandboxOperations,
  config: ActivityConfig,
) {
  return {
    async turn(agentId: string): Promise<{ work: boolean }> {
      const context = Context.current();
      const heartbeat = () => context.heartbeat({ agentId });
      heartbeat();
      const timer = setInterval(heartbeat, 5000);
      try {
        let agent = await store.getAgent(agentId);
        if (!agent.runtimeEnabled) return { work: false };
        const run = await store.getRun(agent.runId);
        if (!["active", "completing"].includes(run.status) || run.deadline <= new Date())
          return { work: false };
        const invocationId = createHash("sha256")
          .update(
            `${context.info.workflowExecution?.runId ?? "standalone"}:${context.info.activityId}`,
          )
          .digest("hex");
        const invocation = await store.beginInvocation(agentId, invocationId);
        if (invocation?.status === "completed")
          return { work: invocation.result?.outcome === "completed" };
        if (!invocation || invocation.status !== "running") return { work: false };
        if (!agent.sandboxId) {
          const provisioningAttempt = await store.beginProvisioning(
            agentId,
            invocation._id,
            invocation.generation,
          );
          try {
            const sandboxId = await modal.create(agent, run);
            try {
              await store.bindSandbox(agentId, sandboxId);
            } catch (error) {
              await modal.stop(sandboxId);
              throw error;
            }
          } finally {
            await store.endProvisioning(invocation._id, provisioningAttempt);
          }
        }
        agent = await store.getAgent(agentId);
        await store.assertInvocation(agentId, invocation._id, invocation.generation);
        const result = await modal
          .invoke(
            agent.sandboxId!,
            {
              agentId,
              runId: agent.runId,
              invocationId: invocation._id,
              generation: invocation.generation,
              role: agent.role,
              kind: agent.kind,
              orchestratorId: run.orchestratorId!,
              workerLimit: run.workerLimit,
              instructions: agent.instructions,
              prompt: invocation.prompt,
              checkpoint: await store.checkpoint(agent),
              backendUrl: config.BACKEND_PUBLIC_URL,
              token: agentToken(config.AGENT_TOKEN_SECRET, agentId),
              provider: config.PI_PROVIDER,
              model: config.PI_MODEL,
              budget: {
                timeoutMs: config.TURN_TIMEOUT_MS,
                modelRequests: config.TURN_MODEL_REQUESTS,
                toolCalls: config.TURN_TOOL_CALLS,
              },
            },
            heartbeat,
            context.cancellationSignal,
          )
          .catch(async () => {
            const confirmed = await modal
              .confirmedResult(agent.sandboxId!, invocation._id)
              .catch(() => null);
            if (confirmed && confirmed.generation === invocation.generation) return confirmed;
            // A lost response may follow a successful external command. Never restart
            // the model turn automatically after this boundary becomes ambiguous.
            await store.uncertain(
              agentId,
              invocation._id,
              "Guest execution or its result could not be confirmed; inspect before resuming",
            );
            return null;
          });
        if (!result) return { work: false };
        // If publication fails, an Activity retry asks the same guest invocation for
        // its cached result. It does not acknowledge the inbox before this commit.
        await store.complete(agentId, result);
        return {
          work:
            result.outcome === "completed" && (await store.getRun(agent.runId)).status === "active",
        };
      } finally {
        clearInterval(timer);
      }
    },
    async stopAgent(agentId: string): Promise<void> {
      const agent = await store.getAgent(agentId);
      if (await store.invocations.findOne({ agentId, "provisioningAttempts.0": { $exists: true } }))
        throw new Error("Sandbox provisioning is still in flight; cleanup unconfirmed");
      if (agent.sandboxId) await modal.stop(agent.sandboxId);
      await modal.stopNamed(agentId);
      if (agent.invocationId)
        await store.uncertain(
          agentId,
          agent.invocationId,
          "Run stopped during invocation; effects may be incomplete",
        );
      await store.confirmCleanup(agentId);
    },
    async failAgent(
      agentId: string,
      workflowRunId: string,
      activityId?: string,
    ): Promise<{ work: boolean }> {
      if (activityId) {
        const invocationId = createHash("sha256")
          .update(`${workflowRunId}:${activityId}`)
          .digest("hex");
        const invocation = await store.invocations.findOne({ _id: invocationId, agentId });
        if (invocation?.status === "completed")
          return { work: invocation.result?.outcome === "completed" };
      }
      const agent = await store.getAgent(agentId);
      if (agent.status === "stopped") return { work: false };
      await store.uncertain(
        agentId,
        agent.invocationId,
        "Agent turn Activity exhausted retries; inspect before resuming",
      );
      return { work: false };
    },
    async expireRun(runId: string): Promise<void> {
      await store.stopRun(runId, "failed", "Run deadline expired or supervisor was stopped");
    },
    async nextWakeup(agentId: string): Promise<number> {
      const agent = await store.getAgent(agentId);
      if (["needs_inspection", "stopped"].includes(agent.status)) return 60000;
      const timer = await store.wakeups
        .find({ agentId, status: "pending" })
        .sort({ wakeAt: 1 })
        .limit(1)
        .next();
      return timer ? Math.max(0, timer.wakeAt.getTime() - Date.now()) : 60000;
    },
    async superviseRun(runId: string): Promise<{ finished: boolean; nextCheckMs: number }> {
      const run = await store.getRun(runId);
      if (!["active", "completing"].includes(run.status)) return { finished: true, nextCheckMs: 0 };
      const orchestrator = run.orchestratorId ? await store.getAgent(run.orchestratorId) : null;
      if (run.status === "completing" && run.completion) {
        const completion = run.completion;
        if (completion.status === "checkpointed") {
          await store.stopRun(runId, "completed");
          return { finished: true, nextCheckMs: 0 };
        }
        if (
          completion.status === "failed" ||
          orchestrator?.status === "needs_inspection" ||
          completion.deadline <= new Date()
        ) {
          await store.stopRun(
            runId,
            "failed",
            completion.error ?? "Final orchestrator checkpoint failed or timed out",
          );
          return { finished: true, nextCheckMs: 0 };
        }
        return {
          finished: false,
          nextCheckMs: Math.max(1, Math.min(1000, completion.deadline.getTime() - Date.now())),
        };
      }
      if (orchestrator?.status === "needs_inspection") {
        await store.stopRun(
          runId,
          "failed",
          "Orchestrator failed; pending effects require inspection",
        );
        return { finished: true, nextCheckMs: 0 };
      }
      return { finished: false, nextCheckMs: 60000 };
    },
  };
}
export type Activities = ReturnType<typeof createActivities>;
