import os
from fastapi import FastAPI, HTTPException, Request
import requests
from bs4 import BeautifulSoup
from google import genai
from google.genai.errors import APIError
from dotenv import load_dotenv
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime

load_dotenv()

# Database setup
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:YOUR_PASSWORD@localhost:5432/inciteai")

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
    created_at = Column(DateTime, default=datetime.utcnow)

# Dependency to get DB session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
        
app = FastAPI()

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow your React app's address
    allow_credentials=True,
    allow_methods=["*"],  # Allow all HTTP methods (POST, GET, etc.)
    allow_headers=["*"],  # Allow all security/content headers
)

# Request schema matching what your frontend is sending
class ScrapeRequest(BaseModel):
    url: str
    length: str = "medium"  # options: short, medium, detailed
    bullets: int = 3        # default to 3 bullets


def extract_article_data(url: str):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
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
            title_text = secondary_title.get_text(strip=True) if secondary_title else "Untitled Article"
        
        paragraphs = soup.find_all("p")
        body_paragraphs = [p.get_text(strip=True) for p in paragraphs if len(p.get_text(strip=True)) > 30]
        full_body_text = "\n\n".join(body_paragraphs) [:8000]
        
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
        client = genai.Client()
        
        # Tailor your prompt using the dynamic configurations from the frontend request
        prompt = f"""
        You are an expert research analyst. Analyze the following article text and extract exactly {bullets} core insights.
        
        The target depth of each insight should be {length.upper()}.
        - If SHORT: Keep each bullet extremely concise, snappy, and under one sentence.
        - If MEDIUM: Provide balanced, clear sentences packed with structural context.
        - If DETAILED: Provide rich, multi-sentence explanations full of nuance, metrics, and technical depth.
        
        Do not include any introductory or concluding text. Return your response strictly as bullet points.
        
        Article Text:
        {article_text}
        """
        
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=prompt,
        )
        
        bullet_points = [line.strip("- * ") for line in response.text.strip().split("\n") if line.strip()]
        
        # Fallback layer: ensure match count accuracy
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
def scrape_endpoint(input_data: ScrapeRequest, request: Request):
    target_url = input_data.url
    
    if not target_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Invalid URL format. Must start with http:// or https://")
    
    scraped_result = extract_article_data(target_url)
    if not scraped_result or not scraped_result["body"]:
        raise HTTPException(status_code=400, detail="Could not extract readable main content from this website.")
        
    # Pass down the dynamic settings directly to the AI text engine
    summary_bullets = generate_summary(
        article_text=scraped_result["body"], 
        length=input_data.length, 
        bullets=input_data.bullets
    )
    
    if not summary_bullets:
        raise HTTPException(status_code=500, detail="The AI service was unable to generate a summary for this text.")
        
    return {
        "title": scraped_result["title"],
        "url": target_url,
        "summary": summary_bullets
    }


@app.get("/")
def read_root():
    return {"message": "Smart Read Backend is running!"}