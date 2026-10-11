import { expect, it } from "vitest";
import { repositoryKey, repositorySecret, repositorySecretsSchema } from "../src/repositories.js";

it("normalizes GitHub URLs and selects only the repository's scoped secret", () => {
  const secrets = repositorySecretsSchema.parse(
    '{"Owner/One":"one-secret","owner/two":"two-secret"}',
  );
  expect(repositoryKey("https://github.com/Owner/One.git")).toBe("owner/one");
  expect(repositorySecret("https://github.com/owner/one", secrets)).toBe("one-secret");
  expect(repositorySecret("https://github.com/owner/two.git", secrets)).toBe("two-secret");
  expect(() => repositorySecret("https://github.com/owner/three.git", secrets)).toThrow(
    "not configured",
  );
  for (const url of [
    "https://github.com.evil/owner/one",
    "https://token@github.com/owner/one",
    "https://github.com/owner/one?token=x",
    "https://github.com/owner/one#x",
    "http://github.com/owner/one",
    "https://github.com/owner/one/tree/main",
  ])
    expect(() => repositoryKey(url)).toThrow();
  expect(repositorySecretsSchema.safeParse("invalid").success).toBe(false);
});
