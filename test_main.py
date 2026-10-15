import os

# Must be set before importing main so no real database or API key is needed.
os.environ["DATABASE_URL"] = "sqlite://"
os.environ["GEMINI_API_KEY"] = "test-key"
os.environ["RATE_LIMIT"] = "5/minute"
os.environ["GLOBAL_RATE_LIMIT"] = "200/day"
os.environ["RATELIMIT_STORAGE_URI"] = "memory://"
os.environ["MAX_CONCURRENT_SUMMARIES"] = "4"
os.environ["FRONTEND_URLS"] = ""

from unittest.mock import patch

import pytest
import urllib3
from unittest.mock import MagicMock
from urllib.parse import urlparse
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import main

ARTICLE = {"title": "Test Article", "body": "Some readable article text."}
LONG_P = "x" * 40


class FakeResponse:
    def __init__(self, html="", status=200, headers=None):
        self.content = html.encode()
        self.status = status
        self.headers = {"Content-Type": "text/html", **(headers or {})}
        self.closed = False

    def read1(self, amt, decode_content=False):
        data, self.content = self.content[:amt], self.content[amt:]
        return data

    def close(self):
        self.closed = True


def public_target(url):
    return urlparse(url), "example.com", "93.184.215.14"


def transport(response):
    return patch.object(
        main, "open_pinned_connection", return_value=(MagicMock(), response)
    )


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("PERSIST_SUMMARIES", "true")
    with main._cache_lock:
        main._summary_cache.clear()
    test_engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    main.Base.metadata.create_all(bind=test_engine)
    TestSession = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    main.app.dependency_overrides[main.get_db] = override_get_db
    main.limiter.enabled = False
    test_client = TestClient(main.app)
    test_client.test_sessions = TestSession
    yield test_client
    main.app.dependency_overrides.clear()
    main.limiter.enabled = True


def post(client, **overrides):
    payload = {
        "url": "https://example.com/a",
        "length": "medium",
        "bullets": 2,
    }
    payload.update(overrides)
    return client.post("/scrape", json=payload)


# ---- endpoint behaviour ---------------------------------------------------
def test_successful_summary_is_returned_and_saved(client):
    with (
        patch.object(main, "extract_article_data", return_value=ARTICLE),
        patch.object(main, "generate_summary", return_value=["Point A", "Point B"]),
    ):
        response = post(client)

    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Test Article"
    assert body["summary"] == ["Point A", "Point B"]

    with client.test_sessions() as session:
        saved = session.query(main.Summary).all()
        assert len(saved) == 1
        assert saved[0].summary.split("\n") == ["Point A", "Point B"]


def test_rejects_non_http_url(client):
    response = post(client, url="ftp://example.com/file")
    assert response.status_code == 400
    assert "Invalid URL format" in response.json()["detail"]


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8000/admin",
        "http://169.254.169.254/latest/meta-data",
        "http://10.0.0.5/internal",
        "http://[::1]/",
    ],
)
def test_blocks_private_and_internal_addresses(client, url):
    response = post(client, url=url)
    assert response.status_code == 400
    assert "isn't allowed" in response.json()["detail"]


@pytest.mark.parametrize(
    "overrides", [{"bullets": 500}, {"bullets": 0}, {"length": "huge"}]
)
def test_rejects_out_of_range_options(client, overrides):
    assert post(client, **overrides).status_code == 422


def test_extraction_failure_returns_400(client):
    error = main.ScrapeError(
        "Could not extract readable main content from this website."
    )
    with patch.object(main, "extract_article_data", side_effect=error):
        response = post(client)
    assert response.status_code == 400
    assert "Could not extract" in response.json()["detail"]


def test_ai_failure_returns_500(client):
    with (
        patch.object(main, "extract_article_data", return_value=ARTICLE),
        patch.object(main, "generate_summary", return_value=None),
    ):
        response = post(client)
    assert response.status_code == 500


def test_rate_limit_returns_429(client):
    main.limiter.enabled = True
    main.limiter.reset()
    with (
        patch.object(main, "extract_article_data", return_value=ARTICLE),
        patch.object(main, "generate_summary", return_value=["Point A"]),
    ):
        statuses = [post(client).status_code for _ in range(6)]
    assert statuses[:5] == [200] * 5
    assert statuses[5] == 429


# ---- extraction pipeline --------------------------------------------------
def test_extract_filters_short_paragraphs_and_finds_title():
    html = f"<h1>My Title</h1><p>short</p><p>{LONG_P}</p>"
    with (
        patch.object(main, "resolve_target", side_effect=public_target),
        transport(FakeResponse(html)),
    ):
        result = main.extract_article_data("https://example.com")
    assert result["title"] == "My Title"
    assert "short" not in result["body"]
    assert LONG_P in result["body"]


def test_extract_raises_when_no_readable_content():
    with (
        patch.object(main, "resolve_target", side_effect=public_target),
        transport(FakeResponse("<h1>Hi</h1><p>tiny</p>")),
    ):
        with pytest.raises(main.ScrapeError, match="Could not extract"):
            main.extract_article_data("https://example.com")


def test_extract_reports_timeouts_and_http_errors():
    with patch.object(main, "resolve_target", side_effect=public_target):
        timeout = urllib3.exceptions.ReadTimeoutError(None, "hidden", "timeout")
        with patch.object(main, "open_pinned_connection", side_effect=timeout):
            with pytest.raises(main.ScrapeError, match="too long"):
                main.extract_article_data("https://example.com")

        with transport(FakeResponse(status=403)):
            with pytest.raises(main.ScrapeError, match="403"):
                main.extract_article_data("https://example.com")


def test_redirect_to_internal_address_is_blocked():
    redirect = FakeResponse(status=302, headers={"Location": "http://127.0.0.1/secret"})
    with (
        patch.object(
            main,
            "resolve_target",
            side_effect=[
                public_target("https://example.com"),
                main.ScrapeError("That redirect isn't allowed."),
            ],
        ),
        transport(redirect),
    ):
        with pytest.raises(main.ScrapeError, match="isn't allowed"):
            main.extract_article_data("https://example.com")


# ---- bullet parsing -------------------------------------------------------
def test_parse_bullets_strips_markers_but_keeps_leading_digits():
    text_sample = (
        "- 5G networks grew fast\n**Bold** insight\n1. Numbered point\n- \n\nExtra"
    )
    assert main.parse_bullets(text_sample, 3) == [
        "5G networks grew fast",
        "Bold insight",
        "Numbered point",
    ]


def test_parse_bullets_falls_back_to_plain_lines():
    result = main.parse_bullets("First line\nSecond line", 5)
    assert result == ["First line", "Second line"]


def test_shared_history_disabled_by_default(client, monkeypatch):
    monkeypatch.setenv(
        "ENABLE_SHARED_HISTORY", "true"
    )  # Obsolete flag cannot reopen access.
    assert client.get("/history").status_code == 404
    assert client.patch("/history/1/pin").status_code == 404
    assert client.delete("/history/1").status_code == 404


def test_oversized_page_is_rejected():
    with (
        patch.object(main, "resolve_target", side_effect=public_target),
        transport(FakeResponse("x" * (main.MAX_DOWNLOAD_BYTES + 1))),
    ):
        with pytest.raises(main.ScrapeError, match="too large"):
            main.fetch_page("https://example.com")


def test_inline_markup_preserves_word_boundaries():
    with patch.object(
        main,
        "fetch_page",
        return_value=b"<p>This article has <b>important</b> information about software development.</p>",
    ):
        assert (
            "has important information"
            in main.extract_article_data("https://example.com")["body"]
        )


def test_missing_api_key_returns_controlled_failure(monkeypatch):
    monkeypatch.setattr(main, "_genai_client", None)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    assert main.generate_summary("article", "medium", 3) is None


def test_standalone_bullet_markers_are_ignored():
    assert main.parse_bullets("- \n•\n*\n- Actual insight", 3) == ["Actual insight"]


@pytest.fixture(autouse=True)
def clear_summary_cache():
    with main._cache_lock:
        main._summary_cache.clear()
    yield


@pytest.mark.parametrize(
    "url",
    [
        "http://user:password@example.com/article",
        "https://example.com:8443/a",
        "http://[64:ff9b::7f00:1]/",
        "http://[2002:7f00:1::]/",
        "http://[::ffff:127.0.0.1]/",
        "http://2130706433/",
        "http://example.com\\@127.0.0.1/",
        "https://example.com/\r\nInjected:yes",
        "http://224.0.0.1/",
        "file:///etc/passwd",
    ],
)
def test_rejects_unsafe_url_forms(url):
    # No external DNS is needed for numeric, malformed, or forbidden URLs.
    with patch.object(
        main.dns.resolver.Resolver, "resolve", side_effect=main.dns.resolver.NXDOMAIN
    ):
        assert not main.is_safe_url(url)


def test_mixed_public_private_dns_answers_are_rejected():
    with patch.object(
        main.dns.resolver.Resolver,
        "resolve",
        side_effect=[
            ["93.184.215.14", "127.0.0.1"],
            ["2606:4700:4700::1111"],
        ],
    ):
        assert not main.is_safe_url("https://example.com")


def test_connection_uses_validated_ip_and_original_tls_hostname():
    pool = MagicMock()
    with patch.object(
        main.urllib3, "HTTPSConnectionPool", return_value=pool
    ) as factory:
        main.open_pinned_connection(
            urlparse("https://example.com/path?q=one"),
            "example.com",
            "93.184.215.14",
            10,
        )
    assert factory.call_args.args == ("93.184.215.14",)
    assert factory.call_args.kwargs["assert_hostname"] == "example.com"
    assert factory.call_args.kwargs["server_hostname"] == "example.com"
    assert factory.call_args.kwargs["cert_reqs"] == main.ssl.CERT_REQUIRED
    call = pool.urlopen.call_args
    assert call.args == ("GET", "/path?q=one")
    assert call.kwargs["headers"]["Host"] == "example.com"
    assert call.kwargs["redirect"] is False
    assert call.kwargs["retries"] is False


@pytest.mark.parametrize(
    "headers",
    [
        {"Content-Type": "application/octet-stream"},
        {"Content-Encoding": "gzip"},
        {"Content-Length": "999999999"},
        {"Content-Length": "invalid"},
    ],
)
def test_rejects_unsupported_or_oversized_responses_and_closes_connection(headers):
    response = FakeResponse("article", headers=headers)
    pool = MagicMock()
    with (
        patch.object(main, "resolve_target", side_effect=public_target),
        patch.object(main, "open_pinned_connection", return_value=(pool, response)),
    ):
        with pytest.raises(main.ScrapeError):
            main.fetch_page("https://example.com")
    assert response.closed
    pool.close.assert_called_once()


def test_redirect_chain_is_bounded():
    response = FakeResponse(status=302, headers={"Location": "/again"})
    with (
        patch.object(main, "resolve_target", side_effect=public_target),
        transport(response) as opened,
    ):
        with pytest.raises(main.ScrapeError, match="Too many redirects"):
            main.fetch_page("https://example.com")
    assert opened.call_count == main.MAX_REDIRECTS + 1


def test_response_does_not_leak_network_exception_details():
    with (
        patch.object(main, "resolve_target", side_effect=public_target),
        patch.object(
            main,
            "open_pinned_connection",
            side_effect=OSError("password=secret /internal/path"),
        ),
    ):
        with pytest.raises(main.ScrapeError) as err:
            main.fetch_page("https://example.com")
    assert "secret" not in str(err.value)
    assert "internal" not in str(err.value)


def test_private_history_never_reopens_with_legacy_flag(client, monkeypatch):
    monkeypatch.setenv("ENABLE_SHARED_HISTORY", "true")
    for method, route in [
        ("get", "/history"),
        ("patch", "/history/1/pin"),
        ("delete", "/history/1"),
    ]:
        assert getattr(client, method)(route).status_code == 404


def test_default_does_not_store_summaries(client, monkeypatch):
    monkeypatch.delenv("PERSIST_SUMMARIES", raising=False)
    with (
        patch.object(main, "extract_article_data", return_value=ARTICLE),
        patch.object(main, "generate_summary", return_value=["Point"]),
    ):
        response = post(client)
    assert response.status_code == 200
    assert 0 <= response.json()["id"] < 2**53
    with client.test_sessions() as db:
        assert db.query(main.Summary).count() == 0


def test_untrusted_origin_is_rejected_before_work(client):
    with patch.object(main, "extract_article_data") as extract:
        response = client.post(
            "/scrape",
            headers={"Origin": "https://incite-ai-attacker.vercel.app"},
            json={"url": "https://example.com"},
        )
    assert response.status_code == 403
    extract.assert_not_called()


def test_exact_origin_is_allowed_and_response_not_cached(client):
    with (
        patch.object(main, "extract_article_data", return_value=ARTICLE),
        patch.object(main, "generate_summary", return_value=["Point"]),
    ):
        response = client.post(
            "/scrape",
            headers={"Origin": "https://incite-ai.vercel.app"},
            json={"url": "https://example.com"},
        )
    assert response.status_code == 200
    assert (
        response.headers["access-control-allow-origin"]
        == "https://incite-ai.vercel.app"
    )
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_large_request_rejected_before_extraction(client):
    with patch.object(main, "extract_article_data") as extract:
        response = client.post(
            "/scrape", json={"url": "https://example.com/" + "x" * 9000}
        )
    assert response.status_code == 413
    extract.assert_not_called()


def test_actual_chunked_body_size_is_limited():
    import asyncio

    messages = iter(
        [
            {"type": "http.request", "body": b"x" * 5000, "more_body": True},
            {"type": "http.request", "body": b"x" * 5000, "more_body": False},
        ]
    )
    sent = []
    called = []

    async def receive():
        return next(messages)

    async def send(message):
        sent.append(message)

    async def app(scope, receive, send):
        called.append(True)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/scrape",
        "headers": [(b"content-type", b"application/json")],
    }
    asyncio.run(main.RequestGuard(app)(scope, receive, send))
    assert not called
    assert sent[0]["status"] == 413


def test_validation_error_does_not_echo_input(client):
    response = client.post(
        "/scrape",
        json={"url": "https://example.com/?token=private-token", "bullets": 999},
    )
    assert response.status_code == 422
    assert "private-token" not in response.text


def test_busy_service_rejects_without_calling_upstream(client, monkeypatch):
    from threading import BoundedSemaphore

    slots = BoundedSemaphore(1)
    slots.acquire()
    monkeypatch.setattr(main, "work_slots", slots)
    with patch.object(main, "extract_article_data") as extract:
        response = post(client)
    assert response.status_code == 503
    assert response.headers["retry-after"] == "5"
    extract.assert_not_called()


def test_forwarded_headers_cannot_change_rate_limit_identity():
    from starlette.requests import Request

    request = Request(
        {
            "type": "http",
            "client": ("203.0.113.5", 1234),
            "headers": [(b"x-forwarded-for", b"1.2.3.4")],
        }
    )
    assert main.client_ip(request) == "203.0.113.5"


def test_summary_cache_avoids_repeated_gemini_calls():
    with patch.object(main, "call_gemini", return_value=["Insight"]) as call:
        first = main.generate_summary("public article", "medium", 3)
        first.append("mutated locally")
        assert main.generate_summary("public article", "medium", 3) == ["Insight"]
        assert call.call_count == 1
        main.generate_summary("public article", "detailed", 3)
        assert call.call_count == 2


def test_cache_expiry_and_capacity(monkeypatch):
    monkeypatch.setattr(main, "MAX_CACHE_ENTRIES", 2)
    with patch.object(main, "call_gemini", return_value=["Insight"]) as call:
        for article in ["one", "two", "three"]:
            main.generate_summary(article, "medium", 3)
        assert len(main._summary_cache) == 2
        for key, (_, value) in list(main._summary_cache.items()):
            main._summary_cache[key] = (0, value)
        main.generate_summary("three", "medium", 3)
        assert call.call_count == 4


def test_identical_concurrent_requests_share_one_gemini_call():
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    started, finish = Event(), Event()

    def generate(*args):
        started.set()
        assert finish.wait(2)
        return ["Insight"]

    with (
        patch.object(main, "call_gemini", side_effect=generate) as call,
        ThreadPoolExecutor(max_workers=2) as executor,
    ):
        first = executor.submit(main.generate_summary, "same article", "short", 2)
        assert started.wait(2)
        second = executor.submit(main.generate_summary, "same article", "short", 2)
        finish.set()
        assert first.result(timeout=2) == second.result(timeout=2) == ["Insight"]
        assert call.call_count == 1


def test_failed_generation_is_not_cached():
    with patch.object(main, "call_gemini", side_effect=[None, ["Recovered"]]) as call:
        assert main.generate_summary("article", "short", 2) is None
        assert main.generate_summary("article", "short", 2) == ["Recovered"]
    assert call.call_count == 2


@pytest.fixture()
def tls_article_server(tmp_path):
    """Use a real local TLS socket; no public network or Gemini calls."""
    import ssl
    import threading
    from datetime import datetime, timedelta, timezone
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "article.test")])
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName("article.test")]), critical=False
        )
        .sign(key, hashes.SHA256())
    )
    cert_file, key_file = tmp_path / "cert.pem", tmp_path / "key.pem"
    cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_file.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    observed = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            observed["host"] = self.headers["Host"]
            observed["path"] = self.path
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<p>Secure article</p>")

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_file, key_file)
    context.set_servername_callback(
        lambda sock, hostname, ctx: observed.update(sni=hostname)
    )
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    trusted_context = ssl.create_default_context(cafile=str(cert_file))
    yield server.server_address[1], trusted_context, observed
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


def test_real_tls_pinning_preserves_sni_and_host(tls_article_server):
    port, context, observed = tls_article_server
    real_pool = main.urllib3.HTTPSConnectionPool

    def test_pool(address, **kwargs):
        kwargs["port"] = port
        return real_pool(address, **kwargs)

    with (
        patch.object(main.ssl, "create_default_context", return_value=context),
        patch.object(main.urllib3, "HTTPSConnectionPool", side_effect=test_pool),
    ):
        pool, response = main.open_pinned_connection(
            urlparse("https://article.test/article?topic=ai"),
            "article.test",
            "127.0.0.1",
            5,
        )
        try:
            assert response.read() == b"<p>Secure article</p>"
        finally:
            response.close()
            pool.close()
    assert observed == {
        "host": "article.test",
        "sni": "article.test",
        "path": "/article?topic=ai",
    }


def test_real_tls_rejects_wrong_certificate_hostname(tls_article_server):
    port, context, observed = tls_article_server
    real_pool = main.urllib3.HTTPSConnectionPool

    def test_pool(address, **kwargs):
        kwargs["port"] = port
        return real_pool(address, **kwargs)

    with (
        patch.object(main.ssl, "create_default_context", return_value=context),
        patch.object(main.urllib3, "HTTPSConnectionPool", side_effect=test_pool),
    ):
        with pytest.raises(urllib3.exceptions.SSLError):
            main.open_pinned_connection(
                urlparse("https://wrong.test/"), "wrong.test", "127.0.0.1", 5
            )
    assert "host" not in observed


def test_slow_headers_are_interrupted_by_total_socket_deadline():
    import threading
    import time
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    finish = threading.Event()

    class SlowHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            finish.wait(2)
            try:
                self.send_response(200)
                self.end_headers()
            except OSError:
                pass

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), SlowHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    real_pool = main.urllib3.HTTPConnectionPool

    def test_pool(address, **kwargs):
        kwargs["port"] = server.server_address[1]
        # Make the idle timeout longer to prove the absolute watchdog interrupts it.
        kwargs["timeout"] = urllib3.Timeout(connect=2, read=2)
        return real_pool(address, **kwargs)

    try:
        with patch.object(main.urllib3, "HTTPConnectionPool", side_effect=test_pool):
            start = time.monotonic()
            with pytest.raises(urllib3.exceptions.HTTPError):
                main.open_pinned_connection(
                    urlparse("http://article.test/"), "article.test", "127.0.0.1", 0.1
                )
            assert time.monotonic() - start < 1.5
    finally:
        finish.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_unexpected_errors_do_not_expose_sensitive_details(client, caplog):
    with patch.object(
        main,
        "extract_article_data",
        side_effect=RuntimeError("api_key=private-key secret-url"),
    ):
        response = post(client)
    assert response.status_code == 500
    assert "private-key" not in response.text
    assert "private-key" not in caplog.text
    assert "secret-url" not in caplog.text
    assert response.headers["cache-control"] == "no-store"


def test_global_budget_applies_across_distinct_client_addresses(client, monkeypatch):
    main.limiter.enabled = True
    main.limiter.reset()
    monkeypatch.delenv("PERSIST_SUMMARIES", raising=False)
    statuses = []
    try:
        with (
            patch.object(main, "extract_article_data", return_value=ARTICLE),
            patch.object(main, "generate_summary", return_value=["Point"]),
        ):
            for number in range(1, 202):
                other_client = TestClient(
                    main.app, client=(f"198.51.100.{number}", 1234)
                )
                try:
                    statuses.append(post(other_client).status_code)
                finally:
                    other_client.close()
        assert statuses[:200] == [200] * 200
        assert statuses[200] == 429
    finally:
        main.limiter.reset()
