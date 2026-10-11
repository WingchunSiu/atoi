import { expect, test } from "vitest";
import { sandboxName } from "../src/modal/provider.js";

test("dynamic worker names fit Modal's limit without colliding or renaming existing guests", () => {
  const spawnIds = ["a".repeat(64), `${"a".repeat(63)}b`];
  const names = spawnIds.map(sandboxName);
  for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
  expect(new Set(names).size).toBe(2);
  expect(sandboxName(spawnIds[0]!)).toBe(names[0]);
  const legacy = "dc822cf5-dd10-401a-836d-e21bda4e87ac";
  expect(sandboxName(legacy)).toBe(`atoi-${legacy}`);
});
