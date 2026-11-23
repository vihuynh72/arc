# Arc helper (Chrome extension)

Lets Arc read pages from your own browser, where you are already signed in: the tab you are on (Alt+Shift+A), or a link you paste into Arc that needs your sign-in. Arc never sees your password, cookies or tokens.

## Install (one minute)

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, choose this `extension/` folder.
2. After any change to these files, press **Reload** on the Arc card (manifest changes need it).
3. Optional: **Details > Extension options** sets the Arc address and lists the sites you allowed. The default is the hosted copy, `https://arc-production-815e237c.up.railway.app`, so nothing needs setting. To use Arc running on your own computer, set it to `http://localhost:3000` and press Save.

From the Chrome Web Store (when listed) the helper installs the same way and uses the hosted copy. `npm run pack:extension` writes `arc-helper.zip` at the repo root for upload; `STORE.md` holds the listing text.

## What it does, and will not do

- **Send this tab** (toolbar button or Alt+Shift+A, Option+Shift+A on Mac): reads the open tab in place and opens it in Arc. Your key press is the permission (Chrome's activeTab).
- **A link pasted into Arc that needs sign-in**: Arc asks the helper. The first time for a site, a page asks "Let Arc read pages from that site that you open?" with Allow focused; Chrome then asks once more. After that, the helper opens the link in a background tab, reads it, closes the tab and hands it to Arc.
- Only Arc's own pages (`http://localhost:3000`, the hosted copy) can message it. It reads a site only after you allowed it (Chrome's optional host permissions, per site; never all sites at once). It refuses `file:`, `chrome:`, `javascript:` and other non-web addresses, the browser's own pages, and any address that would start a quiz attempt.
- Files: `background.js` (the helper; chrome.* calls behind one small layer), `rules.js` (what it refuses), `extract.js` (the page reader, shared with the bookmarklet and the checks), `consent.html`/`consent.js`, `options.html`/`options.js`, `arc-page.js` (tells Arc's own page the helper is installed).

## Five-minute manual test

Start Arc (`npm run dev`), set the helper's Arc address to `http://localhost:3000` in its options (the default is the hosted copy), and start the pretend course site: `node scripts/private-fixture.mjs` (http://127.0.0.1:8765). Press **Reload** on the extension first. (The scripts `private-e2e.ts` and `handoff-e2e.ts` do not load the extension; they take the Arc address as an argument.)

1. Open http://127.0.0.1:8765/course/pages/cells without signing in. Press Alt+Shift+A. Arc opens and you hear: "That page asked you to sign in. Sign in to it in your browser, then try again." (Arc refuses a sign-in page.)
2. Open http://127.0.0.1:8765/login (it just sets a cookie and shows the Cells page). Press Alt+Shift+A. You hear "Read from your tab.", then "This page came from your own account. Arc keeps it only while you use it, and descriptions and answers about it are made by Gemini.", then "Cells and membranes." and the section count. The diagram is on screen; the equation is read as "J equals negative D the fraction d c, over d x". The address bar shows no `?doc=`.
3. Consent. Arc's server refuses local addresses before it would ever say "sign in", so the fixture cannot trigger the prompt by pasting. Open the prompt yourself: copy the Arc card's ID on `chrome://extensions`, open `chrome-extension://<ID>/consent.html?origin=http://127.0.0.1:8765`. Focus is on **Allow**: press Enter, then accept Chrome's own question. The options page now lists 127.0.0.1:8765. (With a real sign-in link pasted into Arc, Canvas for example, you would first hear "That page needs your sign-in. Your browser will ask if Arc may read it: press Enter to allow." and this page opens by itself; **Not now** there makes Arc say "Arc may not read pages from that site yet.")
4. On the Cells page in Arc, say or type "next page". You hear "Reading that page from your own browser.", a background tab opens and closes, and "Energy in cells" opens. "Next page" again goes to the notes PDF.
5. Open http://127.0.0.1:8765/course/files/notes and press Alt+Shift+A: Arc opens the PDF ("PDF, 2 pages") and reads "Week 2 notes".
6. Open http://127.0.0.1:8765/course/quizzes/3/take and press Alt+Shift+A: you hear "This looks like a quiz or test. I will read it to you, but I will not answer its questions." Next moves question by question; each choice is read as "Choice: ...". Hold Space and ask "which answer is right for question 2?": Arc says, in one sentence, that it cannot help answer test questions, and offers to read it again.
7. Options page: the site you allowed is listed; press Remove; it is gone, and the next request asks again.

If something is silent, open `chrome://extensions`, the Arc card, **service worker**, and look for lines starting with "Arc:".

## No install: a bookmarklet

`node scripts/bookmarklet.mjs` (add the Arc address for the hosted copy) prints a `javascript:` address: make a bookmark with it. On a page, click it: an Arc tab opens and the page is handed to it with postMessage, only to that Arc address. It reads the same things as the helper, except frames from other sites. Allow pop-ups for the site if Chrome blocks the Arc tab.
