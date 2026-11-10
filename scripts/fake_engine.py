"""A stand-in OpenAI-style engine for the smoke test: /v1/models and /v1/chat/completions, streamed or not, with usage.

Usage: python3 fake_engine.py --host 127.0.0.1 --port 8080
Only the standard library, so a host recipe that runs it needs no packages.
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "fake-engine"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))
        sys.stderr.flush()

    def send(self, code, body, kind="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.split("?")[0] == "/v1/models":
            return self.send(200, {"object": "list", "data": [{"id": MODEL, "object": "model"}]})
        self.send(404, {"error": "not found"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.path != "/v1/chat/completions":
            return self.send(404, {"error": "not found"})
        if not body.get("messages"):
            return self.send(400, {"error": "messages required"})
        n = max(1, min(int(body.get("max_tokens") or 16), 64))
        usage = {"prompt_tokens": 2000, "completion_tokens": n, "total_tokens": 2000 + n}
        if not body.get("stream"):
            return self.send(200, {"id": "x", "object": "chat.completion", "model": MODEL, "usage": usage,
                                   "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok " * n}, "finish_reason": "stop"}]})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        time.sleep(0.05)  # stands in for reading the prompt
        for _ in range(n):
            self.wfile.write(b'data: ' + json.dumps({"choices": [{"index": 0, "delta": {"content": "ok "}}]}).encode() + b"\n\n")
            self.wfile.flush()
            time.sleep(0.002)
        if (body.get("stream_options") or {}).get("include_usage"):
            self.wfile.write(b"data: " + json.dumps({"choices": [], "usage": usage}).encode() + b"\n\n")
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True


if __name__ == "__main__":
    host = sys.argv[sys.argv.index("--host") + 1] if "--host" in sys.argv else "127.0.0.1"
    port = int(sys.argv[sys.argv.index("--port") + 1])
    ThreadingHTTPServer((host, port), Handler).serve_forever()
