import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type WorkerRequest, type WorkerResult, workerRequest } from "../contracts/runtime.js";
import { executePiTurn, sha256 } from "../harness/pi-runtime.js";
import { ActivityReporter } from "./activity.js";
import { AgentBackend } from "./backend.js";
import { collaborationPrompt } from "./prompts.js";
import { coordinationTools } from "./tools.js";

export { redact, sha256 } from "../harness/pi-runtime.js";

export interface RuntimeOptions {
  workspace: string;
  stateDirectory: string;
  configureSession?: (session: AgentSession) => void | Promise<void>;
  backend?: AgentBackend;
}

/** Cloud-demo adapter. The Pi core has no backend URL, role hierarchy or provider lifecycle. */
export async function executeTurn(
  input: WorkerRequest,
  options: RuntimeOptions,
): Promise<WorkerResult> {
  const request = workerRequest.parse(input);
  const backend = options.backend ?? new AgentBackend(request);
  const secrets = [request.token, process.env.ATOI_MODEL_API_KEY, process.env.GITHUB_TOKEN];
  return executePiTurn(request, {
    placement: {
      runId: request.runId,
      agentId: request.agentId,
      // The existing Modal adapter still provisions one environment/workspace per agent.
      environmentId: request.agentId,
      workspaceId: request.agentId,
      workspace: options.workspace,
      stateDirectory: options.stateDirectory,
    },
    profile: {
      id: "cloud-team-v1",
      systemPrompt: collaborationPrompt(request),
      bind: ({ sessionId }) => ({
        tools: coordinationTools(backend, request.invocationId, sessionId, secrets, request.kind),
        observer: new ActivityReporter(backend, request.invocationId, sessionId, secrets),
      }),
    },
    cacheContext: sha256(JSON.stringify(request)),
    secrets,
    configureSession: options.configureSession,
  });
}
