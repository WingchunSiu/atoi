import { z } from "zod";

// These contracts describe a Pi invocation, not a transport or an organization chart.
export const harnessId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);

export const invocationBudget = z.object({
  timeoutMs: z.number().int().min(1000).max(600_000).multipleOf(1000),
  modelRequests: z.number().int().min(1).max(100),
  toolCalls: z.number().int().min(1).max(200),
});

export const piInvocation = z.object({
  agentId: harnessId,
  runId: harnessId,
  invocationId: harnessId,
  generation: z.number().int().positive(),
  provider: z.string().min(1),
  model: z.string().min(1),
  prompt: z.string().min(1).max(200_000),
  checkpoint: z.string().max(6_000_000).nullable(),
  budget: invocationBudget,
});
export type PiInvocation = z.infer<typeof piInvocation>;

export const piResult = z.object({
  invocationId: harnessId,
  generation: z.number().int().positive(),
  outcome: z.enum(["completed", "failed", "limited"]),
  text: z.string().max(128_000),
  checkpoint: z.string().max(6_000_000),
  checkpointSha256: z.string().regex(/^[a-f0-9]{64}$/),
  usage: z.object({
    input: z.number(),
    output: z.number(),
    cache: z.number().optional(),
    cost: z.number(),
    toolCalls: z.number(),
    modelRequests: z.number(),
    elapsedMs: z.number(),
  }),
  error: z.string().max(4000).optional(),
});
export type PiResult = z.infer<typeof piResult>;
