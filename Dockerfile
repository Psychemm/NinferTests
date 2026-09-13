# syntax=docker/dockerfile:1
# NInfer (https://github.com/Neroued/ninfer) serving Qwen3.8-27B NVFP4 as a Runpod Serverless
# load-balancer worker on an RTX 5090.
#
# Build stage mirrors upstream's own Dockerfile (nvidia/cuda 13.1.2, sm_120a). The runtime stage adds
# curl (downloads the model artifact at startup) and python3 (health shim for the load balancer).
#
# Pinned upstream commit (master, 2026-09-10). Bump NINFER_REF to update the engine.
ARG NINFER_REF=d49296868dcc17bd478ec185f0d3a801bcc0bf56

FROM nvidia/cuda:13.1.2-devel-ubuntu24.04 AS build
ARG NINFER_REF
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        cmake \
        git \
        libavcodec-dev \
        libavformat-dev \
        libavutil-dev \
        libcurl4-openssl-dev \
        libswscale-dev \
        ninja-build \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone https://github.com/Neroued/ninfer.git . \
    && git checkout --detach "${NINFER_REF}" \
    && git submodule update --init --recursive

RUN cmake -S . -B /build -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DNINFER_BUILD_APPS=ON \
        -DBUILD_TESTING=OFF \
        -DNINFER_BUILD_BENCHMARKS=OFF \
    && cmake --build /build --parallel --target ninfer ninfer-serve

FROM nvidia/cuda:13.1.2-runtime-ubuntu24.04

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        curl \
        python3 \
        libavcodec60 \
        libavformat60 \
        libavutil58 \
        libcurl4t64 \
        libswscale7 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /build/apps/ninfer /usr/local/bin/ninfer
COPY --from=build /build/apps/ninfer-serve /usr/local/bin/ninfer-serve
COPY health.py /health.py
COPY start.sh /start.sh
RUN chmod +x /start.sh /health.py

# Runpod load balancer contract: app on PORT, health probe on PORT_HEALTH (GET /ping).
ENV PORT=8080 \
    PORT_HEALTH=8081

WORKDIR /workspace
EXPOSE 8080 8081
STOPSIGNAL SIGTERM

CMD ["/start.sh"]
