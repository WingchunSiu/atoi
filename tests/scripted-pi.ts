import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

// Explicitly scripted model responses. Pi itself executes tools and persists its
// native session; this fixture makes no real inference or provider-quality claim.
export async function scriptedPi(
  session: AgentSession,
  turns: Array<ToolCall[] | string>,
  observe?: (context: string) => void,
) {
  await session.modelRuntime.setRuntimeApiKey(
    session.model!.provider,
    "scripted-fixture-key-never-sent-to-a-provider",
  );
  let index = 0;
  session.agent.streamFunction = (model, context) => {
    observe?.(JSON.stringify(context));
    const next = turns[index++];
    if (next === undefined) throw new Error("Scripted model fixture exhausted");
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: typeof next === "string" ? [{ type: "text", text: next }] : next,
      stopReason: typeof next === "string" ? "stop" : "toolUse",
      timestamp: Date.now(),
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({
      type: "done",
      reason: typeof next === "string" ? "stop" : "toolUse",
      message,
    });
    stream.end();
    return stream;
  };
}
export const tool = (id: string, name: string, args: ToolCall["arguments"]): ToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
