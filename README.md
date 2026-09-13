# NInfer + Qwen3.8-27B (NVFP4) on Runpod Serverless (RTX 5090)

Runpod builds this repo's `Dockerfile` itself (Serverless -> GitHub integration), so no local Docker
or registry is needed. The image compiles [Neroued/ninfer](https://github.com/Neroued/ninfer) at a pinned
commit for `sm_120a` (RTX 5090) and, at worker start, downloads
[neroued/Qwen3.8-27B-nvfp4-NInfer](https://huggingface.co/neroued/Qwen3.8-27B-nvfp4-NInfer) (22.1 GiB),
verifies it, and runs `ninfer-serve` as a **load-balancer** worker with an OpenAI/Anthropic-compatible API.

## Files
- `Dockerfile` - two-stage build (CUDA 13.1.2 devel -> runtime). Bump `NINFER_REF` to update the engine.
- `start.sh`   - worker entrypoint: health shim, model download + sha256, `exec ninfer-serve`.
- `health.py`  - answers Runpod's `GET /ping` probe (204 while loading, 200 when ninfer is ready).

## One-time setup (console)
1. Create a GitHub repo (private is fine) containing these four files at the root.
2. Runpod console -> Settings -> Connections -> GitHub -> **Connect** (grant access to that repo).
3. Serverless -> **New Endpoint** -> **Import Git Repository** -> pick the repo, branch `main`,
   Dockerfile path `Dockerfile` -> Next.
4. Endpoint settings:
   - **Endpoint Type: Load Balancer**  (cannot be changed later)
   - GPU: **RTX 5090** (the 32 GB PRO pool) only
   - Workers: min 0, max 1; idle timeout 300 s; FlashBoot on
   - Container disk: **50 GB** (the model lives on it)
   - Env: `PORT=8080`, `PORT_HEALTH=8081`
5. Deploy. The first build compiles NInfer (expect 10-25 min; Runpod's docker-build limit is 30 min).

Everything else (CUDA floor, GPU pool, env tuning, warm-up, verification) can be managed through the
Runpod MCP / API afterwards.

## Using it
Base URL: `https://<ENDPOINT_ID>.api.runpod.ai` (Runpod enforces `Authorization: Bearer <RUNPOD_API_KEY>`).

```bash
curl -s https://<ENDPOINT_ID>.api.runpod.ai/v1/chat/completions \
  -H "Authorization: Bearer $RUNPOD_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"qwen3.8-27b","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":64}'
```
Also served: `POST /v1/messages` (Anthropic-style), `POST /v1/responses`, `GET /v1/models`, `GET /health`.
The `model` field must be `qwen3.8-27b` (the artifact's model id).

## Tuning (endpoint env vars)
- `NINFER_ARGS` - full flag string passed to `ninfer-serve` (default: 131072 context, `--kv-capacity auto`,
  2 lanes, fp8 KV, MTP speculative decoding with 3 draft tokens, `--lm-head-draft`).
- `MODEL_REPO` / `MODEL_FILE` / `MODEL_BYTES` / `MODEL_SHA256` - serve a different `.ninfer` artifact.
- `HF_TOKEN` - only for gated/private Hugging Face repos.
- `VERIFY_SHA256=1` - re-hash the artifact on every start (slow; fresh downloads are always hashed).

## Cold starts and cost
Scale-to-zero: idle cost is $0. A cold start downloads the 22 GiB artifact to the container disk
(a few minutes) and then loads it; the worker bills at the RTX 5090 serverless rate while doing so.
A longer idle timeout trades idle cost for fewer cold starts. Mount a network volume if Runpod ever
offers one in a 5090 region and the artifact will persist at `/runpod-volume/models`.
