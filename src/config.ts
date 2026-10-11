import { z } from "zod";

const environment = z.object({
  MONGODB_URI: z.string().min(1),
  MONGODB_DATABASE: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default("atoi"),
  ADMIN_TOKEN: z.string().min(32),
  AGENT_TOKEN_SECRET: z.string().min(32),
  BACKEND_PUBLIC_URL: z.url(),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().default("atoi-agents"),
  MODAL_APP_NAME: z.string().default("atoi-agents"),
  MODAL_IMAGE_TAG: z.string().default("node:24-bookworm-slim"),
  MODAL_MODEL_SECRET: z.string().optional(),
  ATOI_MODEL_API_KEY: z.string().optional(),
  MODAL_GIT_SECRET: z.string().optional(),
  PI_PROVIDER: z.string().min(1),
  PI_MODEL: z.string().min(1),
  TURN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).multipleOf(1000).default(180_000),
  TURN_MODEL_REQUESTS: z.coerce.number().int().min(1).max(100).default(12),
  TURN_TOOL_CALLS: z.coerce.number().int().min(1).max(200).default(40),
});
export type Config = z.infer<typeof environment>;
export function readConfig(): Config {
  const result = environment.safeParse(process.env);
  if (!result.success)
    throw new Error(
      `Configuration required: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  return result.data;
}
