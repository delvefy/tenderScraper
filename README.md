# PublicTender

A lightweight government procurement monitoring tool with AI-powered analysis. PublicTender watches public tender portals and Finland's official procurement database (HILMA) for relevant bid notices, RFPs, and contract awards — and uses AI to summarize and flag the ones that matter to you.

---

## Features

- **Dual monitoring modes** — scrape any custom URL or query the HILMA (hankintailmoitukset.fi) API directly
- **AI-powered analysis** — sends page content to an AI model with your custom prompt to detect relevant procurement notices
- **Multi-provider AI support** — works with Google Gemini, Groq, and OpenAI
- **Web dashboard** — manage monitors, view results, and configure settings from a clean browser UI
- **Confidence scoring** — each finding is rated high/medium/low confidence with an AI-generated summary
- **Result history** — stores the 500 most recent analysis runs with full HILMA metadata where available

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express.js |
| Web Scraping | axios + cheerio |
| AI Providers | @google/genai, openai (also used for Groq) |
| Frontend | Vanilla JS, HTML5, CSS3 (single-file SPA) |
| Storage | Local JSON files (no database required) |

---

## Getting Started

### Prerequisites

- Node.js (v18 or later recommended)

### Installation

```bash
git clone <repo-url>
cd publictender
npm install
```

### Configuration

Before starting the server, make sure the `db/` directory contains the three required JSON files.

**`db/settings.json`** — API keys for AI providers:

```json
{
  "activeProvider": "groq",
  "providers": {
    "gemini": { "apiKey": "" },
    "groq":   { "apiKey": "" },
    "openai": { "apiKey": "" }
  }
}
```

**`db/monitors.json`** — start with an empty array:

```json
[]
```

**`db/results.json`** — start with an empty array:

```json
[]
```

You can also configure API keys directly from the **Settings** tab in the web UI after starting the server.

### Running

```bash
# Production
npm start

# Development (auto-reload on file changes)
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

The port can be overridden with the `PORT` environment variable:

```bash
PORT=8080 npm start
```

---

## Usage

### Creating a Monitor

1. Go to the **Monitors** tab and click **New Monitor**
2. Give it a name and write a prompt describing what you're looking for (e.g. *"Is there an open RFP or contract notice for document management software?"*)
3. Choose a source type:
   - **URL** — enter one or more website URLs to scrape
   - **HILMA** — enter a keyword to search Finland's official procurement database
4. Save the monitor — it will appear in your dashboard

### Running a Monitor

Click **Run Now** on any monitor to trigger an immediate analysis. Results appear in the **Dashboard** tab with confidence levels, summaries, and direct links to relevant notices.

### Debug Tools

Use the API endpoints below to test scraping or HILMA queries before setting up a full monitor:

- `GET /api/debug/scrape?url=<url>` — preview what text is extracted from a URL
- `GET /api/debug/hilma?keyword=<keyword>` — preview raw HILMA API results for a keyword

---

## Project Structure

```
publictender/
├── server.js          # Express backend — API routes, scraping, AI analysis
├── package.json
├── public/
│   └── index.html     # Single-page frontend (all HTML, CSS, and JS in one file)
└── db/
    ├── settings.json  # AI provider configuration and API keys
    ├── monitors.json  # Monitor definitions
    └── results.json   # Analysis result history
```

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/settings` | Get active provider and provider configs |
| `POST` | `/api/settings` | Update active provider or API keys |
| `GET` | `/api/monitors` | List all monitors |
| `POST` | `/api/monitors` | Create a new monitor |
| `PUT` | `/api/monitors/:id` | Update a monitor |
| `DELETE` | `/api/monitors/:id` | Delete a monitor |
| `POST` | `/api/monitors/:id/run` | Run a monitor immediately |
| `GET` | `/api/results` | Fetch results (supports `?monitorId=` and `?limit=` filters) |
| `DELETE` | `/api/results` | Clear all results |
| `GET` | `/api/debug/hilma` | Test a HILMA keyword search |
| `GET` | `/api/debug/scrape` | Test URL scraping |

---

## Monitor Result Schema

Each analysis run produces a result object stored in `db/results.json`:

```json
{
  "id": "uuid",
  "monitorId": "uuid",
  "runAt": "2025-01-01T12:00:00.000Z",
  "provider": "groq",
  "findings": [
    {
      "url": "https://...",
      "found": true,
      "confidence": "high",
      "summary": "AI-generated summary of the finding",
      "links": ["https://tender-link-1", "..."],
      "hilma": {
        "title": "Procurement title",
        "org": "Procuring organization",
        "deadline": "2025-02-01",
        "published": "2025-01-01",
        "totalValue": 500000,
        "valueCurrency": "EUR"
      }
    }
  ]
}
```

---

## AI Provider Notes

| Provider | Notes |
|----------|-------|
| **Groq** | Fast and free-tier friendly; recommended for getting started |
| **Google Gemini** | Free tier available; good for high-volume monitoring |
| **OpenAI** | Paid; use for highest-quality analysis |

The system handles `429 Too Many Requests` errors automatically with exponential backoff and retries.

---

## License

MIT
