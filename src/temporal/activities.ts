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
          const sandboxId = await modal.create(agent, run);
          try {
            await store.bindSandbox(agentId, sandboxId);
          } catch (error) {
            await modal.stop(sandboxId);
            throw error;
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
        return { work: result.outcome === "completed" };
      } finally {
        clearInterval(timer);
      }
    },
    async stopAgent(agentId: string): Promise<void> {
      const agent = await store.getAgent(agentId);
      if (agent.sandboxId) await modal.stop(agent.sandboxId);
      await modal.stopNamed(agentId);
      if (agent.invocationId)
        await store.uncertain(
          agentId,
          agent.invocationId,
          "Run stopped during invocation; effects may be incomplete",
        );
      await store.agents.updateOne(
        { _id: agentId },
        { $set: { status: "stopped", sandboxId: null } },
      );
      const remaining = await store.agents.countDocuments({
        runId: agent.runId,
        $or: [{ sandboxId: { $ne: null } }, { status: { $ne: "stopped" } }],
      });
      if (!remaining)
        await store.runs.updateOne(
          { _id: agent.runId, status: "stopping" },
          { $set: { status: "stopped" } },
        );
    },
    async expireRun(runId: string): Promise<void> {
      await store.stopRun(runId);
    },
  };
}
export type Activities = ReturnType<typeof createActivities>;
