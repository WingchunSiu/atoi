import type { WorkerRequest } from "../contracts/runtime.js";

export class AgentBackend {
  constructor(
    private readonly config: Pick<
      WorkerRequest,
      "backendUrl" | "runId" | "agentId" | "token" | "invocationId" | "generation"
    >,
  ) {}

  async request(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(`/runs/${this.config.runId}${path}`, this.config.backendUrl);
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.config.token}`,
        "content-type": "application/json",
        "x-invocation-id": this.config.invocationId,
        "x-agent-generation": String(this.config.generation),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`Harness request failed (${response.status}): ${await response.text()}`);
    return response.json();
  }
}
