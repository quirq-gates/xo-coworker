#!/usr/bin/env python3
"""Tests for serve.py: which requests it answers, and what reaches the backend.

    python3 tests/serve.test.py

Starts serve.py's Handler on an ephemeral port, with XO_API pointed at a tiny
backend in this process that records every request it gets. Standard library only.
"""

from __future__ import annotations

import http.client
import importlib.util
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODER_HOST = "5180--main--ws--someone.coder.example"
REBIND_HOST = "rebind.attacker.example"


# ── a backend that records what it was sent ──────────────────────────────────
SEEN: list[dict] = []  # {"method", "path", "headers"} of every request the backend got


class Backend(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _answer(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        SEEN.append({"method": self.command, "path": self.path, "headers": dict(self.headers.items()),
                     "body": body})
        data = json.dumps({"method": self.command, "path": self.path}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _answer

    def log_message(self, fmt, *args):
        pass


class Quiet(ThreadingHTTPServer):
    daemon_threads = True


def start(server) -> int:
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]


BACKEND = Quiet(("127.0.0.1", 0), Backend)
os.environ["XO_API"] = f"http://127.0.0.1:{start(BACKEND)}"

# serve.py reads XO_API when imported, so import it now, from the repo root.
_spec = importlib.util.spec_from_file_location("serve", os.path.join(ROOT, "serve.py"))
serve = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(serve)

LOG: list[str] = []


class Handler(serve.Handler):
    def log_message(self, fmt, *args):
        LOG.append(fmt % args)


class RemoteServer(serve.Server):
    """Hands every connection to the Handler as if it came from another machine."""

    def finish_request(self, request, client_address):
        self.RequestHandlerClass(request, ("203.0.113.9", 40000), self)


UI = serve.Server(("127.0.0.1", 0), Handler)
PORT = start(UI)
REMOTE = RemoteServer(("127.0.0.1", 0), Handler)
REMOTE_PORT = start(REMOTE)


def ask(method: str, path: str, headers: dict | list | None = None, body: bytes | None = None,
        port: int = PORT) -> tuple[int, bytes]:
    """Send one request with exactly these headers (no Host unless given); return (status, body)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        items = headers.items() if isinstance(headers, dict) else (headers or [])
        for k, v in items:
            conn.putheader(k, v)
        if body is not None:
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders(body)
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


def local(host: str = "localhost") -> dict:
    return {"Host": f"{host}:{PORT}"}


def coder(**extra) -> dict:
    """Headers as Coder's app proxy sends them: httputil.NewSingleHostReverseProxy passes the browser's
    Host through (the public name, no port) and sets no X-Forwarded-Proto or X-Forwarded-Host
    (coderd/workspaceapps/proxy.go, tailnet.go)."""
    return {"Host": CODER_HOST, "X-Forwarded-For": "198.51.100.20", **extra}


def labelled_proxy(**extra) -> dict:
    """A proxy that does label what it forwards (X-Forwarded-*), as some in front of Coder do."""
    return coder(**{"X-Forwarded-Host": CODER_HOST, "X-Forwarded-Proto": "https", "X-Forwarded-Port": "443", **extra})


def rebinding(**extra) -> dict:
    """What a DNS-rebinding page at http://rebind.attacker.example:<port> sends: its browser
    believes it is same-origin, so the labels match the Host."""
    return {"Host": f"{REBIND_HOST}:{PORT}", "Origin": f"http://{REBIND_HOST}:{PORT}",
            "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", **extra}


SCHEDULE = json.dumps({"name": "x", "command": "touch /tmp/pwned"}).encode()


class HostCheck(unittest.TestCase):
    def setUp(self):
        SEEN.clear()

    def assert_refused(self, status: int, body: bytes):
        self.assertEqual(status, 421, body)
        self.assertEqual(json.loads(body)["detail"]["code"], "bad_host")
        self.assertEqual(SEEN, [], "the backend must never see a refused request")

    def test_localhost(self):
        status, body = ask("GET", "/api/status", local())
        self.assertEqual(status, 200, body)
        self.assertEqual([r["path"] for r in SEEN], ["/api/status"])

    def test_127_0_0_1_write_from_its_own_page(self):
        status, body = ask("POST", "/api/schedules", {
            **local("127.0.0.1"), "Origin": f"http://127.0.0.1:{PORT}", "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json"}, SCHEDULE)
        self.assertEqual(status, 200, body)
        self.assertEqual([(r["method"], r["path"]) for r in SEEN], [("POST", "/api/schedules")])
        self.assertNotIn("Origin", SEEN[0]["headers"])

    def test_ipv6_loopback(self):
        status, body = ask("GET", "/api/status", {"Host": f"[::1]:{PORT}"})
        self.assertEqual(status, 200, body)

    def test_coder_https_host(self):
        status, body = ask("POST", "/api/schedules", coder(**{
            "Origin": f"https://{CODER_HOST}", "Sec-Fetch-Site": "same-origin",
            "Coder-Session-Token": "secret"}), SCHEDULE)
        self.assertEqual(status, 200, body)
        self.assertEqual([r["path"] for r in SEEN], ["/api/schedules"])
        sent = {k.lower() for k in SEEN[0]["headers"]}
        self.assertFalse(sent & {"origin", "coder-session-token", "sec-fetch-site"}, sent)

    def test_coder_page_without_forwarding_labels(self):
        # What Coder actually sends: no X-Forwarded-Proto. The page itself loads, and a write from it goes through.
        status, body = ask("GET", "/", coder())
        self.assertEqual(status, 200, body)
        self.assertIn(b"<!doctype html>", body.lower())
        status, body = ask("POST", "/api/schedules", coder(**{
            "Origin": f"https://{CODER_HOST}", "Sec-Fetch-Site": "same-origin"}), SCHEDULE)
        self.assertEqual(status, 200, body)
        self.assertEqual([r["path"] for r in SEEN], ["/api/schedules"])

    def test_labelled_proxy(self):
        status, body = ask("GET", "/api/status", labelled_proxy())
        self.assertEqual(status, 200, body)

    def test_coder_host_rewritten_to_the_target(self):
        # A proxy that sets Host to its target and keeps the browser's host in X-Forwarded-Host.
        status, body = ask("GET", "/api/status", labelled_proxy(Host=f"127.0.0.1:{PORT}"))
        self.assertEqual(status, 200, body)

    def test_rebinding_host_is_refused_before_the_backend(self):
        self.assert_refused(*ask("POST", "/api/schedules", rebinding(**{"Content-Type": "application/json"}),
                                 SCHEDULE))
        self.assert_refused(*ask("GET", "/api/chat/chats", rebinding()))

    def test_rebinding_page_claiming_https_is_refused(self):
        # A same-origin page can add X-Forwarded-* itself, and its browser runs on this machine.
        # Its Host still carries this server's port, which no https proxy's does.
        forged = rebinding(**{"X-Forwarded-Proto": "https", "X-Forwarded-Host": REBIND_HOST})
        self.assert_refused(*ask("POST", "/api/schedules", forged, SCHEDULE))

    def test_missing_host(self):
        self.assert_refused(*ask("GET", "/api/status", {}))
        self.assert_refused(*ask("GET", "/favicon.svg", {}))

    def test_static_file_with_a_rebinding_host(self):
        self.assert_refused(*ask("GET", "/favicon.svg", rebinding()))
        status, body = ask("GET", "/favicon.svg", local())
        self.assertEqual(status, 200)
        self.assertIn(b"<svg", body)

    def test_unknown_method_with_a_rebinding_host(self):
        # Refused before routing, so not even the 501 for an unknown method.
        self.assert_refused(*ask("PROPFIND", "/", rebinding()))

    def test_other_refusals(self):
        cases = {
            "localhost on another port": {"Host": "localhost:1"},
            "an IP literal without a port": {"Host": "127.0.0.1"},
            "two Host headers": [("Host", f"localhost:{PORT}"), ("Host", f"{REBIND_HOST}:{PORT}")],
            "a malformed Host": {"Host": f"localhost:{PORT}/x"},
            "a rebinding X-Forwarded-Host": {**local(), "X-Forwarded-Host": f"{REBIND_HOST}:{PORT}"},
            "a proxy's host on this port": coder(Host=f"{CODER_HOST}:{PORT}"),
            "a labelled proxy's host on this port": labelled_proxy(Host=f"{CODER_HOST}:{PORT}"),
        }
        for label, headers in cases.items():
            with self.subTest(label):
                self.assert_refused(*ask("GET", "/api/status", headers))

    def test_hostname_from_another_machine(self):
        # Only a proxy on this machine may address this server by a hostname.
        self.assert_refused(*ask("GET", "/api/status", coder(), port=REMOTE_PORT))
        status, _ = ask("GET", "/api/status", {"Host": f"127.0.0.1:{REMOTE_PORT}"}, port=REMOTE_PORT)
        self.assertEqual(status, 200)


class OwnOrigins(unittest.TestCase):
    """The rule itself, for ports a test server can't listen on."""

    def test_hostnames_on_a_default_port_server(self):
        # On 80 a rebinding page's Host has no port, like a proxy's: no hostname can be told apart.
        for own in (80, 443):
            with self.subTest(own):
                self.assertIsNone(serve.own_origins([CODER_HOST], [], True, own))
                self.assertEqual(serve.own_origins(["localhost"], [], True, 80), [("http", "localhost", 80)])

    def test_hostname_origin_is_https(self):
        self.assertEqual(serve.own_origins([CODER_HOST], [], True, 5180), [("https", CODER_HOST, 443)])
        self.assertIsNone(serve.own_origins([f"{CODER_HOST}:5180"], [], True, 5180))
        self.assertIsNone(serve.own_origins([CODER_HOST], [], False, 5180))


class OriginCheck(unittest.TestCase):
    def setUp(self):
        SEEN.clear()

    def post(self, headers: dict) -> int:
        status, _ = ask("POST", "/api/schedules", headers, SCHEDULE)
        return status

    def test_pages_this_server_did_not_serve(self):
        cases = {
            "another site": {**local(), "Origin": "http://evil.example", "Sec-Fetch-Site": "cross-site"},
            "another site without fetch metadata": {**local(), "Origin": "http://evil.example"},
            "another local port": {**local(), "Origin": "http://localhost:3000", "Sec-Fetch-Site": "same-site"},
            "a sandboxed page": {**local(), "Origin": "null", "Sec-Fetch-Site": "same-origin"},
            "the Coder host over http": coder(Origin=f"http://{CODER_HOST}", **{"Sec-Fetch-Site": "same-origin"}),
            "another Coder app": coder(Origin="https://other.coder.example", **{"Sec-Fetch-Site": "same-site"}),
        }
        for label, headers in cases.items():
            with self.subTest(label):
                self.assertEqual(self.post(headers), 403)
        self.assertEqual(SEEN, [])

    def test_no_page(self):
        self.assertEqual(self.post(local()), 200)  # curl, a script


if __name__ == "__main__":
    unittest.main(verbosity=2)
