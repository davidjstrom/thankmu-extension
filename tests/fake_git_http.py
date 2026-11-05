#!/usr/bin/env python3
"""Minimal authenticated git smart-HTTP server for tests (wraps `git http-backend`).
Usage: fake_git_http.py <repos-root> <port-file> <log-file> <repo-dir>=<token> [<repo-dir>=<token> ...]
Requires HTTP Basic auth as user 'oauth2' with the token registered for the repo in the request path
(first path segment, e.g. mir-ubo.git); a token valid for another repo, or an unknown repo, gets 401.
If the backend exits non-zero or writes to stderr, the server answers 500 with that stderr as the body and
appends the exit status and stderr to <log-file>, so a test can assert the log stays empty.
"""
import base64, http.server, os, subprocess, sys

ROOT, PORT_FILE, LOG_FILE = sys.argv[1:4]
WANT = {}
for pair in sys.argv[4:]:
    repo, _, token = pair.partition("=")
    if not repo or not token:
        sys.exit(f"bad repo=token argument: {repo!r}")
    WANT[repo] = "Basic " + base64.b64encode(f"oauth2:{token}".encode()).decode()
if not WANT:
    sys.exit("no repo=token arguments given")
BACKEND = os.path.join(subprocess.check_output(["git", "--exec-path"], text=True).strip(), "git-http-backend")


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def handle_any(self):
        # Drain the request body before answering, so an early 401 cannot deadlock a client still sending it.
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        repo = self.path.lstrip("/").split("/", 1)[0]
        want = WANT.get(repo)
        if want is None or self.headers.get("Authorization") != want:
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="t"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        path, _, query = self.path.partition("?")
        env = {
            "PATH": os.environ["PATH"], "GIT_PROJECT_ROOT": ROOT, "GIT_HTTP_EXPORT_ALL": "1",
            "PATH_INFO": path, "QUERY_STRING": query, "REQUEST_METHOD": self.command,
            "CONTENT_TYPE": self.headers.get("Content-Type", ""), "CONTENT_LENGTH": str(len(body)),
            "REMOTE_USER": "oauth2", "REMOTE_ADDR": "127.0.0.1",
        }
        if self.headers.get("Content-Encoding"):
            env["HTTP_CONTENT_ENCODING"] = self.headers["Content-Encoding"]
        res = subprocess.run([BACKEND], input=body, env=env, capture_output=True)
        if res.returncode != 0 or res.stderr:
            with open(LOG_FILE, "a") as f:
                f.write(f"{self.command} {self.path}: backend exit {res.returncode}: {res.stderr.decode(errors='replace')}\n")
            msg = res.stderr or f"git-http-backend exited {res.returncode}".encode()
            self.send_response(500)
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return
        out = res.stdout
        head, _, payload = out.partition(b"\r\n\r\n")
        status, headers = "200 OK", []
        for line in head.decode().split("\r\n"):
            k, _, v = line.partition(": ")
            if k.lower() == "status":
                status = v
            elif k:
                headers.append((k, v))
        self.send_response(int(status.split()[0]))
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = do_POST = handle_any


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(PORT_FILE, "w").write(str(srv.server_address[1]))
srv.serve_forever()
