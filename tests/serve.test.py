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
import socket
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODER_HOST = "5180--main--ws--someone.coder.example"
REBIND_HOST = "rebind.attacker.example"


# ── a backend that records what it was sent ──────────────────────────────────
SEEN: list[dict] = []  # {"method", "path", "headers", "body"} of every request the backend got


class Backend(BaseHTTPRequestHandler):
    """Answers JSON; a WebSocket handshake gets a 101, a greeting, then an echo of every byte
    until the client sends b"quit" or goes away."""
    protocol_version = "HTTP/1.1"

    def _answer(self):
        if self.headers.get("Upgrade", "").lower() == "websocket":
            return self._echo()
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

    def _echo(self):
        SEEN.append({"method": self.command, "path": self.path, "headers": dict(self.headers.items()),
                     "body": b""})
        self.close_connection = True
        self.wfile.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                         b"Connection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\nhello|")
        while (chunk := self.rfile.read1(65536)) and chunk != b"quit":
            self.wfile.write(chunk)

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


SESSION = "/api/terminal/sessions/term_0123456789abcdef/ws"


def handshake(path: str = SESSION, headers: dict | None = None, method: str = "GET") -> bytes:
    headers = {**local(), "Origin": f"http://localhost:{PORT}", "Upgrade": "websocket", "Connection": "Upgrade",
               "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13",
               **(headers or {})}
    return (f"{method} {path} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in headers.items())
            + "\r\n").encode()


def read_until(sock: socket.socket, want: bytes, have: bytes = b"") -> bytes:
    """Read from `sock` until `want` has arrived (or the peer closes, or 5 s pass)."""
    sock.settimeout(5)
    while want not in have:
        chunk = sock.recv(65536)
        if not chunk:
            break
        have += chunk
    return have


def wait_for(cond, seconds: float = 5) -> bool:
    end = time.monotonic() + seconds
    while not cond() and time.monotonic() < end:
        time.sleep(0.01)
    return cond()


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


class Tunnel(unittest.TestCase):
    def setUp(self):
        SEEN.clear()
        LOG.clear()
        self.sock = socket.create_connection(("127.0.0.1", PORT), timeout=5)

    def tearDown(self):
        self.sock.close()

    def open(self, path: str = SESSION, headers: dict | None = None, method: str = "GET",
             then: bytes = b"") -> bytes:
        """Send a handshake (and `then`, in the same packet); return what came back up to the greeting."""
        self.sock.sendall(handshake(path, headers, method) + then)
        return read_until(self.sock, b"hello|")

    def refused(self, status: int, code: str, *args, **kwargs):
        got = read_until(self.sock, b"}}", self.open(*args, **kwargs))
        self.assertTrue(got.startswith(b"HTTP/1.1 %d " % status), got)
        self.assertIn(b'"code":"%s"' % code.encode(), got)
        self.assertEqual(SEEN, [], "the backend must never see a refused upgrade")

    def test_bytes_flow_both_ways(self):
        # Bytes sent right behind the handshake reach the backend too (they sat in rfile's buffer).
        got = self.open(then=b"early|")
        self.assertTrue(got.startswith(b"HTTP/1.1 101 "), got)
        got = read_until(self.sock, b"early|", got)
        self.assertTrue(got.endswith(b"hello|early|"), got)
        for i in range(3):
            self.sock.sendall(b"key%d|" % i)
            self.assertTrue(read_until(self.sock, b"key%d|" % i).endswith(b"key%d|" % i))
        big = os.urandom(300_000)
        self.sock.sendall(big)
        got = b""
        while len(got) < len(big):
            chunk = self.sock.recv(65536)
            self.assertTrue(chunk, "the tunnel closed early")
            got += chunk
        self.assertEqual(got, big)

    def test_forwarded_handshake(self):
        self.open(SESSION + "?coder_session_token=secret&x=1", coder(**{
            "Origin": f"https://{CODER_HOST}", "Cookie": "coder_session_token=secret; a=b",
            "Coder-Session-Token": "secret", "Sec-WebSocket-Protocol": "xo.term", "User-Agent": "test",
            "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "websocket"}))
        self.assertEqual(len(SEEN), 1)
        self.assertEqual(SEEN[0]["path"], SESSION)  # no query: no token
        sent = {k.lower(): v for k, v in SEEN[0]["headers"].items()}
        self.assertEqual(set(sent), {"host", "upgrade", "connection", "sec-websocket-key", "sec-websocket-version",
                                     "sec-websocket-protocol"})
        self.assertEqual(sent["host"], serve._UP.netloc)
        self.assertNotIn("secret", json.dumps(SEEN[0]["headers"]))

    def test_logs_open_and_close_without_the_query(self):
        # Its own session id: another test's tunnel may still be logging its close.
        path = "/api/terminal/sessions/term_logs_0123456789/ws"
        mine = lambda: [line for line in LOG if path in line]
        self.open(path + "?coder_session_token=secret")
        self.sock.sendall(b"quit")  # the backend ends: the browser's side is shut too
        self.assertEqual(read_until(self.sock, b"never"), b"")
        self.assertTrue(wait_for(lambda: len(mine()) == 2), LOG)
        self.assertEqual(mine(), [f"WebSocket open {path}", f"WebSocket closed {path}"])

    def test_browser_going_away_closes_the_backend_side(self):
        path = "/api/terminal/sessions/term_away_0123456789/ws"
        self.open(path)
        self.sock.close()
        self.assertTrue(wait_for(lambda: f"WebSocket closed {path}" in LOG), LOG)

    def test_other_upgrades_are_refused(self):
        cases = {
            "another API path": ("/api/chat/chats/ws", {}, "GET", 404, "not_found"),
            "a short session id": ("/api/terminal/sessions/abc/ws", {}, "GET", 404, "not_found"),
            "a static path": ("/index.html", {}, "GET", 404, "not_found"),
            "a dot segment": ("/api/terminal/sessions/%2e%2e/sessions/term_0123456789abcdef/ws", {}, "GET",
                              400, "bad_target"),
            "not websocket": (SESSION, {"Upgrade": "h2c"}, "GET", 400, "bad_upgrade"),
            "a POST": (SESSION, {"Content-Length": "0"}, "POST", 400, "bad_upgrade"),
        }
        for label, (path, headers, method, status, code) in cases.items():
            with self.subTest(label):
                self.sock.close()
                self.sock = socket.create_connection(("127.0.0.1", PORT), timeout=5)
                self.refused(status, code, path, headers, method)

    def test_page_from_another_site(self):
        self.refused(403, "cross_origin", headers={"Origin": "http://evil.example"})

    def test_rebinding_host(self):
        self.refused(421, "bad_host", headers=rebinding(Origin=f"http://{REBIND_HOST}:{PORT}"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
