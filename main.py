import ipaddress
import os
import re
import socket
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Literal
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai.errors import APIError
from pydantic import BaseModel, Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sqlalchemy import Column, DateTime, Integer, String, Text, create_engine
from sqlalchemy.orm import Session, declarative_base, sessionmaker

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
RATE_LIMIT = os.getenv("RATE_LIMIT", "5/minute")
MAX_REDIRECTS = 5
MAX_DOWNLOAD_BYTES = 2_000_000  # stop reading a page after ~2 MB
MAX_ARTICLE_CHARS = 8000  # amount of article text sent to the model

REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}

# ---------------------------------------------------------------------------
# Database setup (+ Render's 'postgres://' compatibility fix)
# ---------------------------------------------------------------------------
DEFAULT_DB = "postgresql://postgres:YOUR_PASSWORD@localhost:5432/inciteai"
DATABASE_URL = os.getenv("DATABASE_URL", DEFAULT_DB)
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class Summary(Base):
    __tablename__ = "summaries"
    id = Column(Integer, primary_key=True, index=True)
    user_email = Column(String, nullable=False)
    title = Column(String, nullable=False)
    url = Column(String, nullable=False)
    summary = Column(Text, nullable=False)
    length = Column(String, nullable=False)
    bullets = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        Base.metadata.create_all(bind=engine)
        print("Connected to database and tables verified.")
    except Exception as e:  # the app still works without the DB
        print(f"Warning: Database startup check failed: {e}")
    yield


app = FastAPI(lifespan=lifespan)


# ---------------------------------------------------------------------------
# Rate limiting (per client IP; honours X-Forwarded-For behind Render/Vercel)
# ---------------------------------------------------------------------------
def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return get_remote_address(request)


limiter = Limiter(key_func=client_ip)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# ---------------------------------------------------------------------------
# CORS (local dev + production frontend + Vercel preview deployments)
# ---------------------------------------------------------------------------
allowed_origins = [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
    "https://incite-ai.vercel.app",
]
env_origins = os.getenv("FRONTEND_URLS")
if env_origins:
    allowed_origins.extend(
        [origin.strip() for origin in env_origins.split(",") if origin.strip()]
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=r"https://incite-ai[a-z0-9-]*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Gemini client (created lazily so importing the module never needs an API key)
# ---------------------------------------------------------------------------
_genai_client = None


def get_genai_client():
    global _genai_client
    if _genai_client is None:
        _genai_client = genai.Client()
    return _genai_client


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class ScrapeRequest(BaseModel):
    url: str = Field(..., max_length=2048)
    length: Literal["short", "medium", "detailed"] = "medium"
    bullets: int = Field(3, ge=1, le=7)


class ScrapeError(Exception):
    """A problem fetching or reading the article, safe to show to the user."""


# ---------------------------------------------------------------------------
# SSRF protection: only fetch public internet addresses
# ---------------------------------------------------------------------------
def is_safe_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError:
        return False

    if parsed.scheme not in ("http", "https") or not hostname:
        return False

    try:
        infos = socket.getaddrinfo(hostname, port, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError):
        return False

    for info in infos:
        address = info[4][0].split("%")[0]
        ip = ipaddress.ip_address(address)
        if ip.version == 6 and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if not ip.is_global:  # loopback, private, link-local, reserved...
            return False
    return True


# ---------------------------------------------------------------------------
# Article extraction
# ---------------------------------------------------------------------------
def fetch_page(url: str) -> bytes:
    """GET a page, validating every redirect hop against the SSRF check."""
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        if not is_safe_url(current):
            raise ScrapeError(
                "That URL isn't allowed. Please use a public http(s) article link."
            )
        response = requests.get(
            current,
            headers=REQUEST_HEADERS,
            timeout=10,
            allow_redirects=False,
            stream=True,
        )
        try:
            if response.is_redirect:
                location = response.headers.get("Location")
                if not location:
                    raise ScrapeError("The site returned a broken redirect.")
                current = urljoin(current, location)
                continue

            response.raise_for_status()

            chunks, size = [], 0
            for chunk in response.iter_content(65536):
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_DOWNLOAD_BYTES:
                    break
            return b"".join(chunks)
        finally:
            response.close()

    raise ScrapeError("The site redirected too many times.")


def extract_article_data(url: str) -> dict:
    try:
        html = fetch_page(url)
    except ScrapeError:
        raise
    except requests.exceptions.Timeout:
        raise ScrapeError("The site took too long to respond.")
    except requests.exceptions.HTTPError as e:
        status = e.response.status_code if e.response is not None else "unknown"
        raise ScrapeError(
            f"The site returned an error ({status}). Some sites block automated "
            "access, so try a different article."
        )
    except requests.exceptions.RequestException:
        raise ScrapeError("Could not fetch that page.")

    soup = BeautifulSoup(html, "html.parser")

    title_tag = soup.find("h1") or soup.find("h2") or soup.find("title")
    title_text = title_tag.get_text(strip=True) if title_tag else "Untitled Article"

    def good_paragraphs(root):
        texts = (p.get_text(strip=True) for p in root.find_all("p"))
        return [t for t in texts if len(t) > 30]  # drop share buttons, footers...

    # Prefer the main article region, fall back to the whole page.
    paragraphs = []
    for region in (soup.find("article"), soup.find("main")):
        if region is not None:
            paragraphs = good_paragraphs(region)
            if sum(len(p) for p in paragraphs) > 500:
                break
    if sum(len(p) for p in paragraphs) <= 500:
        paragraphs = good_paragraphs(soup)

    body = "\n\n".join(paragraphs)[:MAX_ARTICLE_CHARS]
    if not body.strip():
        raise ScrapeError("Could not extract readable main content from this website.")

    return {"title": title_text, "body": body}


# ---------------------------------------------------------------------------
# Summarisation
# ---------------------------------------------------------------------------
BULLET_RE = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+")


def parse_bullets(text: str, limit: int) -> list:
    lines = [line.strip() for line in text.strip().splitlines() if line.strip()]
    marked = [BULLET_RE.sub("", line) for line in lines if BULLET_RE.match(line)]
    points = marked or lines
    points = [p.replace("**", "").strip() for p in points]
    return [p for p in points if p][:limit]


def generate_summary(article_text: str, length: str, bullets: int):
    if not article_text.strip():
        return None
    prompt = (
        "You are an expert research analyst. Analyze the following "
        f"article text and extract exactly {bullets} core insights.\n\n"
        f"The target depth of each insight should be {length.upper()}.\n"
        "- If SHORT: Keep each bullet extremely concise, snappy, and "
        "under one sentence.\n"
        "- If MEDIUM: Provide balanced, clear sentences packed with "
        "structural context.\n"
        "- If DETAILED: Provide rich, multi-sentence explanations full "
        "of nuance, metrics, and technical depth.\n\n"
        "Do not include any introductory or concluding text. Return your "
        "response strictly as bullet points, one per line, each starting "
        "with '- '.\n\n"
        f"Article Text:\n{article_text}"
    )
    try:
        response = get_genai_client().models.generate_content(
            model=GEMINI_MODEL, contents=prompt
        )
        if not response.text:
            return None
        return parse_bullets(response.text, bullets) or None
    except APIError as e:
        print(f"Gemini API Error: {e}")
        return None
    except Exception as e:
        print(f"Unexpected AI layer error: {e}")
        return None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.post("/scrape")
@limiter.limit(RATE_LIMIT)
def scrape_endpoint(
    input_data: ScrapeRequest, request: Request, db: Session = Depends(get_db)
):
    target_url = input_data.url.strip()

    if not target_url.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=400,
            detail="Invalid URL format. Must start with http:// or https://",
        )

    try:
        scraped = extract_article_data(target_url)
    except ScrapeError as e:
        raise HTTPException(status_code=400, detail=str(e))

    summary_bullets = generate_summary(
        article_text=scraped["body"],
        length=input_data.length,
        bullets=input_data.bullets,
    )
    if not summary_bullets:
        raise HTTPException(
            status_code=500,
            detail="The AI service was unable to generate a summary.",
        )

    # Saving history must never break a successful summary.
    summary_id = None
    try:
        db_summary = Summary(
            user_email="guest",
            title=scraped["title"],
            url=target_url,
            summary="\n".join(summary_bullets),
            length=input_data.length,
            bullets=input_data.bullets,
        )
        db.add(db_summary)
        db.commit()
        db.refresh(db_summary)
        summary_id = db_summary.id
    except Exception as e:
        db.rollback()
        print(f"Warning: could not save summary to database: {e}")

    return {
        "id": summary_id,
        "title": scraped["title"],
        "url": target_url,
        "summary": summary_bullets,
    }


@app.get("/history")
def get_history(limit: int = Query(10, ge=1, le=50), db: Session = Depends(get_db)):
    """Fetch recent summaries stored in the database."""
    summaries = db.query(Summary).order_by(Summary.created_at.desc()).limit(limit).all()
    return [
        {
            "id": s.id,
            "title": s.title,
            "url": s.url,
            "summary": s.summary.split("\n"),
            "length": s.length,
            "bullets": s.bullets,
            "created_at": s.created_at.isoformat() if s.created_at else None,
        }
        for s in summaries
    ]


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/")
def read_root():
    return {"message": "Incite AI backend is running!"}
