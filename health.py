#!/usr/bin/env python3
"""Health shim for Runpod load-balancer endpoints.

Runpod polls GET /ping on PORT_HEALTH: 200 = healthy, 204 = still initializing, anything else = unhealthy.
ninfer-serve exposes /health (200 when the engine accepts work, 503 after an engine failure) but not /ping,
and it is not listening at all while the model downloads/loads. This shim maps:
  connection refused / timeout  -> 204 (initializing)
  ninfer /health 200            -> 200
  ninfer /health other status   -> that status (unhealthy)
Usage: health.py <health_port> <app_port>
"""
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HEALTH_PORT, APP_PORT = int(sys.argv[1]), int(sys.argv[2])
UPSTREAM = f"http://127.0.0.1:{APP_PORT}/health"


def upstream_status() -> int:
    try:
        with urllib.request.urlopen(UPSTREAM, timeout=2) as r:
            return 200 if r.status == 200 else r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 204


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        code = upstream_status()
        self.send_response(code)
        if code == 200:
            body = b'{"status":"healthy"}'
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_header("Content-Length", "0")
            self.end_headers()

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("0.0.0.0", HEALTH_PORT), Handler).serve_forever()
