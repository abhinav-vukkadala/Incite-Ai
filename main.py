import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import requests
from bs4 import BeautifulSoup
from google import genai
from google.genai.errors import APIError
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker, Session

load_dotenv()

# Database setup & Render 'postgres://' compatibility fix
DEFAULT_DB = "postgresql://postgres:YOUR_PASSWORD@localhost:5432/inciteai"
DATABASE_URL = os.getenv("DATABASE_URL", DEFAULT_DB)
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


# Summary model
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


# Create tables safely during application startup
@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        Base.metadata.create_all(bind=engine)
        print("Connected to PostgreSQL and tables verified.")
    except Exception as e:
        print(f"Warning: Database startup check failed: {e}")
    yield


app = FastAPI(lifespan=lifespan)

# Rate Limiter
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS configuration (supports local dev + production frontends)
allowed_origins = [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
]
env_origins = os.getenv("FRONTEND_URLS")
if env_origins:
    allowed_origins.extend(
        [origin.strip() for origin in env_origins.split(",") if origin.strip()]
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Gemini Client
genai_client = genai.Client()


# Dependency to get DB session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class ScrapeRequest(BaseModel):
    url: str
    length: str = "medium"
    bullets: int = 3


def extract_article_data(url: str):
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        )
    }
    try:
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        title = soup.find("h1")
        if title:
            title_text = title.get_text(strip=True)
        else:
            secondary_title = soup.find("h2")
            title_text = (
                secondary_title.get_text(strip=True)
                if secondary_title
                else "Untitled Article"
            )
        paragraphs = soup.find_all("p")
        body_paragraphs = [
            p.get_text(strip=True)
            for p in paragraphs
            if len(p.get_text(strip=True)) > 30
        ]
        full_body_text = "\n\n".join(body_paragraphs)[:8000]
        return {"title": title_text, "body": full_body_text}
    except requests.exceptions.Timeout:
        print(f"Error: Request timed out for {url}")
        return None
    except requests.exceptions.HTTPError as e:
        print(f"HTTP Error: {e.response.status_code} for {url}")
        return None
    except Exception as e:
        print(f"Unexpected scraping error: {str(e)}")
        return None


def generate_summary(article_text: str, length: str, bullets: int):
    if not article_text.strip():
        return None
    try:
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
            "response strictly as bullet points.\n\n"
            f"Article Text:\n{article_text}"
        )
        response = genai_client.models.generate_content(
            model="gemini-2.0-flash",
            contents=prompt,
        )
        bullet_points = [
            re.sub(r"^\s*[-*•\d.]+\s*", "", line)
            for line in response.text.strip().split("\n")
            if line.strip()
        ]
        while len(bullet_points) < bullets:
            bullet_points.append("No additional takeaways provided.")
        return bullet_points[:bullets]
    except APIError as e:
        print(f"Gemini API Error: {str(e)}")
        return None
    except Exception as e:
        print(f"Unexpected AI layer error: {str(e)}")
        return None


@app.post("/scrape")
@limiter.limit("5/minute")
def scrape_endpoint(
    input_data: ScrapeRequest, request: Request, db: Session = Depends(get_db)
):
    target_url = input_data.url

    if not target_url.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=400,
            detail="Invalid URL format. Must start with http:// or https://",
        )

    scraped_result = extract_article_data(target_url)
    if not scraped_result or not scraped_result["body"]:
        raise HTTPException(
            status_code=400,
            detail="Could not extract readable main content from this website.",
        )

    summary_bullets = generate_summary(
        article_text=scraped_result["body"],
        length=input_data.length,
        bullets=input_data.bullets,
    )

    if not summary_bullets:
        raise HTTPException(
            status_code=500,
            detail="The AI service was unable to generate a summary.",
        )

    # Save to database
    db_summary = Summary(
        user_email="guest",
        title=scraped_result["title"],
        url=target_url,
        summary="\n".join(summary_bullets),
        length=input_data.length,
        bullets=input_data.bullets,
    )
    db.add(db_summary)
    db.commit()
    db.refresh(db_summary)

    return {
        "id": db_summary.id,
        "title": scraped_result["title"],
        "url": target_url,
        "summary": summary_bullets,
    }


@app.get("/history")
def get_history(limit: int = 10, db: Session = Depends(get_db)):
    """Fetch recent summaries stored in the PostgreSQL database."""
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


@app.get("/")
def read_root():
    return {"message": "Smart Read Backend is running!"}
