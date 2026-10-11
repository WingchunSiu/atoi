import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { type Activity, watchActivity } from "../src/client/activity.js";

it("decodes fragmented UTF-8 SSE frames and reconnects with the last consumed cursor", async () => {
  const seen: Activity[] = [];
  const requests: Array<{ after: string | null; lastId: string | undefined }> = [];
  const event = (sequence: number): Activity => ({
    _id: `event-${sequence}`,
    runId: "run",
    agentId: "agent",
    generation: 1,
    sequence,
    type: "message_end",
    payload: { text: "你好" },
    createdAt: "2026-10-11T00:00:00Z",
  });
  const frame = (sequence: number) =>
    `id: ${sequence}\r\nevent: activity\r\ndata: ${JSON.stringify(event(sequence))}\r\n\r\n`;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    requests.push({
      after: url.searchParams.get("after"),
      lastId: request.headers["last-event-id"] as string | undefined,
    });
    expect(request.headers.authorization).toBe("Bearer test-token");
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (requests.length === 1) {
      const bytes = Buffer.from(": heartbeat\r\n\r\n" + frame(1));
      const split = bytes.indexOf(Buffer.from("你好")) + 1;
      response.write(bytes.subarray(0, split));
      setTimeout(() => response.end(bytes.subarray(split)), 5);
    } else response.end(frame(1) + frame(2)); // repeated delivery is ignored
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5000);
  try {
    await watchActivity({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: "test-token",
      runId: "run",
      signal: abort.signal,
      onEvent: (event) => {
        seen.push(event);
        if (seen.length === 2) abort.abort();
      },
    });
    expect(seen.map((event) => event.sequence)).toEqual([1, 2]);
    expect(seen[0]!.payload).toEqual({ text: "你好" });
    expect(requests[1]).toEqual({ after: "1", lastId: "1" });
  } finally {
    clearTimeout(timer);
    abort.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
