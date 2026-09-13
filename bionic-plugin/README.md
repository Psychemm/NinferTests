# runpod-ninfer (Bionic / LM Studio generator plugin)

Makes the NInfer + Qwen3.8-27B NVFP4 endpoint on Runpod Serverless selectable as a model inside
Bionic. Streams answers, shows NInfer's reasoning as a collapsible thinking block, forwards
Bionic's tools (tool calling works end to end), and keeps retrying while a scale-to-zero
worker cold-starts.

## Install
```bash
npm install
npm run install-plugin      # = lms dev --install -y  (Bionic must be running)
```

## Configure (once, in Bionic)
Pick the `psychem/runpod-ninfer` model in the model picker, open its plugin settings, and under
the **global** settings paste your **Runpod API key**. Base URL and model id are pre-filled:
- Endpoint base URL: `https://r16nrzitigmjql.api.runpod.ai/v1`
- Model id: `qwen3.8-27b`

Per-chat: reasoning effort (none / low / medium / xhigh) and max output tokens.

## Notes
- First request after idle takes 4-5 minutes (Runpod cold start). The plugin waits up to
  "Cold-start wait" seconds (default 480) and shows a note in the thinking block meanwhile.
- NInfer rejects `strict` tools, named/required tool_choice, logprobs, logit_bias and JSON mode;
  the plugin only sends what it supports.
