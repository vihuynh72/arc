# Chrome Web Store listing text

Text to paste into the Chrome Web Store developer dashboard. Not shipped in the zip (`npm run pack:extension` leaves it out). Nothing private belongs here: this repository is public.

## Name

Arc: read this page

## Summary (132 characters at most)

Send the page you are on to Arc with one key, and Arc reads it aloud. Arc never sees your password.

(99 characters.)

## Category

Accessibility

## Language

English

## Detailed description

Arc is a reading tool for college students and adults, 18 and over, who study by ear. It reads web pages, PDFs and lecture videos aloud, and moves through them by key and by voice.

Pasting a link into Arc is not always easy, and some pages are behind a sign-in that Arc cannot open. This helper is a shortcut. Press Alt+Shift+A (Option+Shift+A on a Mac) on the page you are on, and the page opens in Arc.

What the helper does:
- You press the key. The helper reads the open tab from inside your own browser, where you are already signed in, and opens it in Arc.
- You can also paste a link into Arc that needs your sign-in. Arc asks the helper to read it. The first time for a site, you are asked once whether Arc may read pages from that site. Arc reads it only if you say yes.

What Arc never gets:
- Your password, your cookies or your tokens. The helper reads the page you see, not your account.
- Anything from a site you have not allowed.

What the helper will not do:
- It does not run on its own. It reads a page only when you press the key or ask Arc for a link.
- It only reads. It never clicks, types or submits anything for you.
- It will not open a quiz or test, because opening one can start your attempt. If you are already on a quiz, Arc reads it to you and does not answer its questions.
- It does not read Chrome's own pages, files on your computer or other non-web addresses.

The page you send is kept in Arc's memory for about two hours while you use it. It is not written to disk. Descriptions of pictures and answers to your questions about the page are made with Google Gemini.

You can see and remove every site you allowed in the extension's options. The options also let a developer point the helper at a copy of Arc on their own computer.

Arc is open source: https://github.com/vihuynh72/arc

## Single purpose

Send the web page the student is on, or a link the student pastes into Arc, to Arc so that Arc can read it aloud to them.

## Permission justifications

- **activeTab.** Lets the helper read the tab the student is on, only after they press the shortcut or the toolbar button. The key press is the permission.
- **scripting.** Used to run the helper's page reader (`extract.js`) in that tab, and in a background tab for a link the student pasted into Arc. The reader only reads; it does not change the page.
- **storage.** Keeps one setting, the address of the Arc server the page is sent to. The default is the hosted copy. A developer can change it to a copy on their own computer.
- **Host permissions: `https://arc-production-815e237c.up.railway.app/*` and `http://localhost:3000/*`.** These are Arc's own addresses. The helper sends the page it read to Arc there, and a small script on those pages tells Arc that the helper is installed. Only those two addresses can message the helper. The localhost address is for developers running Arc on their own computer.
- **Optional host permissions: `https://*/*` and `http://*/*`.** Not granted at install. The helper asks for one site at a time, only when the student pastes a link from that site into Arc and the site needs their sign-in. The student sees the site's name and can say no. It is used to open that link in a background tab, read it, and close the tab. The student can remove any site in the options at any time. The helper never holds access to all sites at once.
- **Content script on Arc's own addresses.** Sets one attribute on Arc's page so Arc knows the helper is installed. It reads and sends nothing.
- **Remote code.** None. All code is in the package.

## Data use disclosure (Privacy practices tab)

What the helper handles, and only when the student asks:
- **Website content** (text, pictures and links of the page the student sends): yes. It is sent to Arc to be read aloud.
- **Web history** (the address of the page the student sends): yes. The address travels with the page so Arc can show where it came from.
- **Personally identifiable information, health information, financial and payment information, authentication information, personal communications, location, user activity** (clicks, keystrokes, mouse position): no. The helper does not collect these. It never reads cookies, tokens or passwords, and it does not watch what the student does.

Certifications (all three apply):
- The data is not sold or transferred to third parties outside the approved use cases.
- The data is not used or transferred for purposes unrelated to the helper's single purpose.
- The data is not used or transferred to decide creditworthiness or for lending.

Other answers:
- Data is sent to Arc's server over HTTPS (the hosted copy). It is kept in memory for about two hours, never on disk, in a URL or in a log, and then dropped.
- Arc has no accounts and no logins.
- Descriptions of pictures and answers to questions about a sent page are made with Google Gemini.
- Intended users: college students and adults, 18 and over.

## Privacy policy address

https://github.com/vihuynh72/arc/blob/main/docs/privacy.md

## What the owner must do by hand

1. Check that `docs/privacy.md` on `main` still says what the data-use answers above say.
2. Create a Chrome Web Store developer account (one-time registration fee) and verify the contact email.
3. Run `npm run pack:extension` and upload `arc-helper.zip` as a new item.
4. Paste in the name, summary, description, category, single purpose, permission justifications and data-use answers above.
5. Add screenshots at 1280x800 (at least one, up to five): for example the Arc start page, a page opened in Arc after Alt+Shift+A, and the options page. Use the 128 px icon from `extension/icons/` as the store icon. A small promo tile (440x280) is optional.
6. Submit for review. Because of the optional access to all sites, expect a longer review and questions about it; the justification above is the answer.
7. When the listing is live, put its address in `HELPER_STORE_URL` in `lib/keys.ts`: the start page then shows an "Add to Chrome" link and the spoken answer points to the store.
