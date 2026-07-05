# SmartRead
AI-powered content aggregator that summarizes any article in seconds.

🔗 Live Demo: https://smart-read.vercel.app

## What it does
Paste any article URL and get back AI-generated bullet points with configurable depth and count.

## Tech Stack
- Frontend: React, Vite, Tailwind CSS
- Backend: Python, FastAPI
- AI: Google Gemini 2.5 Flash
- Scraping: BeautifulSoup
- Deployed: Vercel (frontend) + Render (backend)

## Run locally
1. Clone the repo
2. Backend: `pip install -r requirements.txt` then `uvicorn main:app --reload`
3. Frontend: `cd frontend && npm install && npm run dev`
4. Add your `GEMINI_API_KEY` to a `.env` file
