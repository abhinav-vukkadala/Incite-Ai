import ipaddress
import os
import re
import socket
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List, Literal, Optional
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai.errors import APIError
from pydantic import BaseModel, Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Integer,
    String,
    Text,
    create_engine,
    text,
)
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, declarative_base, sessionmaker

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
RATE_LIMIT = os.getenv("RATE_LIMIT", "15/minute")
MAX_REDIRECTS = 5
MAX_ARTICLE_CHARS = 7500

# Standard browser headers (WITHOUT manual Accept-Encoding so requests auto-decompresses)
REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive",
}

# ---------------------------------------------------------------------------
# Database Setup
# ---------------------------------------------------------------------------
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./incite.db")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

engine_kwargs = {"pool_pre_ping": True}
if DATABASE_URL.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, **engine_kwargs)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class Summary(Base):
    __tablename__ = "summaries"

    id = Column(Integer, primary_key=True, index=True)
    user_email = Column(String(255), default="guest", nullable=False)
    title = Column(String(512), nullable=False)
    url = Column(String(2048), nullable=False)
    summary = Column(Text, nullable=False)
    length = Column(String(50), nullable=False)
    bullets = Column(Integer, nullable=False)
    is_pinned = Column(Boolean, default=False, nullable=False)
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
            if not DATABASE_URL.startswith("sqlite"):
                conn.execute(
                    text(
                        "ALTER TABLE summaries ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE NOT NULL;"
                    )
                )
                conn.commit()
        Base.metadata.create_all(bind=engine)
        print("Database connected and schema verified.")
    except Exception as e:
        print(f"Database warning: {e}")
    yield


app = FastAPI(lifespan=lifespan)


# ---------------------------------------------------------------------------
# Rate Limiting & CORS
# ---------------------------------------------------------------------------
def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return get_remote_address(request)


limiter = Limiter(key_func=client_ip)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

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
# Gemini Client
# ---------------------------------------------------------------------------
_genai_client = None


def get_genai_client():
    global _genai_client
    if _genai_client is None:
        api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY is not set.")
        _genai_client = genai.Client(api_key=api_key)
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


class SummaryResponse(BaseModel):
    id: int
    title: str
    url: str
    summary: List[str]
    length: str
    bullets: int
    is_pinned: bool
    created_at: Optional[str] = None


class ScrapeError(Exception):
    pass


# ---------------------------------------------------------------------------
# Scraping Logic (Clean Text Extraction)
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
        if not ip.is_global:
            return False
    return True


def fetch_page(url: str) -> str:
    current = url
    session = requests.Session()
    session.headers.update(REQUEST_HEADERS)

    for _ in range(MAX_REDIRECTS + 1):
        if not is_safe_url(current):
            raise ScrapeError("URL is not allowed. Please enter a public web link.")

        response = session.get(current, timeout=8, allow_redirects=False)
        try:
            if response.is_redirect:
                location = response.headers.get("Location")
                if not location:
                    raise ScrapeError("Invalid redirect from target website.")
                current = urljoin(current, location)
                continue

            if response.status_code in (401, 403):
                raise ScrapeError(
                    "Unable to summarize this article because automated scrapers are blocked by this website."
                )
            if response.status_code == 429:
                raise ScrapeError(
                    "The website is rate limiting requests. Please try again in a few moments."
                )

            response.raise_for_status()

            # Using response.text lets requests automatically handle encoding and gzip decompression
            return response.text
        finally:
            response.close()

    raise ScrapeError("Too many redirects.")


def extract_article_data(url: str) -> dict:
    html_text = fetch_page(url)
    soup = BeautifulSoup(html_text, "html.parser")

    title_tag = soup.find("h1") or soup.find("h2") or soup.find("title")
    title_text = title_tag.get_text(strip=True) if title_tag else "Article Summary"

    paragraphs = []
    for region in (soup.find("article"), soup.find("main")):
        if region is not None:
            paragraphs = [
                p.get_text(strip=True)
                for p in region.find_all("p")
                if len(p.get_text(strip=True)) > 30
            ]
            if sum(len(p) for p in paragraphs) > 400:
                break
    if sum(len(p) for p in paragraphs) <= 400:
        paragraphs = [
            p.get_text(strip=True)
            for p in soup.find_all("p")
            if len(p.get_text(strip=True)) > 30
        ]

    body = "\n\n".join(paragraphs)[:MAX_ARTICLE_CHARS]
    if not body.strip():
        raise ScrapeError(
            "Could not extract readable article text. The website content may be dynamically rendered or protected by a paywall."
        )

    return {"title": title_text, "body": body}


# ---------------------------------------------------------------------------
# LLM Processing
# ---------------------------------------------------------------------------
BULLET_RE = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+")


def parse_bullets(text: str, limit: int) -> list:
    lines = [line.strip() for line in text.strip().splitlines() if line.strip()]
    marked = [BULLET_RE.sub("", line) for line in lines if BULLET_RE.match(line)]
    points = marked or lines
    points = [p.replace("**", "").strip() for p in points]
    return [p for p in points if p][:limit]


def generate_summary(article_text: str, length: str, bullets: int):
    prompt = (
        "You are an expert research analyst. Analyze the following article text "
        f"and extract exactly {bullets} core insights.\n\n"
        f"The target depth of each insight should be {length.upper()}.\n"
        "- If SHORT: Keep each bullet extremely concise, snappy, and under one sentence.\n"
        "- If MEDIUM: Provide balanced, clear sentences packed with structural context.\n"
        "- If DETAILED: Provide rich, multi-sentence explanations full of nuance, metrics, and technical depth.\n\n"
        "Do not include any introductory or concluding text. Return your response strictly "
        "as bullet points, one per line, each starting with '- '.\n\n"
        f"Article Text:\n{article_text}"
    )

    client = get_genai_client()
    try:
        response = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
        if response.text:
            return parse_bullets(response.text, bullets)
    except Exception as e:
        print(f"Error calling {GEMINI_MODEL}: {e}")
    return None


def clean_chat_title(raw_title: str) -> str:
    cleaned = re.sub(r"\s*[-|•–—].*$", "", raw_title).strip()
    words = cleaned.split()
    if len(words) > 7:
        return " ".join(words[:6]) + "..."
    return cleaned or "Article Summary"


# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------
@app.post("/scrape", response_model=SummaryResponse)
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
            detail="The AI service was unable to generate a summary. Please try another article link.",
        )

    chat_title = clean_chat_title(scraped["title"])

    try:
        db_summary = Summary(
            user_email="guest",
            title=chat_title,
            url=target_url,
            summary="\n".join(summary_bullets),
            length=input_data.length,
            bullets=input_data.bullets,
            is_pinned=False,
        )
        db.add(db_summary)
        db.commit()
        db.refresh(db_summary)
    except SQLAlchemyError as err:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Database commit error: {str(getattr(err, 'orig', err))}",
        )

    return SummaryResponse(
        id=db_summary.id,
        title=db_summary.title,
        url=db_summary.url,
        summary=summary_bullets,
        length=db_summary.length,
        bullets=db_summary.bullets,
        is_pinned=db_summary.is_pinned,
        created_at=db_summary.created_at.isoformat() if db_summary.created_at else None,
    )


@app.get("/history", response_model=List[SummaryResponse])
def get_history(limit: int = Query(50, ge=1, le=100), db: Session = Depends(get_db)):
    summaries = (
        db.query(Summary)
        .order_by(Summary.is_pinned.desc(), Summary.created_at.desc())
        .limit(limit)
        .all()
    )
    return [
        SummaryResponse(
            id=s.id,
            title=s.title,
            url=s.url,
            summary=s.summary.split("\n"),
            length=s.length,
            bullets=s.bullets,
            is_pinned=s.is_pinned,
            created_at=s.created_at.isoformat() if s.created_at else None,
        )
        for s in summaries
    ]


@app.patch("/history/{item_id}/pin", response_model=SummaryResponse)
def toggle_pin(item_id: int, db: Session = Depends(get_db)):
    record = db.query(Summary).filter(Summary.id == item_id).first()
    if not record:
        raise HTTPException(status_code=404, detail="Summary not found.")

    record.is_pinned = not record.is_pinned
    db.commit()
    db.refresh(record)

    return SummaryResponse(
        id=record.id,
        title=record.title,
        url=record.url,
        summary=record.summary.split("\n"),
        length=record.length,
        bullets=record.bullets,
        is_pinned=record.is_pinned,
        created_at=record.created_at.isoformat() if record.created_at else None,
    )


@app.delete("/history/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_summary(item_id: int, db: Session = Depends(get_db)):
    record = db.query(Summary).filter(Summary.id == item_id).first()
    if not record:
        raise HTTPException(status_code=404, detail="Summary not found.")

    db.delete(record)
    db.commit()
    return None


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/")
def read_root():
    return {"message": "Incite AI backend is running!"}
