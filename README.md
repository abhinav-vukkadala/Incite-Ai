# Incite AI

**Turn article links into concise, configurable research summaries.**

[Live application](https://incite-ai.vercel.app)

Incite AI is a deployed article summarizer built with React, FastAPI, and Google Gemini. Users paste a public article URL, choose the summary depth and bullet count, and receive key insights in a focused reading interface.

This source package includes application security improvements. Changes take effect on the live app only after deploying both the frontend and backend.

## Features

- **Configurable output:** 1–7 bullets with short, medium, or detailed explanations.
- **Browser history:** save up to 100 summaries, pin useful entries, delete individual entries, or clear history.
- **Source verification:** open the original article and copy summaries as plain text.
- **Responsive interface:** collapsible history, labelled controls, visible keyboard focus, loading feedback, and accessible errors.
- **Bounded requests:** cancel browser requests, recover from stalled requests, and report API or clipboard failures clearly.
- **Efficient AI calls:** reuse identical content/settings for five minutes in a bounded memory cache; simultaneous duplicates share one Gemini request per process.
- **Optional persistence:** SQLAlchemy supports SQLite and PostgreSQL. Server-side summary storage is disabled by default to reduce retained data and database work.

## Architecture

1. React sends `{url, length, bullets}` to `POST /scrape`.
2. FastAPI applies request-size, origin, rate, and concurrency limits.
3. The scraper resolves and validates public IP addresses, connects to the selected IP with the original HTTPS hostname, and checks each redirect separately.
4. BeautifulSoup removes non-article elements and extracts up to 7,500 characters of readable text.
5. The backend checks its short-lived content cache, then calls Gemini if needed. It bounds model output and parses plain-text bullet points.
6. The response is displayed and saved in localStorage. If explicitly enabled, a server record is also written.

Gemini credentials stay on the backend. Article text is sent to Google's Gemini service for processing. React renders titles and model output as text; it does not inject article HTML into the page.

## Technology

| Layer | Tools |
| --- | --- |
| Interface | React, JavaScript, Tailwind CSS |
| Build and frontend tests | Vite, Vitest, React Testing Library, jsdom |
| API | Python, FastAPI, Pydantic, SlowAPI |
| Extraction | urllib3, dnspython, BeautifulSoup |
| AI | Google Gen AI SDK; default model `gemini-2.5-flash` |
| Optional database | SQLAlchemy, SQLite / PostgreSQL |
| Backend tests | pytest, FastAPI TestClient, mocks, local TLS integration tests |
| Hosting | Vercel frontend, Render backend |

## Run locally

The supplied standalone package places frontend and backend files in one directory. When updating an existing repository, preserve its frontend/backend structure and merge configuration with the existing manifests.

Use **Python 3.12** and **Node.js 24.15+ within the Node 24 release line** for the tested environment. The upgraded test dependencies also support Node 22.22.2+ within Node 22.

### Backend

```bash
python -m venv .venv
source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.lock
cp .env.example .env
```

Set `GEMINI_API_KEY` in `.env`, then run:

```bash
uvicorn main:app --reload --port 8000
```

Health check: http://localhost:8000/health. For local interactive API documentation, set `ENABLE_API_DOCS=true` and restart; documentation is then available at `/docs`.

### Frontend

In another terminal, from the same directory:

```bash
npm ci
npm run dev
```

Open http://localhost:5173. Vite reads the public backend address from `VITE_API_URL`. Restart the frontend after changing environment variables.

### Configuration

| Variable | Purpose / default |
| --- | --- |
| `GEMINI_API_KEY` | Required backend Gemini credential; `GOOGLE_API_KEY` is also accepted |
| `GEMINI_MODEL` | Defaults to `gemini-2.5-flash` |
| `VITE_API_URL` | Public backend base URL; defaults to `http://localhost:8000` |
| `FRONTEND_URLS` | Additional exact allowed browser origins, comma-separated |
| `RATE_LIMIT` | Per-client summary request limit; default `5/minute` |
| `GLOBAL_RATE_LIMIT` | Summary request budget across clients; default `200/day` per rate-limit store |
| `RATELIMIT_STORAGE_URI` | Defaults to `memory://`; use authenticated Redis in production to share limits and preserve counters across app restarts |
| `MAX_CONCURRENT_SUMMARIES` | Default 4 active summaries per backend process; excess work returns 503 |
| `PERSIST_SUMMARIES` | Default `false`; explicitly set `true` to write summaries to the database |
| `DATABASE_URL` | Optional persistence connection; default `sqlite:///./incite.db` |
| `ENABLE_API_DOCS` | Default `false`; enables local API docs when explicitly set `true` |

Never commit `.env`. Every `VITE_` variable is public: never put API keys, database credentials, or Redis credentials there.

## Tests and dependency checks

```bash
python -m pytest test_main.py -q
npm test
npm run build
npm audit
pip install pip-audit
pip-audit -r requirements.lock --no-deps --disable-pip
```

The revised suites contain **59 backend tests** and **16 frontend tests**. They cover the summary flow, optional database persistence, rate limiting, DNS/IP validation, pinned HTTPS connections, certificate mismatch rejection, slow-header deadlines, redirects, body/download limits, origin restrictions, error privacy, caching, local history, unsafe source URLs, text escaping, cancellation, and frontend timeouts.

Tests do not call paid Gemini APIs. Local TLS tests create temporary certificates and use only loopback sockets. The test runner currently emits an upstream FastAPI TestClient deprecation warning.

`requirements.lock` pins the tested backend dependency versions. `requirements.txt` describes the direct dependency ranges. Use `npm ci` and the backend lock file for reproducible installs; rerun tests and audits when updating dependencies.

`scraper_test.py` is a separate manual network experiment, not the production scraper or backend test suite. Do not expose it as an API.

## API

| Method | Route | Behavior |
| --- | --- | --- |
| `POST` | `/scrape` | Validate, extract, summarize, and optionally persist an article |
| `GET` | `/health` | Process liveness; does not check Gemini or database readiness |
| `GET` | `/` | Backend welcome message |

Request example:

```json
{"url":"https://example.com/article","length":"medium","bullets":5}
```

Successful responses contain `id`, `title`, `url`, `summary` (a string array), `length`, `bullets`, `is_pinned`, and `created_at`. Without persistence, `id` is a randomly generated browser-safe integer. It is an identifier, not an authorization token.

The old `/history`, `/history/{id}/pin`, and `/history/{id}` routes are removed because guest records have no authenticated owner. Browser pinning and deletion remain available. `ENABLE_SHARED_HISTORY` no longer enables anything.

## Deployment

### Vercel frontend

- Install with `npm ci`, build with `npm run build`, and publish `dist`.
- Set `VITE_API_URL` to the real **HTTPS backend URL before building**. The build embeds a Content Security Policy that permits API connections only to that origin and the frontend's own origin.
- Include `vercel.json` at the Vercel project root. It adds security headers, including framing restrictions. If your frontend is in a subfolder, place the configuration in the root directory selected for that Vercel project.
- A backend URL change requires a frontend rebuild. The example backend used in build verification is not a real deployment address.

### Render backend

- Install with `pip install -r requirements.lock`.
- Set private Gemini credentials, exact frontend origins, and a private authenticated Redis connection in the environment.
- Keep `PERSIST_SUMMARIES=false` unless you intentionally want server storage. Old database records are not automatically deleted.
- A bounded single-worker start command is:

```bash
uvicorn main:app --host 0.0.0.0 --port $PORT --workers 1 --limit-concurrency 100 --timeout-keep-alive 5 --h11-max-incomplete-event-size 16384 --no-server-header
```

Configure Uvicorn's trusted proxy addresses to match the hosting ingress so rate limits use the real client IP. Do not trust arbitrary forwarded headers or set a wildcard trust list on an origin reachable directly by users.

Use provider request/bot controls and network egress restrictions as additional defenses. Restrict database and Redis access to the backend. Enforce Gemini provider quotas; the app's request budget does not replace provider-side controls. See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for deployment checks and limits of this review.

## Privacy and limitations

Browser history is readable by anyone using the same browser profile and persists until cleared or evicted. It is not encrypted private storage. Avoid sensitive or signed article links. A browser cancel stops waiting for the result; it may not stop work or charges already started on the server.

By default, no new article URLs or summaries are written to the database. Short-lived cached summaries remain in process memory, are valid for five minutes, and expired entries are removed on later cache access or process exit. No article bodies or URLs are retained as cache entries. If persistence is enabled, browser deletion does not delete server records.

Paywalled, bot-protected, JavaScript-rendered, compressed-only, and non-HTML pages may fail extraction. Only the first 7,500 extracted characters reach Gemini. Summary accuracy and the requested bullet count are not guaranteed; verify facts against the source.

Caches and concurrency limits are per process. Memory rate-limit counters reset on restart and do not coordinate between workers; Redis is required for shared rate limits. Public access remains anonymous, so determined users can consume the configured request budget. This code review and automated tests do not establish that the deployed application is immune to attacks.
