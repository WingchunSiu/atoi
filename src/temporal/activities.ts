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
  | "PI_BASE_URL"
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
        if (run.status !== "active" || run.deadline <= new Date()) return { work: false };
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
              instructions: agent.instructions,
              prompt: invocation.prompt,
              checkpoint: await store.checkpoint(agent),
              backendUrl: config.BACKEND_PUBLIC_URL,
              token: agentToken(config.AGENT_TOKEN_SECRET, agentId),
              provider: config.PI_PROVIDER,
              model: config.PI_MODEL,
              modelBaseUrl: config.PI_BASE_URL,
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
        return { work: result.outcome === "completed" };
      } finally {
        clearInterval(timer);
      }
    },
    async stopAgent(agentId: string): Promise<void> {
      const agent = await store.getAgent(agentId);
      if (agent.recovery?.provisioningAttempts?.length)
        throw new Error("Sandbox replacement is still in flight; cleanup unconfirmed");
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
    async replaceAgent(agentId: string, requestId: string): Promise<void> {
      const attempt = await store.beginRecoveryProvisioning(agentId, requestId);
      if (!attempt) return;
      const { agent, attemptId } = attempt;
      try {
        const run = await store.assertActive(agent.runId);
        await store.checkpoint(agent);
        if (agent.sandboxId) await modal.stop(agent.sandboxId);
        // A retry reuses the deterministic replacement name rather than destroying it.
        const sandboxId = await modal.create({ ...agent, sandboxId: null }, run);
        try {
          await store.finishRecovery(agentId, requestId, sandboxId);
        } catch (error) {
          const current = await store.getAgent(agentId);
          if (
            current.recovery?.requestId === requestId &&
            current.recovery.status === "completed" &&
            current.sandboxId === sandboxId
          )
            return;
          await modal.stop(sandboxId);
          throw error;
        }
      } finally {
        await store.endRecoveryProvisioning(agentId, requestId, attemptId);
      }
    },
    async failRecovery(agentId: string, requestId: string): Promise<void> {
      await store.failRecovery(agentId, requestId);
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
      await store.stopRun(runId);
    },
  };
}
export type Activities = ReturnType<typeof createActivities>;
