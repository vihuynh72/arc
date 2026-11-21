# Running Arc for other people

[Back to the README](../README.md)

Everything about hosting a copy: the voice options, the spend guard, visitor limits, every environment variable, and what the server refuses.

## Deploy (an open public link)

Arc runs as one long-lived Node process (`npm start`), never serverless. On a small host set `ARC_KOKORO=off`: pages are then read by the Gemini voice (about $0.02 a minute of speech), or, if you also set `ARC_BROWSER_VOICE=on`, by Kokoro in the visitor's own browser once it has downloaded.

**Browser voice (opt-in).** With `ARC_KOKORO=off` and `ARC_BROWSER_VOICE=on`, a visitor's Chrome or Edge with WebGPU reads English with Kokoro (af_bella, the same audio as the server's) in the browser itself, free: after the first key press it downloads the voice once (about 331 MB: the 326 MB model from Hugging Face, the 5 MB compressed runtime from this server; 3.4 minutes on the test connection) while the Gemini voice keeps reading, then switches at the next paragraph. A visitor's browser contacts huggingface.co (and its download host hf.co) only to download the voice; nothing about the page they read is sent there, and the browser keeps the files, so the next visit starts at once. Without WebGPU, or with Save-Data on, nothing downloads. Licences: kokoro-js and transformers.js Apache-2.0, the Kokoro-82M model (and its ONNX export) Apache-2.0, onnxruntime-web MIT; the phonemizer package is marked Apache-2.0 but contains eSpeak NG, which is GPL-3.0. Everything paid is guarded in one place (`lib/server/budget.ts`, prices in `lib/server/prices.ts`), and visitor limits sit in `server.ts` (`lib/server/limits.ts`). Both are on when `NODE_ENV=production`.

As today's estimated Gemini spend crosses the daily budget, Arc degrades in order and says so in plain words: at 50% it drops extras (chart data reads, video re-descriptions, page clean-up, automatic video pictures); at 80% it prepares only what a student asks for; at 100% it refuses new model calls with one spoken line, while pages, navigation and stored results keep working. When Gemini answers that the balance or the spending cap is used up, Arc pauses model calls for a few minutes and says so, instead of retrying. Set a monthly spending cap on the Gemini project as well: it is the limit that holds even if this server is wrong.

| Variable | What it does |
|---|---|
| `GEMINI_API_KEY`, `BRIGHTDATA_API_TOKEN`, `BRIGHTDATA_UNLOCKER_ZONE`, `BRIGHTDATA_BROWSER_WSS`, `BRIGHTDATA_SERP_ZONE` | Service keys and zones (never commit them) |
| `NODE_ENV=production` | Production build; turns on the budget guard and visitor limits |
| `ARC_KOKORO=off` | No local voice (small host); reading uses the Gemini voice |
| `ARC_BROWSER_VOICE=on` | Visitors' browsers read with their own Kokoro: free and the same voice as the laptop's, but a first visit downloads about 331 MB (default: off) |
| `ARC_DAILY_BUDGET_USD` | Daily Gemini budget in dollars (default 2), UTC day |
| `ARC_DAILY_BD_REQUESTS`, `ARC_DAILY_BD_NAVS` | Daily Bright Data caps: Web Unlocker plus SERP requests (default 400), Browser API navigations (default 40) |
| `ARC_VISITOR_DAILY_USD` | One visitor address's share of the day's estimated Gemini spend (default 0.50; an IPv6 address counts by its /64). Measured: opening the demo paper about $0.15, a ten-minute lecture $0.12, the paid reading voice about $0.02 a minute, so a full study session with questions fits and the $2 day serves at least four visitors. Past it that visitor hears the daily budget line |
| `ARC_VOICE_MINUTES_PER_VISITOR` | Minutes of Gemini speech one visitor address may hear a day (default 30) |
| `ARC_VOICE_PER_IP`, `ARC_VOICE_TOTAL` | Open voice connections per visitor (2) and in all (12) |
| `ARC_VOICE_IDLE_MS`, `ARC_VOICE_MAX_MS` | A voice connection closes after 10 idle minutes, and after 45 minutes in all (the page reopens one) |
| `ARC_WARM_FIGURES`, `ARC_WARM_CHARTS=off` | How many figures get a tour prepared in the background per page (30), and whether chart data is read before a student reaches the chart |
| `ARC_MAX_VIDEO_S` | Longest lecture Arc reads, in seconds (7200) |
| `ARC_GEMINI_PARALLEL` | Model calls in flight at once (4) |
| `ARC_LIMIT_<CLASS>` | Override one visitor limit as `burst,perMinute` (classes in `lib/server/limits.ts`) |
| `ARC_PROXY_HOPS` | Trusted proxies in front of Arc (1 on Railway, detected; 0 elsewhere). The visitor address is the one the last proxy appended to `x-forwarded-for`. Set it behind any other proxy: at 0 every visitor shares the proxy's limits, and Arc warns once in its log when forwarded headers arrive |
| `ARC_CACHE_MB_PDF`, `_IMAGES`, `_TOURS`, `_AUDIO` | Disk caps for those `.cache` folders, trimmed least recently used first at start and hourly (hosted defaults 1000, 500, 100, 500 MB; ten times that in development) |
| `ARC_PDF_DOCS`, `ARC_PDF_DOC_MB` | Open PDFs kept in memory (8, 200 MB of files); older ones reopen from their file when asked |
| `ARC_VAULT_MB`, `ARC_VAULT_TTL_MS` | All private pages and uploads together in memory (1024 MB, oldest dropped first), and how long one lives after its last use (2 hours) |
| `ARC_TOUR_PICTURES`, `ARC_TOUR_JOBS` | Picture addresses Arc has seen and may build tours for (20000), tour states kept (5000) |
| `ARC_VOICE_CONTEXT_CHARS`, `ARC_VOICE_WHERE_CHARS`, `ARC_VOICE_SAY_CHARS`, `ARC_VOICE_SAY_QUEUE`, `ARC_VOICE_ASK_SECONDS`, `ARC_VOICE_AUDIO_MINUTES` | Voice relay caps: page text 16000 and position text 16000 characters, a read-aloud line 2000 characters, 40 lines waiting, 60 s of microphone per question, 20 minutes per connection |
| `ARC_PRICE_*` | Override a price (names in `lib/server/prices.ts`) |
| `ARC_LIMITS=on` / `ARC_BUDGET=on` | Turn limits or the budget guard on outside production (`off` turns them off) |

**Cross-site requests.** `server.ts` refuses, before Next sees them, any request other than GET, HEAD or OPTIONS, any request to `/api/pointer` or `/api/budget`, and every WebSocket, when its `Origin` names another host or port or `Sec-Fetch-Site` says another site sent it; a WebSocket must name its origin (tools such as `scripts/measure-costs.mjs` pass Arc's own). `/api/ingest` keeps its own rule (Arc's tab and the extension). `/api/pointer` and `/api/budget` also need the connection itself to come from this machine. JSON bodies are capped by length (a body with no length is refused). Every response carries `nosniff` and a referrer policy, pages `frame-ancestors 'none'`, and production adds HSTS. A full script policy is not set yet: it needs nonces for Next's inline scripts, `connect-src` for the voice socket, `frame-src` for YouTube and `img-src` for figures from any site.

**Logs.** A hosted log holds no question, transcript or page text, and visitor addresses appear only as a short hash that changes each restart. In development the ask timing lines quote what was heard (`ARC_KEEP_ASKS`), never for a private page.

The day's spend is saved under `.cache/budget/`, which a redeploy wipes: after a redeploy the day starts again from zero. `GET /api/budget` shows today's totals by feature and model, from the same machine only.

## Live data and stored copies

Every page and search is fetched live. A page or search fetched before is shown at once as a first view, said to be a saved copy, and replaced by the live one when it arrives (the two prepared demo pages in `fixtures/` too). Audio clips, model outputs for the same text or image, and the Kokoro model stay cached, because they are derived from the live content and are not page data. `ARC_OFFLINE=1` (for a room with no network) serves stored copies only and makes no live fetch.
