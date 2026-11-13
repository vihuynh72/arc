# Arc: read this page (Chrome extension)

Opens the page you are already on in Arc, read from your own tab. No copying links, and nothing is fetched again: it works on pages behind your own login, such as a course site.

## Install (one minute)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `extension/` folder.
4. Optional: open the extension's **Details > Extension options** to set the Arc address. The default is `http://localhost:3000`; the hosted copy is `https://arc-production-815e237c.up.railway.app`.

## Use

On any page, press **Alt+Shift+A** (or click the Arc toolbar button). Arc opens in a new tab with the page rebuilt as a twin. Change the shortcut at `chrome://extensions/shortcuts`.

## What it sends, and where

When you press the shortcut, the extension reads the open tab's address, title and HTML (at most 3.5 MB) and sends them only to the Arc address you set, at `/api/ingest`. Arc keeps only the parsed twin (headings, text, figure links) under `.cache/ingest/` on that server; it never stores or serves the HTML itself. If sending fails, the extension opens Arc with the page's link instead (`/?url=...`), and Arc fetches the public page itself.

## No install: a bookmarklet

Make a bookmark with this as its address (change the origin for the hosted copy). It sends only the link, so it works for public pages, not for pages behind a login:

```
javascript:location.href='http://localhost:3000/?url='+encodeURIComponent(location.href)
```

## Status

Untested in a real browser install so far: the manifest is valid MV3 JSON and the scripts parse. The server route it calls (`/api/ingest`) is tested.
