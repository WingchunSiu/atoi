import { z } from "zod";

export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const repositoryUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "Use an HTTPS Git URL without embedded credentials");
export const runInput = z.object({
  requestId: id,
  objective: z.string().min(1).max(16_000),
  repositoryUrl,
  agents: z
    .array(
      z.object({
        role: z.string().min(1).max(100),
        instructions: z.string().max(16_000),
      }),
    )
    .min(1)
    .max(8),
  lifetimeSeconds: z
    .number()
    .int()
    .min(60)
    .max(23 * 60 * 60)
    .default(3600),
  maxInvocationsPerAgent: z.number().int().min(1).max(100).default(20),
});
export type RunInput = z.infer<typeof runInput>;

export const sendInput = z.object({
  requestId: id,
  body: z.string().min(1).max(32_000),
  recipientId: id.optional(),
  mentions: z.array(id).max(8).default([]),
});
export type SendInput = z.infer<typeof sendInput>;

export const eventInput = z.object({
  requestId: id,
  type: z.enum([
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
  ]),
  sessionId: id.optional(),
  payload: z.unknown(),
});

export const workerRequest = z.object({
  agentId: id,
  runId: id,
  invocationId: id,
  generation: z.number().int().positive(),
  role: z.string().min(1).max(100),
  instructions: z.string().max(16_000),
  prompt: z.string().min(1).max(200_000),
  backendUrl: z.url(),
  token: z.string().min(32),
  provider: z.string().min(1),
  model: z.string().min(1),
  checkpoint: z.string().max(6_000_000).nullable(),
  budget: z.object({
    timeoutMs: z.number().int().min(1000).max(600_000).multipleOf(1000),
    modelRequests: z.number().int().min(1).max(100),
    toolCalls: z.number().int().min(1).max(200),
  }),
});
export type WorkerRequest = z.infer<typeof workerRequest>;

export const workerResult = z.object({
  invocationId: id,
  generation: z.number().int().positive(),
  outcome: z.enum(["completed", "failed", "limited"]),
  text: z.string().max(128_000),
  checkpoint: z.string().max(6_000_000),
  checkpointSha256: z.string().regex(/^[a-f0-9]{64}$/),
  usage: z.object({
    input: z.number(),
    output: z.number(),
    cost: z.number(),
    toolCalls: z.number(),
    modelRequests: z.number(),
    elapsedMs: z.number(),
  }),
  error: z.string().max(4000).optional(),
});
export type WorkerResult = z.infer<typeof workerResult>;

export class HarnessError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export const workLogInput = z.object({
  requestId: id,
  sessionId: id.optional(),
  taskId: id.optional(),
  note: z.string().min(1).max(16000),
  nextStep: z.string().max(4000).optional(),
  evidence: z.array(z.string().min(1).max(2000)).max(10).default([]),
});
