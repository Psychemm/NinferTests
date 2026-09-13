#!/usr/bin/env python3
"""Health shim for Runpod load-balancer endpoints.

Runpod polls GET /ping on PORT_HEALTH. It terminates a worker that has not reported healthy
within roughly 8 minutes of starting, and our boot (22 GiB model download + load) can take
longer than that. So this shim answers 200 OK as soon as the container is up, which keeps the
worker alive; the client (the LM Studio plugin) probes /v1/models itself and retries until
ninfer-serve is actually listening. Once ninfer-serve is up, /ping mirrors its /health so an
engine failure (503) still marks the worker unhealthy.
  ninfer unreachable (still booting) -> 200 {"status":"starting"}
  ninfer /health 200                 -> 200 {"status":"healthy"}
  ninfer /health other status        -> that status (unhealthy)
Usage: health.py <health_port> <app_port>
"""
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HEALTH_PORT, APP_PORT = int(sys.argv[1]), int(sys.argv[2])
UPSTREAM = f"http://127.0.0.1:{APP_PORT}/health"


def upstream_status():
    try:
        with urllib.request.urlopen(UPSTREAM, timeout=2) as r:
            return (200, b'{"status":"healthy"}') if r.status == 200 else (r.status, b"")
    except urllib.error.HTTPError as e:
        return (e.code, b"")
    except Exception:
        return (200, b'{"status":"starting"}')


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/ping", "/health"):   # GET /ping -> 200 OK while booting and when ready
            code, body = upstream_status()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", HEALTH_PORT), Handler).serve_forever()
