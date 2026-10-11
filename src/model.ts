import type { NewRun, NewTask, TaskResult } from "./schemas.js";

export interface Run extends NewRun {
  _id: string;
  status: "active" | "stopping" | "stopped";
  deadline: Date;
  eventSequence?: number;
  maxInvocationsPerAgent: number;
  workerCount: number;
  orchestratorId: string | null;
  createdAt: Date;
}
export interface Agent {
  _id: string;
  runId: string;
  role: string;
  kind: "orchestrator" | "worker";
  status: "pending" | "idle" | "running" | "needs_inspection" | "stopped";
  instructions: string;
  runtimeEnabled: boolean;
  generation: number;
  turns: number;
  toolEpoch: number;
  sandboxId: string | null;
  checkpointId: string | null;
  invocationId: string | null;
  tokenHash: string;
  createdAt: Date;
}
export type PublicAgent = Omit<Agent, "tokenHash">;
export interface Channel {
  _id: string;
  runId: string;
  kind: "team" | "dm";
  participants: string[];
  nextSequence: number;
  createdAt: Date;
}
export interface Task extends NewTask {
  _id: string;
  runId: string;
  createdBy: string;
  fingerprint: string;
  status: "open" | "in_progress" | "blocked" | "in_review" | "done";
  ownerId: string | null;
  reviewerId: string | null;
  version: number;
  result?: TaskResult;
  review?: { commit: string; verification: string };
  reason?: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface Message {
  _id: string;
  runId: string;
  channelId: string;
  senderId: string;
  requestId: string;
  fingerprint: string;
  body: string;
  mentions: string[];
  recipients: string[];
  replyTo?: string;
  sequence: number;
  createdAt: Date;
}
// Only atomic checkpoint publication acknowledges processed deliveries.
export interface Delivery {
  _id: string;
  runId: string;
  recipientId: string;
  messageId: string;
  channelId: string;
  sequence: number;
  status: "pending" | "processing" | "completed";
  invocationId?: string;
  generation?: number;
  createdAt: Date;
}
export interface OutboxEvent {
  _id: string;
  runId: string;
  recipientId: string;
  deliveryId?: string;
  kind: "mailbox_wakeup" | "stop";
  status: "pending" | "sent";
  attempts?: number;
  error?: string;
  createdAt: Date;
}
export interface AgentEvent {
  _id: string;
  runId: string;
  actorId: string;
  kind: string;
  entityId: string;
  createdAt: Date;
  details: Record<string, unknown>;
  sequence: number;
  generation?: number;
  sessionId?: string;
  requestHash?: string;
}
export interface Actor {
  agentId: string;
  runId: string;
  invocationId?: string;
  generation?: number;
}
export class Problem extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function requireValue<T>(value: T | null | undefined, message = "Resource not found"): T {
  if (value == null) throw new Problem(404, "not_found", message);
  return value;
}
