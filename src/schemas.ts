import { type Static, Type } from "@sinclair/typebox";

export const Id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" });
const Text = (maxLength = 8000) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const Strict = { additionalProperties: false };
export const RunInput = Type.Object(
  {
    objective: Text(),
    repository: Text(2048),
    workerLimit: Type.Integer({ minimum: 1, maximum: 1000 }),
    lifetimeSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 82800 })),
    maxInvocationsPerAgent: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  Strict,
);
export const AgentInput = Type.Object(
  {
    role: Text(200),
    kind: Type.Union([Type.Literal("orchestrator"), Type.Literal("worker")]),
    instructions: Type.Optional(Text(16000)),
    runtimeEnabled: Type.Optional(Type.Boolean()),
    token: Type.String({ minLength: 32, maxLength: 256, pattern: "^[A-Za-z0-9_-]+$" }),
  },
  Strict,
);
export const TaskInput = Type.Object(
  {
    requestId: Id,
    title: Text(300),
    description: Text(),
    acceptanceCriteria: Type.Array(Text(1000), { minItems: 1, maxItems: 20 }),
    dependencies: Type.Array(Id, { maxItems: 50, uniqueItems: true, default: [] }),
  },
  Strict,
);
export const Result = Type.Object(
  { commit: Type.String({ pattern: "^[a-f0-9]{40}$" }), summary: Text(), verification: Text() },
  Strict,
);
export const TaskUpdate = Type.Object(
  {
    expectedVersion: Type.Integer({ minimum: 1 }),
    status: Type.Union([
      Type.Literal("in_progress"),
      Type.Literal("blocked"),
      Type.Literal("in_review"),
      Type.Literal("done"),
    ]),
    reason: Type.Optional(Text()),
    reviewerId: Type.Optional(Id),
    result: Type.Optional(Result),
    review: Type.Optional(
      Type.Object(
        { commit: Type.String({ pattern: "^[a-f0-9]{40}$" }), verification: Text() },
        Strict,
      ),
    ),
  },
  Strict,
);
export const MessageInput = Type.Object(
  {
    requestId: Id,
    body: Text(16000),
    mentions: Type.Array(Id, { uniqueItems: true, maxItems: 100, default: [] }),
    replyTo: Type.Optional(Id),
  },
  Strict,
);
export const DmInput = Type.Object({ peerId: Id }, Strict);
export const PathRun = Type.Object({ runId: Id }, Strict);
export const PathAgent = Type.Object({ runId: Id, agentId: Id }, Strict);
export const PathTask = Type.Object({ runId: Id, taskId: Id }, Strict);
export const PathChannel = Type.Object({ runId: Id, channelId: Id }, Strict);
export const Page = Type.Object(
  { after: Type.Optional(Id), limit: Type.Integer({ minimum: 1, maximum: 100, default: 50 }) },
  Strict,
);
export const MessagePage = Type.Object(
  {
    after: Type.Integer({ minimum: 0, default: 0 }),
    limit: Type.Integer({ minimum: 1, maximum: 100, default: 50 }),
  },
  Strict,
);
export type NewRun = Static<typeof RunInput>;
export type NewAgent = Static<typeof AgentInput>;
export type NewTask = Static<typeof TaskInput>;
export type UpdateTask = Static<typeof TaskUpdate>;
export type NewMessage = Static<typeof MessageInput>;
export type TaskResult = Static<typeof Result>;
