import { expect, test } from "vitest";
import { operatorDmRecipient } from "../src/state/chat";
import { fold, peerKey } from "../src/state/reduce";
import { ev } from "./helpers";

test("operator DMs target the selected worker without enabling peer impersonation", () => {
  const state = fold([
    ev({ type: "agent.spawned", agentId: "orch", role: "orchestrator", kind: "orchestrator" }),
    ev({ type: "agent.spawned", agentId: "worker", role: "reviewer", kind: "worker" }),
  ]);
  expect(operatorDmRecipient(state, peerKey("user", "worker"))).toBe("worker");
  expect(operatorDmRecipient(state, peerKey("user", "orch"))).toBe("orch");
  expect(operatorDmRecipient(state, peerKey("orch", "worker"))).toBeUndefined();
  expect(operatorDmRecipient(state, peerKey("user", "unknown"))).toBeUndefined();
  expect(operatorDmRecipient(state, null)).toBeUndefined();
});
