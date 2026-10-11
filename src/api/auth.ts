import { createHmac, timingSafeEqual } from "node:crypto";

export function agentToken(secret: string, agentId: string): string {
  return createHmac("sha256", secret).update(`atoi-agent:${agentId}`).digest("hex");
}
export function matchesToken(supplied: string | undefined, expected: string): boolean {
  if (!supplied?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(supplied.slice(7));
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}
