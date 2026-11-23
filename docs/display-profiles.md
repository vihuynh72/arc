# Display profiles for low vision

[Back to the README](../README.md)

For students who have some vision but for whom one fixed look does not work. Press **Display** in the header, or say or type "bigger text", "high contrast", "too bright", "I have dyslexia", "turn on the focus line", "reset display". Five ready-made profiles (Default, Low vision, Light sensitive, Dyslexia friendly, Narrow field of view) are starting points; under "More options" each setting (colours, text size 100 to 200%, spacing, typeface, focus line, motion) can be changed on its own, and they combine. The choice is kept in this browser only.

These profiles are built from published guidance, not from testing with people who have these conditions.

| Need | What the guidance says | What Arc does |
| --- | --- | --- |
| Low acuity, central loss | Some people need larger text; avoid horizontal scrolling at 400% zoom ([W3C low vision](https://www.w3.org/TR/low-vision-needs/), [WCAG 1.4.4, 1.4.10](https://www.w3.org/TR/WCAG22/)) | Text 125/150/200% from the root; from 150% one column and no sticky bars; Atkinson Hyperlegible, designed by the Braille Institute for low vision ([source](https://github.com/googlefonts/atkinson-hyperlegible)) |
| Light sensitivity, glare | Bright light from a screen stops some people reading ([W3C 3.1.1](https://www.w3.org/TR/low-vision-needs/)); pure white on black can halo (design guidance, not clinical: [BOIA](https://www.boia.org/blog/dark-mode-can-improve-text-readability-but-not-for-everyone)) | Low glare dark: warm grey, no pure white, body text 11:1, images dimmed until looked at |
| Low contrast sensitivity | Contrast 7:1 for text ([WCAG 1.4.6](https://www.w3.org/TR/WCAG22/)); 3:1 for controls ([1.4.11](https://www.w3.org/TR/WCAG22/)) | High contrast light and dark; every theme keeps text 7:1+, ring and borders 3:1+ (ratios in app/profiles.css) |
| Dyslexia | Dark text on a light, not white, background; sans serif; avoid italics and capitals; 1.5 line spacing ([BDA](https://www.bdadyslexia.org.uk/advice/employers/creating-a-dyslexia-friendly-workplace), [Dyslexia Scotland](https://dyslexiascotland.org.uk/dyslexia-friendly-typed-formats)); special "dyslexia fonts" showed no gain in rate or accuracy ([Wery and Diliberto 2017](https://pmc.ncbi.nlm.nih.gov/articles/PMC5629233/)) | Soft cream, WCAG 1.4.12 spacing, shorter lines, upright text, sentence case labels, a legible sans (not a dyslexia font) |
| Narrow field, tracking | Long lines are harder; losing your place is hard to recover ([W3C 3.2.3, 3.6.1](https://www.w3.org/TR/low-vision-needs/)) | Focus line: everything but the item under the reading cursor is dimmed, the current item gets a band; narrower column |

## Using Arc with your own screen reader (experimental)

Most blind students already have a screen reader with a voice and speed they chose. By default Arc speaks in its own voice and asks you to turn your screen reader's speech off. This setting is the other way round: Arc stops speaking the reading and writes each sentence, one after another, to a single hidden live region (`aria-live="assertive"`), so your own screen reader says it.

**Turn it on:** say or type "use my screen reader" or "screen reader mode", or open **Display** and choose **On: my screen reader speaks** under "Use my screen reader". **Turn it off:** say or type "use your own voice", "Arc voice" or "stop using my screen reader", or choose Off in Display. It is off by default and kept in this browser only. Each switch answers in one sentence, through whichever voice is then active.

**What changes:** the reading (headings, paragraphs, items, the lines Arc says after a key such as where you are) goes to the live region and no audio is requested. Arc waits about 60 ms per character (at least 600 ms) before the next sentence, because it cannot hear when your screen reader has finished. Arc's own spoken description of what has focus is switched off, because your screen reader already names it.

**What still uses Arc's voice:** figure and chart tours, answers to questions, and the ticks, chimes and chart tones. They are spatial, timed or made as audio, and tour text is never written to a live region. Nothing is written to the live region while one of them is playing.

**Not known:** this has not been tried with JAWS, NVDA or VoiceOver by a real user; the only checks so far are automated. Arc's single-letter keys (H, F, T, E, R and the arrows) may collide with a screen reader's browse-mode keys; this first slice does not resolve that. The estimated wait will be too long or too short for some speech rates, and an assertive region interrupts a line still being spoken. Please do not rely on it for coursework until it has been tried.
