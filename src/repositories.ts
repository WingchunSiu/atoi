import { z } from "zod";
import { HarnessError } from "./contracts/runtime.js";

export function repositoryKey(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HarnessError(400, "Use a GitHub HTTPS repository URL");
  }
  const match = /^\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match
  )
    throw new HarnessError(
      400,
      "Use https://github.com/owner/repository without credentials, queries, or fragments",
    );
  return `${match[1]}/${match[2]}`.toLowerCase();
}

export const repositorySecretsSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  },
  z
    .record(z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/), z.string().min(1))
    .default({})
    .transform((entries) =>
      Object.fromEntries(
        Object.entries(entries).map(([key, secret]) => [key.toLowerCase(), secret]),
      ),
    ),
);

export function repositorySecret(repository: string, secrets: Record<string, string>): string {
  const key = repositoryKey(repository);
  const secret = Object.hasOwn(secrets, key) ? secrets[key] : undefined;
  if (!secret)
    throw new HarnessError(
      400,
      `Repository ${key} is not configured. Add a repository-scoped Modal Git secret to GITHUB_REPOSITORIES and restart the backend.`,
    );
  return secret;
}
