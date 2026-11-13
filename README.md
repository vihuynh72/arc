# Arc

Learn the page one sweep at a time.

## What Arc is

Arc is for blind and low-vision students who study from public web pages. It rebuilds a study page as a simple accessible "twin" with real headings, reads it aloud, and glides a cursor ring from section to section. For a figure, it gives a guided tour: a spoken direction such as "Move far down and to the left", a soft chime, and the name of each part. A live panel shows the original page in a remote browser, following the cursor. It is read-only and never clicks.

## How to use it

There is one input box. Paste a link, or say or type what you want. Three things to learn:

1. Hold Space anywhere and speak.
2. Arrow keys move the cursor.
3. Escape stops speech.

Example requests: paste `https://www.mdpi.com/1424-8220/24/6/1935`; "find me a paper about knee rehabilitation"; "take me to the results"; "start the tour of figure 1"; "what does the belt unit contain?". A YouTube link becomes an outline of what is said and what is shown on screen.

## Works on the page you are already on

A student does not have to copy a link.

- **The Arc extension** (`extension/`, Chrome, no build step): on any page, press Alt+Shift+A. It sends the open tab's HTML, only to the Arc server you set, and Arc opens the twin, read from your own tab (`/api/ingest`). Nothing is fetched again, so it works on pages behind your own login, such as a course site. See `extension/README.md` to load it unpacked in a minute. Not yet tested as an installed extension.
- **A bookmarklet**, no install: `javascript:location.href='http://localhost:3000/?url='+encodeURIComponent(location.href)` (public pages only, since Arc fetches the link itself).
- **Deep links**: `/?url=<link>` loads a page on open, `/?q=<request>` runs a request such as a search, `/?doc=<id>` opens a page the extension sent.

## Under the hood

1. You hold Space. Chrome's speech recognition supplies words while the key is held.
2. SubQ Snap gets those words and the page's list of headings and figures.
3. Snap returns a command, a target and probabilities. Arc acts only at 60% confidence or more.
4. Below that, Gemini answers or asks what you meant.
5. Plain code turns the command into a cursor move and its spoken direction.
6. The voice speaks and the cursor ring moves.

In scripted tests the cursor moved 140 to 440 ms after key release, against about 1.5 s when waiting for the Gemini Live transcript. Real-voice timing has not been measured yet.

### Which model does what, and why

| Piece | Job | Why |
|---|---|---|
| Bright Data | Search, page fetch (Web Unlocker), live page view (Browser API) | Some pages block plain requests |
| Gemini Live (`gemini-3.8-live`) | Speech to text, tour speech, spoken answers | One voice connection, relayed by the server |
| Gemini vision (`gemini-3.5-flash-lite`) | Tours for unprepared figures, video outlines | Reads images and video |
| SubQ Snap (`subq-snap-1.2`) | Request to command and target | Median 189 ms direct; 9 of 10 test requests correct |
| Kokoro (`af_bella`, local) | Reads the page, confirms moves | Open source, about 2.5x real time on a laptop |
| Plain code | Parsing, ids, counts, spatial directions | Must be exact |

## Run it locally

```bash
npm install
npm run dev                  # http://localhost:3000
npm run build && npm start
```

Set these in `.env.local`: `BRIGHTDATA_API_TOKEN`, `BRIGHTDATA_UNLOCKER_ZONE`, `BRIGHTDATA_BROWSER_WSS`, `GEMINI_API_KEY`, `SUBQ_API_KEY`. The Kokoro model downloads on first use.

## Project layout

`app/` pages and API routes, `components/` the twin and tour, `lib/` shared code (`server/`, `client/`, `parse/`), `fixtures/` saved demo pages and hand-checked tours, `scripts/checks/` offline checks. Open first:

- `server.ts`: one Node process for Next and `/ws/voice`
- `lib/types.ts`: the shared type contract
- `lib/models.ts`: model and voice names
- `lib/cues.ts`: spatial directions
- `lib/parse/html.ts`: any page's HTML to twin; `lib/parse/markdown.ts`: MDPI markdown to twin
- `lib/server/decide.ts`: the Snap call and the 60% rule
- `lib/server/live.ts`: Gemini Live relay
- `lib/server/fetch.ts`: saved copy, then a plain fetch, then Web Unlocker
- `lib/server/remote.ts`: Browser API remote view
- `lib/client/voice.ts`: hold-Space voice

## Checks

`npm run selfcheck` runs every file in `scripts/checks/`, offline: spatial directions, the Snap act-or-ask rules, the saved-copy fetch, parsing (ids, counts, captions, credit line) and the prepared figure tours.

## How it was built

One person, one day, a team of AI coding agents: a "software factory". One orchestrating session wrote a shared type contract and, for each task, a brief with acceptance checks. About a dozen agents (Claude Opus for the hard pieces, Claude Sonnet for the rest) built pieces in parallel against one dev server, each owning named files. Every piece had to pass its own offline check and a real-browser test before it was committed.

## Limits and what is next

- Not yet tested with blind users or with a screen reader running.
- Twins work beyond MDPI: any page is fetched directly first (Wikipedia, OpenStax and a Cloudflare blog post load in 0.3 to 0.7 s), then through Bright Data's Unlocker, and parsed by one generic HTML parser. Verified from the server on Wikipedia, OpenStax and a blog article; the extension path was tested with Wikipedia's HTML. Pages drawn by scripts (Khan Academy) and PubMed Central fetched from the server (it now answers with a captcha, and Bright Data refuses it) do not load; the extension reads them from the student's tab instead.
- The live page panel still understands MDPI's page structure best.
- Video outlines are YouTube only, about 10 minutes at most.
- Tour boxes for unprepared figures are model-made and can be wrong; they show only at high model confidence. Prepared demo tours are hand-checked.
- The fast voice path uses Chrome's speech recognition.

Next: testing with blind and low-vision students, more page layouts in the live view, real-voice timing.

## Credits

Demo page: "Development of Wearable Devices for Collecting Digital Rehabilitation/Fitness Data from Lower Limbs", Sensors 2024, 24(6), 1935, MDPI, CC BY 4.0. https://www.mdpi.com/1424-8220/24/6/1935

Demo video for the outline feature: a Khan Academy video (CC BY-NC-SA).
