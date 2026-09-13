import { type Chat, type GeneratorController } from "@lmstudio/sdk";
import OpenAI from "openai";
import {
  type ChatCompletionMessageParam,
  type ChatCompletionMessageToolCall,
  type ChatCompletionTool,
  type ChatCompletionToolMessageParam,
} from "openai/resources/index";
import { configSchematics, globalConfigSchematics } from "./config";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

type ToolCallState = {
  id: string;
  name: string | null;
  index: number;
  arguments: string;
};

type StreamDelta = {
  content?: string | null;
  reasoning_content?: string | null; // ninfer-serve (and vLLM) reasoning field
  reasoning?: string | null; // some other OpenAI-compatible servers
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

/* -------------------------------------------------------------------------- */
/*                               Build helpers                                */
/* -------------------------------------------------------------------------- */

/** Convert Bionic's chat history to OpenAI chat messages. */
function toOpenAIMessages(history: Chat): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];

  for (const message of history) {
    switch (message.getRole()) {
      case "system":
        messages.push({ role: "system", content: message.getText() });
        break;

      case "user":
        messages.push({ role: "user", content: message.getText() });
        break;

      case "assistant": {
        const toolCalls: ChatCompletionMessageToolCall[] = message
          .getToolCallRequests()
          .map(toolCall => ({
            id: toolCall.id ?? "",
            type: "function",
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.arguments ?? {}),
            },
          }));

        messages.push({
          role: "assistant",
          content: message.getText(),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        });
        break;
      }

      case "tool": {
        message.getToolCallResults().forEach(toolCallResult => {
          messages.push({
            role: "tool",
            tool_call_id: toolCallResult.toolCallId ?? "",
            content: toolCallResult.content,
          } as ChatCompletionToolMessageParam);
        });
        break;
      }
    }
  }

  return messages;
}

/** Convert Bionic tool definitions to OpenAI function tools (non-strict: NInfer rejects strict). */
function toOpenAITools(ctl: GeneratorController): ChatCompletionTool[] | undefined {
  const tools = ctl.getToolDefinitions().map<ChatCompletionTool>(t => ({
    type: "function",
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters ?? {},
    },
  }));
  return tools.length ? tools : undefined;
}

/* -------------------------------------------------------------------------- */
/*                         Cold-start / error classification                  */
/* -------------------------------------------------------------------------- */

function errorStatus(err: unknown): number | undefined {
  return typeof (err as any)?.status === "number" ? (err as any).status : undefined;
}

function errorText(err: unknown): string {
  const e = err as any;
  const parts = [e?.message, e?.error?.message, typeof e?.error === "string" ? e.error : undefined];
  return parts.filter(Boolean).join(" | ");
}

/**
 * Errors that mean "no worker is serving yet" on a scale-to-zero Runpod load balancer:
 * connection failures, gateway errors, and the LB's "timed out waiting for worker" 400.
 */
function isColdStartError(err: unknown): boolean {
  if (err instanceof OpenAI.APIConnectionError || err instanceof OpenAI.APIConnectionTimeoutError) {
    return true;
  }
  const status = errorStatus(err);
  if (status === undefined) return false;
  if (status >= 500) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  if (status === 400 && /worker|no workers|not ready|timed out/i.test(errorText(err))) return true;
  return false;
}

function describeError(err: unknown, baseUrl: string): Error {
  const status = errorStatus(err);
  const text = errorText(err);
  if (status === 401 || status === 403) {
    return new Error(
      `Runpod rejected the API key (HTTP ${status}). Set a valid key in the runpod-ninfer plugin's global settings. ${text}`,
    );
  }
  if (status === 404) {
    return new Error(`Endpoint not found (HTTP 404) at ${baseUrl}. Check the base URL. ${text}`);
  }
  return err instanceof Error ? err : new Error(text || String(err));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

/* -------------------------------------------------------------------------- */
/*                            Stream-handling utils                           */
/* -------------------------------------------------------------------------- */

/** Tracks whether we are inside a reasoning block so Bionic renders it as a collapsible block. */
class ReasoningBlock {
  private open = false;
  constructor(private readonly ctl: GeneratorController) {}
  reasoning(text: string) {
    if (!text) return;
    if (!this.open) {
      this.ctl.fragmentGenerated("<think>", { reasoningType: "reasoningStartTag" });
      this.open = true;
    }
    this.ctl.fragmentGenerated(text, { reasoningType: "reasoning" });
  }
  close() {
    if (this.open) {
      this.ctl.fragmentGenerated("</think>", { reasoningType: "reasoningEndTag" });
      this.open = false;
    }
  }
}

async function consumeStream(
  stream: AsyncIterable<any>,
  ctl: GeneratorController,
  block: ReasoningBlock,
  progress: { streamedAnything: boolean },
) {
  let current: ToolCallState | null = null;

  function flushCurrentToolCall() {
    if (current === null || current.name === null) {
      current = null;
      return;
    }
    let args: Record<string, any> = {};
    try {
      args = current.arguments.trim() ? JSON.parse(current.arguments) : {};
    } catch (e) {
      ctl.toolCallGenerationFailed(
        new Error(`Model produced malformed JSON arguments for tool "${current.name}": ${current.arguments}`),
      );
      current = null;
      return;
    }
    ctl.toolCallGenerationEnded({ type: "function", name: current.name, arguments: args, id: current.id });
    current = null;
  }

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta as StreamDelta | undefined;
    if (!delta) continue;

    /* Reasoning (NInfer sends it as a separate field, before content) */
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) {
      progress.streamedAnything = true;
      block.reasoning(reasoning);
    }

    /* Answer text */
    if (delta.content) {
      progress.streamedAnything = true;
      block.close();
      ctl.fragmentGenerated(delta.content);
    }

    /* Tool calls */
    for (const toolCall of delta.tool_calls ?? []) {
      progress.streamedAnything = true;
      block.close();
      const startsNewCall =
        toolCall.id !== undefined || current === null || toolCall.index !== current.index;
      if (startsNewCall) {
        flushCurrentToolCall();
        current = {
          id: toolCall.id ?? `call_${toolCall.index}`,
          name: null,
          index: toolCall.index,
          arguments: "",
        };
        ctl.toolCallGenerationStarted({ toolCallId: current.id });
      }
      if (toolCall.function?.name && current) {
        current.name = toolCall.function.name;
        ctl.toolCallGenerationNameReceived(toolCall.function.name);
      }
      if (toolCall.function?.arguments && current) {
        current.arguments += toolCall.function.arguments;
        ctl.toolCallGenerationArgumentFragmentGenerated(toolCall.function.arguments);
      }
    }

    if (choice?.finish_reason) {
      flushCurrentToolCall();
    }
  }

  flushCurrentToolCall();
  block.close();
}

/* -------------------------------------------------------------------------- */
/*                                     API                                    */
/* -------------------------------------------------------------------------- */

export async function generate(ctl: GeneratorController, history: Chat) {
  const config = ctl.getPluginConfig(configSchematics);
  const global = ctl.getGlobalPluginConfig(globalConfigSchematics);

  const apiKey = global.get("apiKey").trim();
  const baseUrl = global.get("baseUrl").trim().replace(/\/+$/, "");
  const model = global.get("model").trim();
  const coldStartWaitMs = Math.max(0, global.get("coldStartWaitSeconds")) * 1000;

  if (!apiKey) {
    throw new Error(
      "No Runpod API key configured. Open the runpod-ninfer plugin's global settings and paste your key.",
    );
  }
  if (!baseUrl) throw new Error("No endpoint base URL configured for runpod-ninfer.");
  if (!model) throw new Error("No model id configured for runpod-ninfer.");

  const openai = new OpenAI({
    apiKey,
    baseURL: baseUrl,
    maxRetries: 0, // cold-start retries are handled below
    timeout: 10 * 60 * 1000, // a single generation may legitimately run for minutes
  });

  const messages = toOpenAIMessages(history);
  const tools = toOpenAITools(ctl);
  const params: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    max_tokens: config.get("maxTokens"),
    reasoning_effort: config.get("reasoningEffort"),
    ...(tools ? { tools, tool_choice: "auto" } : {}),
  };

  const block = new ReasoningBlock(ctl);
  const progress = { streamedAnything: false };
  const deadline = Date.now() + coldStartWaitMs;
  let attempt = 0;

  while (true) {
    ctl.abortSignal.throwIfAborted();
    attempt += 1;
    try {
      const stream = await openai.chat.completions.create(params as any, { signal: ctl.abortSignal });
      ctl.onAborted(() => (stream as any).controller?.abort());
      await consumeStream(stream as any, ctl, block, progress);
      console.info(`runpod-ninfer: generation completed (attempt ${attempt}).`);
      return;
    } catch (err) {
      if (ctl.abortSignal.aborted) throw err;
      const retryable = !progress.streamedAnything && isColdStartError(err);
      const timeLeft = deadline - Date.now();
      if (!retryable || timeLeft <= 0) {
        block.close();
        throw describeError(err, baseUrl);
      }
      const waitMs = Math.min(10_000, timeLeft);
      console.warn(
        `runpod-ninfer: worker not ready (attempt ${attempt}, ${errorStatus(err) ?? "conn"}: ${errorText(err)}). ` +
          `Retrying in ${Math.round(waitMs / 1000)}s; up to ${Math.round(timeLeft / 1000)}s left for the cold start.`,
      );
      if (attempt === 1) {
        block.reasoning(
          "Runpod worker is cold-starting (downloading and loading the model, usually 4-5 minutes). Waiting...\n",
        );
      } else {
        block.reasoning(".");
      }
      await sleep(waitMs, ctl.abortSignal);
    }
  }
}
