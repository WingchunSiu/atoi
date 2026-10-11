import { readFile } from "node:fs/promises";
import { AlreadyExistsError, ModalClient, NotFoundError, type Sandbox } from "modal";
import { type WorkerRequest, type WorkerResult, workerResult } from "../contracts/runtime.js";
import type { Agent, Run } from "../store/mongo.js";

export interface ModalOptions {
  appName: string;
  imageTag: string;
  modelSecret?: string;
  modelApiKey?: string;
  gitSecret?: string;
}

export class ModalAgents {
  constructor(
    readonly client: ModalClient,
    private readonly options: ModalOptions,
  ) {}

  async create(agent: Agent, run: Run): Promise<string> {
    if (this.options.gitSecret && new URL(run.repository).hostname !== "github.com")
      throw new Error("The GitHub token helper accepts only github.com repositories");
    const app = await this.client.apps.fromName(this.options.appName, {
      createIfMissing: true,
    });
    const name = `atoi-${agent._id}`;
    let sandbox: Sandbox;
    try {
      sandbox = await this.client.sandboxes.fromName(this.options.appName, name);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      const [manifest, lockfile] = await Promise.all([
        readFile("package.json"),
        readFile("pnpm-lock.yaml"),
      ]);
      const image = this.client.images
        .fromRegistry(this.options.imageTag)
        .dockerfileCommands([
          "RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep fd-find python3 curl ca-certificates && rm -rf /var/lib/apt/lists/*",
          "RUN mkdir -p /opt/atoi /workspace /var/lib/atoi",
          `RUN printf '%s' '${manifest.toString("base64")}' | base64 -d > /opt/atoi/package.json`,
          `RUN printf '%s' '${lockfile.toString("base64")}' | base64 -d > /opt/atoi/pnpm-lock.yaml`,
          "RUN npm install --global pnpm@11.19.0",
          "RUN cd /opt/atoi && pnpm install --prod --frozen-lockfile --ignore-scripts",
        ]);
      const secrets = await Promise.all(
        [this.options.modelSecret, this.options.gitSecret]
          .filter((item): item is string => Boolean(item))
          .map((secret) => this.client.secrets.fromName(secret)),
      );
      if (this.options.modelApiKey)
        secrets.push(
          await this.client.secrets.fromObject({ ATOI_MODEL_API_KEY: this.options.modelApiKey }),
        );
      const remainingMs = run.deadline.getTime() - Date.now();
      if (remainingMs < 1000) throw new Error("Run deadline expired before sandbox provisioning");
      try {
        sandbox = await this.client.sandboxes.create(app, image, {
          name,
          tags: { project: "atoi", runId: run._id, agentId: agent._id },
          timeoutMs: Math.floor(Math.min(remainingMs, 23 * 60 * 60 * 1000) / 1000) * 1000,
          cpu: 1,
          memoryMiB: 2048,
          secrets,
          env: {
            GIT_ASKPASS: "/opt/atoi/git-askpass.sh",
            GIT_TERMINAL_PROMPT: "0",
          },
        });
      } catch (error) {
        if (!(error instanceof AlreadyExistsError)) throw error;
        sandbox = await this.client.sandboxes.fromName(this.options.appName, name);
      }
    }
    try {
      // No provider credentials or backend code are copied into the guest.
      await sandbox.filesystem.copyFromLocal("dist/guest/worker.mjs", "/opt/atoi/worker.mjs");
      await sandbox.filesystem.writeText(
        '#!/bin/sh\ncase "$1" in *Username*) printf "%s" "x-access-token";; *Password*) printf "%s" "$GITHUB_TOKEN";; *) exit 1;; esac\n',
        "/opt/atoi/git-askpass.sh",
      );
      const permissions = await sandbox.exec(["chmod", "700", "/opt/atoi/git-askpass.sh"]);
      if ((await permissions.wait()) !== 0) throw new Error("Git credential helper setup failed");
      const init = await sandbox.exec(
        [
          "bash",
          "-c",
          'set -eu; if [ ! -d /workspace/repo/.git ]; then git clone -- "$1" /workspace/repo; fi; git -C /workspace/repo config user.name "atoi agent"; git -C /workspace/repo config user.email "agent@atoi.invalid"',
          "atoi-init",
          run.repository,
        ],
        { timeoutMs: 120_000 },
      );
      const [code] = await Promise.all([
        init.wait(),
        init.stdout.readText(),
        init.stderr.readText(),
      ]);
      if (code !== 0) throw new Error("Sandbox Git initialization failed; check repository access");
      return sandbox.sandboxId;
    } finally {
      sandbox.detach();
    }
  }

  async invoke(
    sandboxId: string,
    request: WorkerRequest,
    heartbeat: () => void,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    const sandbox = await this.client.sandboxes.fromId(sandboxId);
    let interval: NodeJS.Timeout | undefined;
    const abort = () => {
      void sandbox.terminate().catch(() => undefined);
    };
    try {
      if (signal?.aborted) throw new Error("Invocation cancelled before execution");
      signal?.addEventListener("abort", abort, { once: true });
      // Credentials travel in stdin, not process arguments or command logs.
      const process = await sandbox.exec(["node", "/opt/atoi/worker.mjs"], {
        timeoutMs: request.budget.timeoutMs + 30_000,
      });
      interval = setInterval(heartbeat, 5000);
      await process.stdin.writeText(JSON.stringify(request));
      await process.stdin.close();
      const [code, stdout] = await Promise.all([
        process.wait(),
        process.stdout.readText(),
        process.stderr.readText(),
      ]);
      if (code !== 0)
        throw new Error(`Guest invocation exited ${code}; external effects may be unconfirmed`);
      const result = workerResult.parse(JSON.parse(stdout));
      if (result.invocationId !== request.invocationId || result.generation !== request.generation)
        throw new Error("Guest result belongs to a different invocation");
      return result;
    } finally {
      if (interval) clearInterval(interval);
      signal?.removeEventListener("abort", abort);
      sandbox.detach();
    }
  }

  async confirmedResult(sandboxId: string, invocationId: string): Promise<WorkerResult | null> {
    const sandbox = await this.client.sandboxes.fromId(sandboxId);
    try {
      const cached = JSON.parse(
        await sandbox.filesystem.readText(`/var/lib/atoi/${invocationId}.json`),
      ) as { result: unknown };
      const result = workerResult.parse(cached.result);
      if (result.invocationId !== invocationId)
        throw new Error("Cached result belongs to another invocation");
      return result;
    } finally {
      sandbox.detach();
    }
  }

  async stop(sandboxId: string): Promise<void> {
    let sandbox: Sandbox;
    try {
      sandbox = await this.client.sandboxes.fromId(sandboxId);
    } catch (error) {
      if (error instanceof NotFoundError) return;
      throw error;
    }
    try {
      await sandbox.terminate({ wait: true });
    } finally {
      sandbox.detach();
    }
  }

  async stopNamed(agentId: string): Promise<void> {
    let sandbox: Sandbox;
    try {
      sandbox = await this.client.sandboxes.fromName(this.options.appName, `atoi-${agentId}`);
    } catch (error) {
      if (error instanceof NotFoundError) return;
      throw error;
    }
    try {
      await sandbox.terminate({ wait: true });
    } finally {
      sandbox.detach();
    }
  }
}
