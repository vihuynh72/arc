# What Arc does with your data

Arc has no accounts and no logins. It is for college students and adults, 18 and over.

This page says what leaves your browser, where it goes, why, and how long it is kept. It describes the hosted copy; a copy you run yourself behaves the same unless you change its settings ([deploy guide](deploy.md)).

## What goes where

| What | Goes to | Why | Kept for |
| --- | --- | --- | --- |
| A link you paste or say | Arc's server; the site itself; Bright Data when the site blocks a plain request | To fetch the page | Arc stores public pages it fetched so they open faster next time. Bright Data's own retention is in its terms |
| A search | Arc's server, Bright Data (Google results), open scholarly indexes (OpenAlex, Crossref, Semantic Scholar, PubMed, Europe PMC, arXiv) | To find pages and legal free copies of papers | Not kept by Arc |
| A page's figures, charts, scanned PDF pages and lecture video | Google's Gemini API | To describe a figure, read a chart's values, voice a scanned page, say what a lecture shows | Arc stores the result for public material. Google's own retention and use are in the Gemini API terms |
| A question you ask (your voice or typed text), with the part of the page it is about | Google's Gemini Live API | To hear the question and answer it | Arc's hosted copy keeps no recording and no transcript. Session resumption is off there, so Arc does not ask Google to hold the voice session for later |
| The words Arc reads aloud | Nowhere: the reading voice (Kokoro) runs on Arc's own server. A few languages (Japanese, Chinese, Arabic, Vietnamese) are spoken by a Gemini voice | To read to you | Public sentences are cached as audio on Arc's server. Private text is held in memory only |
| A page from your own account (course site, assignment), sent by the Arc helper or the bookmarklet | Arc's server, and Gemini for its figures and your questions | To read it to you | In the server's memory only, for about two hours after its last use. Never on disk, in an address or in a log |
| A PDF you upload | Arc's server, and Gemini one page at a time when a page cannot be voiced by code | To read it to you | Same as a private page: memory only, about two hours |

## What Arc never gets

- Your password, cookies or sign-in tokens. The helper reads a signed-in page inside your own browser and hands Arc only that page.
- Grades, class lists or messages. The helper reads the page you sent, after you allowed that site, and never opens a quiz attempt.

## What Arc keeps about you

Nothing that names you. The server counts requests per visitor address to enforce limits; logs show an address only as a short hash that changes at each restart, and hold no question, transcript or page text. Your display settings and your place in a page are stored in your own browser.

## On a quiz or test

Arc reads the questions to you. It does not give, hint at, confirm or rule out an answer.

## Questions or a problem

Open an issue at https://github.com/vihuynh72/arc/issues. For a security problem, use the private form described in [SECURITY.md](../SECURITY.md).
