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
