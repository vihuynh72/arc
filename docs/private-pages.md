# Private pages and the Arc helper

[Back to the README](../README.md)

## Works on the page you are already on

A student does not have to copy a link.

- **The Arc helper** (`extension/`, Chrome, no build step): on any page, press Alt+Shift+A and Arc opens that tab, read from your own browser. Paste a link that needs your sign-in and Arc asks the helper to read it for you. See [Private pages](#private-pages) and `extension/README.md`.
- **A bookmarklet**, no install: `javascript:location.href='http://localhost:3000/?url='+encodeURIComponent(location.href)` (public pages only, since Arc fetches the link itself).
- **Deep links**: `/?url=<link>` loads a page on open, `/?q=<request>` runs a request such as a search, `/?doc=<id>` opens a page the helper sent (the id leaves the address bar once it opens).

## Private pages

A course site, an assignment or a file behind a school login: Arc never gets the student's password, cookie or token, and its server never signs in as anyone. The student's own browser, where they are already signed in, reads the page and hands Arc only what they asked for.

- **The helper extension** reads a page two ways: the open tab, on the shortcut; or a link pasted into Arc that answers "needs sign-in", in a background tab that closes afterwards. It reads a site only after the student allowed that site once, on a keyboard-friendly page ("Let Arc read pages from canvas.example.edu that you open? Allow / Not now"); allowed sites are listed, with a remove button, on its options page. Only Arc's own pages can talk to it. It refuses anything that is not a web page, and it never opens a quiz attempt.
- **What it sends**: the page's HTML without scripts or hidden parts, its pictures (fetched with the student's session, downscaled, at most 40 and 8 MB), caption text of its videos, its next, previous and module links, or the PDF itself (at most 25 MB). On Canvas it uses Canvas's own read-only API from the student's session. It never reads grades, class lists, messages, submissions or discussion replies.
- **What Arc keeps**: the private page lives in the server's memory only, under a random id, for about two hours after its last use. It is never written to disk and never logged; its tours, PDF pages and clean-up results stay in memory with it. Descriptions and answers about it are made by Gemini, and Arc says so once.
- **Uploaded PDFs** are held the same way: in memory only, under a random id (never one derived from the file, so someone with the same file cannot reach it), gone about two hours after their last use, and sent nowhere but Gemini, one page at a time.
- **A private page cannot steer Arc off the page**: on it the question session is given no search and no open, and page text is marked as material, never instructions. On any page a search or an open made by the model runs only with the student's own words, a link of the page, a numbered result, or an address the student said.
- **Quizzes and tests**: Arc reads them aloud, and helps move around them, but its answers never give, hint at or confirm an answer.
- **No install** (school computers): `node scripts/bookmarklet.mjs` prints a bookmark that does the same read and hands the page to an Arc tab.
- **Checks**: `npm run selfcheck` (validation, sanitising, assessment detection, expiry, the helper's rules with stubs), `npx tsx scripts/private-e2e.ts` (a pretend signed-in course site, `scripts/private-fixture.mjs`), `npx tsx scripts/handoff-e2e.ts` (the no-install routes). Quizlet is untested.
