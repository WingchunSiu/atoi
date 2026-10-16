import { z } from "zod";
import { harnessId, piInvocation, piResult } from "../harness/contracts.js";

export const id = harnessId;
export const repositoryUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "Use an HTTPS Git URL without embedded credentials");
export const runInput = z
  .object({
    requestId: id,
    objective: z.string().min(1).max(16_000),
    repositoryUrl: repositoryUrl.optional(),
    workerLimit: z.number().int().min(0).max(8).default(2),
    lifetimeSeconds: z
      .number()
      .int()
      .min(60)
      .max(23 * 60 * 60)
      .default(3600),
    maxInvocationsPerAgent: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export type RunInput = z.infer<typeof runInput>;

export const spawnInput = z
  .object({
    requestId: id,
    role: z.string().trim().min(1).max(100),
    instructions: z.string().trim().min(1).max(16_000),
  })
  .strict();
export type SpawnInput = z.infer<typeof spawnInput>;

export const finishInput = z
  .object({
    requestId: id,
    finalCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    outcome: z.string().trim().min(1).max(8000),
    evidence: z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
  })
  .strict();
export type FinishInput = z.infer<typeof finishInput>;

export const wakeupInput = z
  .object({
    requestId: id,
    delaySeconds: z.number().int().min(1).max(3600),
    note: z.string().trim().min(1).max(4000),
  })
  .strict();

export const sendInput = z.object({
  requestId: id,
  body: z.string().min(1).max(32_000),
  recipientId: id.optional(),
  mentions: z.array(id).max(9).default([]),
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

// HTTP/Modal-specific fields are added here, outside the Pi invocation contract.
export const workerRequest = piInvocation.extend({
  role: z.string().min(1).max(100),
  kind: z.enum(["orchestrator", "worker"]),
  orchestratorId: id,
  workerLimit: z.number().int().min(0).max(8),
  instructions: z.string().max(16_000),
  backendUrl: z.url(),
  token: z.string().min(32),
});
export type WorkerRequest = z.infer<typeof workerRequest>;

export const workerResult = piResult;
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
