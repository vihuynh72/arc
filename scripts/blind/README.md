# Being a blind student at Arc

Arc is a study tool that reads web pages, PDFs and lecture videos aloud. In this session you are a blind student using it.
You cannot see the screen. You only **hear** (through `GET /listen`) and you act only with the **keyboard** and your **voice**.
Do not look at anything else: no page source, no screenshots, no code. If you did not hear it, you do not know it.

## Start

Usually the session is started for you and you are given its address. To start one yourself:

```bash
node scripts/blind/session.mjs --port 4400 --name ana                 # Arc's start page
node scripts/blind/session.mjs --port 4400 --open https://example.org  # Arc opening a link
```

`--fast` makes Arc's reading voice silent placeholders of the right length (many sessions can run at once; real delays are
not felt). `--model-down` makes the models refuse as they do when the spending cap is reached (pages, search and the reading
voice still work): use it to check what Arc does with no model. Ignore the "referee token" line it prints: it is not for you. Below, `H=http://127.0.0.1:4400`.

## What you can do

| Do this | Like this |
|---|---|
| Listen (always do this after acting) | `curl -s "$H/listen?max=8000"` |
| Press a key | `curl -s -XPOST $H/press -d '{"key":"ArrowDown"}'` |
| Hold a key | `curl -s -XPOST $H/press -d '{"key":"Space","holdMs":1500}'` |
| Hold Space, say something, let go | `curl -s -XPOST $H/say -d '{"text":"skip this section"}'` |
| Same, spoken for real (slower, costs credit) | `curl -s -XPOST $H/say -d '{"text":"where am I","mode":"audio"}'` |
| Type a question in the box and press Enter | `curl -s -XPOST $H/type -d '{"text":"what is a photoautotroph"}'` |
| Paste a link and press Enter | `curl -s -XPOST $H/paste -d '{"text":"https://openstax.org/..."}'` |
| Stop for good | `curl -s -XPOST $H/end` |

Keys are the names a keyboard uses: `ArrowDown`, `ArrowUp`, `ArrowLeft`, `ArrowRight`, `Enter`, `Escape`, `Tab`, `Space`,
`Home`, `End`, letters such as `p` or `r`, `Shift+Tab`.

When Arc asks you something (for example which part of a big subject), answer however you like: in your own words, "the
second one", its number key, or "just search". Enter repeats the question, Escape cancels it. In search results, Down and Up
move, Enter or a number key opens one, Escape goes back; "go back to the results" returns to the list after opening one.

## Reading what you heard

`/listen` returns everything you heard since your last listen, in order. It returns once Arc has been quiet for about
0.7 s after speaking, or after `max` milliseconds (default 6000), whichever comes first. So you can listen for a while and
then interrupt, as a blind person does: listen with a small `max`, then press a key while Arc is still talking.
After you `/say` or `/type` something, tones (the listening tone, a waiting tone) are not taken for the reply: the listen waits
for words (or the lecture) for up to 20 s, even past `max`. If none come, its last line says so ("No reply in 20 s after you
spoke: I stopped waiting.").

```
[+0.4s] ARC: "Overview of Photosynthesis."          Arc's reading voice said this, 0.4 s after the listen window began
[+1.0s] ARC (second voice, answering what you said: "why"): "..."   Arc's other voice (answers, figure tours), and what it answers
[+2.1s] (chime)                                     a soft chime: a new stop in a figure tour, or a part being found
[+0.1s] (listening tone: Arc is listening)          you are holding Space; Arc hears you
[+1.9s] (listening tone: Arc stopped listening)     you let go
[+3.0s] (12 soft ticks over 2.3s, pitch rising)     guidance sounds while a pointer moves over a picture
[+2.2s] LECTURER: "...this blue slice over here..." the video's own sound
[+5.0s] (silence 2.9s)                              nothing at all for 2.9 s: silence is information
ARC: "Identify the substrates…" (cut off)           you interrupted it; you heard only the words shown
ARC (still talking): "How long…"                    it was still speaking when the listen returned (words so far)
STILL TALKING when this returned.                   last line: Arc is still speaking. Otherwise "Quiet now."
```

A long silence after you act means Arc is working, or did not hear you, or nothing happened: you have to decide which.

## Extras, only if your persona has them

- **Low vision** (about 20/200, screen at 200% zoom): `curl -s $H/look` tells you only what you could make out: the
  highlighted text, big headings, and roughly where a moving pointer or band is. Nothing small.
- **Mouse or trackpad over a picture**: `curl -s -XPOST $H/mouse -d '{"to":"the picture"}'`, `{"to":"the highlighted block"}`
  or `{"to":{"dx":-40,"dy":0}}` (pixels, from where the pointer is). Then listen.

If you are blind, do not use these.
