import os

# Must be set before importing main so no real database or API key is needed.
os.environ["DATABASE_URL"] = "sqlite://"
os.environ.setdefault("GEMINI_API_KEY", "test-key")

from unittest.mock import patch

import pytest
import requests
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
        self.status_code = status
        self.headers = headers or {}

    @property
    def is_redirect(self):
        redirect_codes = (301, 302, 303, 307, 308)
        return self.status_code in redirect_codes and "Location" in self.headers

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.exceptions.HTTPError(response=self)

    def iter_content(self, chunk_size=1):
        yield self.content

    def close(self):
        pass


@pytest.fixture()
def client():
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
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()
    main.limiter.enabled = True


def post(client, **overrides):
    payload = {"url": "https://example.com/a", "length": "medium", "bullets": 2}
    payload.update(overrides)
    return client.post("/scrape", json=payload)


# ---- endpoint behaviour ---------------------------------------------------
def test_successful_summary_is_returned_and_saved(client):
    with patch.object(main, "extract_article_data", return_value=ARTICLE), patch.object(
        main, "generate_summary", return_value=["Point A", "Point B"]
    ):
        response = post(client)

    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Test Article"
    assert body["summary"] == ["Point A", "Point B"]

    history = client.get("/history").json()
    assert len(history) == 1
    assert history[0]["summary"] == ["Point A", "Point B"]


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
    with patch.object(main, "extract_article_data", return_value=ARTICLE), patch.object(
        main, "generate_summary", return_value=None
    ):
        response = post(client)
    assert response.status_code == 500


def test_rate_limit_returns_429(client):
    main.limiter.enabled = True
    main.limiter.reset()
    with patch.object(main, "extract_article_data", return_value=ARTICLE), patch.object(
        main, "generate_summary", return_value=["Point A"]
    ):
        statuses = [post(client).status_code for _ in range(6)]
    assert statuses[:5] == [200] * 5
    assert statuses[5] == 429


# ---- extraction pipeline --------------------------------------------------
def test_extract_filters_short_paragraphs_and_finds_title():
    html = f"<h1>My Title</h1><p>short</p><p>{LONG_P}</p>"
    with patch.object(main, "is_safe_url", return_value=True), patch.object(
        main.requests, "get", return_value=FakeResponse(html)
    ):
        result = main.extract_article_data("https://example.com")
    assert result["title"] == "My Title"
    assert "short" not in result["body"]
    assert LONG_P in result["body"]


def test_extract_raises_when_no_readable_content():
    with patch.object(main, "is_safe_url", return_value=True), patch.object(
        main.requests, "get", return_value=FakeResponse("<h1>Hi</h1><p>tiny</p>")
    ):
        with pytest.raises(main.ScrapeError, match="Could not extract"):
            main.extract_article_data("https://example.com")


def test_extract_reports_timeouts_and_http_errors():
    with patch.object(main, "is_safe_url", return_value=True):
        timeout = requests.exceptions.Timeout
        with patch.object(main.requests, "get", side_effect=timeout):
            with pytest.raises(main.ScrapeError, match="too long"):
                main.extract_article_data("https://example.com")

        with patch.object(main.requests, "get", return_value=FakeResponse(status=403)):
            with pytest.raises(main.ScrapeError, match="403"):
                main.extract_article_data("https://example.com")


def test_redirect_to_internal_address_is_blocked():
    redirect = FakeResponse(status=302, headers={"Location": "http://127.0.0.1/secret"})
    with patch.object(main, "is_safe_url", side_effect=[True, False]), patch.object(
        main.requests, "get", return_value=redirect
    ):
        with pytest.raises(main.ScrapeError, match="isn't allowed"):
            main.extract_article_data("https://example.com")


# ---- bullet parsing -------------------------------------------------------
def test_parse_bullets_strips_markers_but_keeps_leading_digits():
    text = "- 5G networks grew fast\n* **Bold** insight\n1. Numbered point\n\n- Extra"
    assert main.parse_bullets(text, 3) == [
        "5G networks grew fast",
        "Bold insight",
        "Numbered point",
    ]


def test_parse_bullets_falls_back_to_plain_lines():
    result = main.parse_bullets("First line\nSecond line", 5)
    assert result == ["First line", "Second line"]
