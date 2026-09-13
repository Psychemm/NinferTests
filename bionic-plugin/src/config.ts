import { createConfigSchematics } from "@lmstudio/sdk";

/** Per-chat settings (shown in the chat's plugin settings panel). */
export const configSchematics = createConfigSchematics()
  .field(
    "reasoningEffort",
    "select",
    {
      displayName: "Reasoning effort",
      subtitle: "How much the model thinks before answering (NInfer reasoning_effort).",
      options: [
        { value: "none", displayName: "none (no thinking)" },
        { value: "low", displayName: "low" },
        { value: "medium", displayName: "medium" },
        { value: "xhigh", displayName: "xhigh" },
      ],
    },
    "medium",
  )
  .field(
    "maxTokens",
    "numeric",
    {
      displayName: "Max output tokens",
      subtitle: "Upper bound on generated tokens per reply (thinking included).",
      int: true,
      min: 1,
      max: 131072,
    },
    8192,
  )
  .build();

/** Global settings (shared by every chat that uses this generator). */
export const globalConfigSchematics = createConfigSchematics()
  .field(
    "apiKey",
    "string",
    {
      displayName: "Runpod API key",
      subtitle: "Runpod console -> Settings -> API Keys. Sent as a Bearer token to the endpoint.",
      isProtected: true,
      placeholder: "rpa_...",
    },
    "",
  )
  .field(
    "baseUrl",
    "string",
    {
      displayName: "Endpoint base URL",
      subtitle: "OpenAI-compatible base URL of the Runpod load-balancer endpoint (ends in /v1).",
      placeholder: "https://<endpoint-id>.api.runpod.ai/v1",
    },
    "https://r16nrzitigmjql.api.runpod.ai/v1",
  )
  .field(
    "model",
    "string",
    {
      displayName: "Model id",
      subtitle: "Must match the artifact's model id served by ninfer-serve.",
      placeholder: "qwen3.8-27b",
    },
    "qwen3.8-27b",
  )
  .field(
    "coldStartWaitSeconds",
    "numeric",
    {
      displayName: "Cold-start wait (seconds)",
      subtitle:
        "How long to keep retrying while a Runpod worker boots (model download + load is ~4-5 min).",
      int: true,
      min: 0,
      max: 1800,
    },
    480,
  )
  .build();
