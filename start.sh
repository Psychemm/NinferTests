#!/usr/bin/env bash
# Runpod Serverless (load balancer) worker entrypoint: fetch the NInfer artifact, then serve it.
set -euo pipefail

PORT="${PORT:-8080}"
PORT_HEALTH="${PORT_HEALTH:-8081}"

# Which artifact to serve (defaults: Qwen3.8-27B NVFP4 for a single RTX 5090).
MODEL_REPO="${MODEL_REPO:-neroued/Qwen3.8-27B-nvfp4-NInfer}"
MODEL_FILE="${MODEL_FILE:-qwen3_8_27b_nvfp4.ninfer}"
MODEL_REVISION="${MODEL_REVISION:-main}"
MODEL_BYTES="${MODEL_BYTES:-23719496192}"
MODEL_SHA256="${MODEL_SHA256:-552c374c685dce302603b95fbe940fb04243c0cd44c083efc644ad3d980d462c}"
VERIFY_SHA256="${VERIFY_SHA256:-0}"   # 1 = always run the full sha256 check (slow on 22 GiB); a fresh download is always checked.

# Model location: a network volume when one is mounted (survives cold starts), else the container disk.
if [ -z "${MODEL_DIR:-}" ]; then
  if [ -d /runpod-volume ] && [ -w /runpod-volume ]; then MODEL_DIR=/runpod-volume/models; else MODEL_DIR=/models; fi
fi
mkdir -p "$MODEL_DIR"
MODEL_PATH="$MODEL_DIR/$MODEL_FILE"

log() { printf '%s  start.sh  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# 1. Health shim: the load balancer polls GET /ping on PORT_HEALTH. The shim answers 204 (initializing)
#    until ninfer-serve's own /health returns 200, so the worker is never marked unhealthy while loading.
python3 /health.py "$PORT_HEALTH" "$PORT" &
log "health shim listening on :$PORT_HEALTH, probing ninfer-serve on :$PORT"

# 2. Model artifact (single file from Hugging Face; resumable; size-checked, sha256-checked when fresh).
url="https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${MODEL_FILE}"
auth=()
if [ -n "${HF_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer ${HF_TOKEN}"); fi
have_bytes() { stat -c %s "$MODEL_PATH" 2>/dev/null || echo 0; }

if [ "$(have_bytes)" != "$MODEL_BYTES" ]; then
  log "downloading ${MODEL_REPO}/${MODEL_FILE} (${MODEL_BYTES} bytes) -> ${MODEL_PATH}"
  t0=$(date +%s)
  curl -fL --retry 5 --retry-delay 5 --retry-all-errors -C - "${auth[@]}" -o "$MODEL_PATH" "$url"
  log "download finished in $(( $(date +%s) - t0 ))s"
  if [ "$(have_bytes)" != "$MODEL_BYTES" ]; then
    log "ERROR: size mismatch after download: $(have_bytes) != ${MODEL_BYTES}"
    exit 1
  fi
  VERIFY_SHA256=1
else
  log "model already present at ${MODEL_PATH} (${MODEL_BYTES} bytes)"
fi

if [ "$VERIFY_SHA256" = "1" ]; then
  log "verifying sha256"
  if ! echo "${MODEL_SHA256}  ${MODEL_PATH}" | sha256sum --check --status; then
    log "ERROR: sha256 mismatch, removing ${MODEL_PATH}"
    rm -f "$MODEL_PATH"
    exit 1
  fi
  log "sha256 ok"
fi

# 3. Serve. Override NINFER_ARGS in the endpoint env to retune (see docs/serving.md upstream).
NINFER_ARGS="${NINFER_ARGS:---max-context 131072 --kv-capacity auto --max-concurrency 2 --kv-dtype fp8 --host-kv-mib 2048 --host-state-slots 2 --spec mtp --draft-tokens 3 --lm-head-draft}"
log "exec ninfer-serve ${MODEL_PATH} --host 0.0.0.0 --port ${PORT} ${NINFER_ARGS}"
# shellcheck disable=SC2086
exec ninfer-serve "$MODEL_PATH" --host 0.0.0.0 --port "$PORT" $NINFER_ARGS
