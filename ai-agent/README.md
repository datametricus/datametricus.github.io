# DataMetricus Voice Agent

This repository currently contains the static frontend widget only.
The original backend described below is not present in this checkout, so the assistant
has been refactored to run directly in the browser with:

- text chat available everywhere
- browser voice input when `SpeechRecognition` is supported
- browser speech output via `speechSynthesis`
- lightweight lead capture shown in the on-page summary panel

The backend architecture notes below are kept as historical reference for the earlier
prototype and should not be treated as the current repository layout.

---

## Architecture Overview

```
Browser (WebRTC mic/audio)
        │
        │  POST /session  ─────────────► FastAPI backend
        │  POST /turn     ─────────────► (state machine + extraction)
        │                                       │
        │  WebRTC SDP exchange ────────► OpenAI Realtime API
        │  (audio stream, direct)               │
        ◄──────── audio + transcript events ────┘
                                        │
                            Airtable (lead storage)
                            Resend   (email notification)
```

**Principle:** The model handles language. The backend controls state, extraction,
routing, persistence, and handoff logic. The frontend is a thin WebRTC shell.

---

## File Structure

```
datametricus-voice-agent/
  backend/
    app/
      main.py           FastAPI app — all routes and orchestration
      config.py         Environment variable loader
      schemas.py        Pydantic models (Lead, payloads, responses)
      state_logic.py    State machine — field requirements and transitions
      prompts.py        Prompt file loader (reads from prompts/)
      lead_store.py     Airtable persistence layer
      notifications.py  Resend email notification
      realtime.py       OpenAI Realtime session creation
    requirements.txt
    .env.example
  frontend/
    index.html          Widget HTML shell
    style.css           Dark professional UI
    app.js              WebRTC client + transcript + backend calls
  prompts/
    system_prompt.txt   DataMetricus AI Receptionist system prompt
    extract_prompt.txt  Structured extraction prompt
  README.md
```

---

## Environment Variables

Copy `backend/.env.example` to `backend/.env` and fill in all values.

| Variable                | Description                                         |
|-------------------------|-----------------------------------------------------|
| `OPENAI_API_KEY`        | OpenAI API key (requires Realtime API access)       |
| `OPENAI_REALTIME_MODEL` | Realtime model (e.g. `gpt-4o-realtime-preview`)     |
| `OPENAI_TEXT_MODEL`     | Chat completions model for extraction (e.g. `gpt-4o-mini`) |
| `AIRTABLE_API_KEY`      | Airtable personal access token                      |
| `AIRTABLE_BASE_ID`      | Airtable base ID (e.g. `appXXXXXXXXXXXXXX`)        |
| `AIRTABLE_TABLE_NAME`   | Table name (default: `Leads`)                       |
| `RESEND_API_KEY`        | Resend API key                                      |
| `NOTIFY_TO_EMAIL`       | Email address to receive lead notifications         |
| `FROM_EMAIL`            | Verified sender address in Resend                   |
| `BACKEND_ORIGIN`        | Backend base URL (default: `http://localhost:8000`) |
| `FRONTEND_ORIGIN`       | Frontend origin for CORS (default: `http://localhost:3000`) |

> **Note on model names:** `gpt-4o-realtime-preview` is the current Realtime model
> identifier at time of writing. Check the OpenAI documentation for the latest
> stable model string and update `OPENAI_REALTIME_MODEL` accordingly.

---

## Backend Setup

### Prerequisites
- Python 3.11 or later
- An OpenAI account with Realtime API access enabled

### Steps

```bash
cd backend

# Create and activate virtual environment
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env with your actual API keys

# Run development server
uvicorn app.main:app --reload --port 8000
```

The API will be available at `http://localhost:8000`.
Interactive docs at `http://localhost:8000/docs`.

---

## Frontend Setup

The frontend is plain HTML/CSS/JS — no build step required.

```bash
cd frontend
python -m http.server 3000
```

Open `http://localhost:3000` in a Chromium-based browser.
(Firefox WebRTC compatibility with OpenAI Realtime is experimental.)

---

## How to Run Locally (Both Together)

Terminal 1 — Backend:
```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --port 8000
```

Terminal 2 — Frontend:
```bash
cd frontend
python -m http.server 3000
```

Then open `http://localhost:3000`, click **Start Voice Session**, and allow
microphone access.

---

## How the Voice Flow Works

1. User clicks **Start Voice Session**.
2. Frontend calls `POST /session` on the backend.
3. Backend mints an OpenAI Realtime ephemeral token and registers the session in memory.
4. Frontend performs a WebRTC SDP offer/answer exchange directly with OpenAI Realtime,
   using the ephemeral token as its Bearer credential. No API key is ever exposed
   to the browser.
5. Bidirectional audio begins. The model reads the DataMetricus system prompt and
   opens with the scripted greeting.
6. As the conversation proceeds, OpenAI Realtime sends transcript events on the
   `oai-events` data channel. The frontend renders these in the transcript panel.
7. On each completed user speech turn, the frontend posts the transcript to
   `POST /turn`.
8. The backend calls OpenAI Chat Completions with the extraction prompt to parse
   structured lead fields from the transcript.
9. Extracted data is merged into the session's lead object. Missing fields and
   the next state are computed.
10. When all required fields are present the state machine transitions to
    `handoff_ready`. The backend saves the lead to Airtable and fires a Resend
    email notification — once, idempotently.

---

## How Lead Capture Works

The state machine tracks two qualification paths:

**Advisory path** — requires: `name`, `organisation`, `email`, `domain`

**Training path** — requires: `name`, `organisation`, `email`, `training_track`

Extraction runs after every user turn using `gpt-4o-mini` with `response_format:
json_object` to parse the lead schema. Existing field values are preserved unless
the user explicitly corrects them.

`fit_status` is set to `qualified` when all required fields are present and no
enum value is `unknown`.

---

## Airtable Setup

1. Log in to Airtable and create a new base.
2. Create a table named **Leads** with these fields:

| Field Name      | Type          |
|-----------------|---------------|
| Session ID      | Single line   |
| Inquiry Type    | Single select (advisory, training, unknown) |
| Domain          | Single select (life_health_insurance, public_health, regulatory_risk, other, unknown) |
| Work Type       | Single select (exploratory_analysis, model_development, model_audit, reproducible_pipeline, technical_review, unknown) |
| Project Scale   | Single select (small, medium, large, unknown) |
| Training Format | Single select (individual, team, unknown) |
| Training Track  | Single select (foundations, applied_modelling, reproducible_workflows, unknown) |
| Timeline        | Single line   |
| Name            | Single line   |
| Organisation    | Single line   |
| Email           | Email         |
| Phone           | Phone number  |
| Fit Status      | Single select (qualified, partial, low_fit, rejected) |
| Summary         | Long text     |
| Created At      | Created time  |

3. Create a Personal Access Token at https://airtable.com/create/tokens with scope
   `data.records:write` and access to your base.
4. Set `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, and `AIRTABLE_TABLE_NAME` in `.env`.

---

## Resend Setup

1. Create an account at https://resend.com.
2. Add and verify your sender domain (or use the sandbox address for testing).
3. Create an API key.
4. Set `RESEND_API_KEY`, `FROM_EMAIL` (must be from your verified domain),
   and `NOTIFY_TO_EMAIL` in `.env`.

---

## Production Hardening Checklist

### Logging
- Replace `basicConfig` with `structlog` or a JSON formatter compatible with your
  log aggregator (Datadog, CloudWatch, GCP Logging).
- Add a `session_id` context variable to all log records for end-to-end tracing.
- Never log raw transcript text in PII-sensitive deployments.

### Retries and Resilience
- Wrap `create_realtime_session`, `_call_extraction_api`, `save_lead`, and
  `send_lead_notification` with `tenacity` retry logic (exponential backoff,
  max 3 attempts).
- Add a circuit breaker for Airtable (fail open — log and skip, never crash the
  voice session).
- Store leads to a local SQLite/Postgres fallback if Airtable is unreachable,
  with a reconciliation worker.

### Session Storage
- Replace the in-memory `SESSIONS` dict with Redis (use `redis-py` with async
  support). Memory state is lost on server restart.
- Set a TTL on sessions (e.g. 2 hours) to prevent unbounded growth.

### CORS
- In production, set `allow_origins` to the exact production domain only.
  Remove the `localhost` fallback entries.
- Enable `allow_credentials=False` unless you are issuing cookies.

### Rate Limiting
- Add `slowapi` middleware: limit `/session` to ~5 requests per IP per minute
  and `/turn` to ~30 per session per minute.
- Consider a CAPTCHA or signed session challenge before minting a Realtime token.

### Transcript Sanitisation
- Strip control characters and enforce a maximum transcript length
  (e.g. 2000 characters) in `process_turn` before forwarding to the extraction API.
- Reject turns from closed or notified sessions.

### Privacy and Consent
- Display a privacy notice on the widget before the user starts the session.
- Capture explicit consent (`consent_to_followup: true`) in the session record.
- Comply with applicable data protection regulations (GDPR, CCPA) regarding
  storage of voice transcripts and PII.

### Security
- Use HTTPS in production. Do not expose the backend over plain HTTP.
- The ephemeral Realtime token is short-lived (~60 s) and single-use.
  Do not cache or reuse it.
- Rotate `OPENAI_API_KEY`, `AIRTABLE_API_KEY`, and `RESEND_API_KEY` regularly
  using a secrets manager (AWS Secrets Manager, HashiCorp Vault).

### Analytics
- Emit structured events (session_started, turn_processed, handoff_ready,
  persistence_failed) to your analytics pipeline.
- Track qualification funnel drop-off points (which required field is most often
  missing at session end).

### Deployment
- Containerise with Docker; expose only port 80/443 via a reverse proxy (Nginx,
  Caddy, or a cloud load balancer).
- Use Gunicorn + Uvicorn workers: `gunicorn app.main:app -k uvicorn.workers.UvicornWorker`
- Set `WEB_CONCURRENCY` based on available CPU cores (2× + 1 is a common rule).
- Run health checks against `GET /health` and restart unhealthy instances.
- The frontend is static — deploy to a CDN (Cloudflare Pages, S3 + CloudFront,
  or Vercel). Update `BACKEND_URL` in `app.js` to the production backend URL.
