# Contributing to Arc

Thank you for helping. These notes are short on purpose.

## Set up (offline, no keys)

You need Node 22 or newer and, for the browser tests, Google Chrome.

```bash
npm ci
ARC_OFFLINE=1 npm run dev
```

Open http://localhost:3000 and the bundled demo paper. It works with no keys. New links, search and spoken questions need the keys named in `docs/deploy.md`; you never need them to run the checks below, and no check spends money.

## Before every commit

```bash
npm run check
```

This runs the typecheck, the lint (errors fail it, warnings do not) and the selfcheck, all offline. It takes about 25 seconds and prints one line per step.

## Before you open a pull request

```bash
npm run factory
```

This runs `npm run check`, then copies your working tree to a scratch folder, builds it there, starts the production server there on a free port with no keys, runs the browser suite (`npm run e2e`) against it, and cleans up. Your own dev server and `.next` folder are not touched. Useful flags: `--only <scenario>`, `--skip-e2e`, `--keep` (keep the scratch copy).

The browser suite reads stored pages from `.cache`, which is not in git. If you have none, the PDF, lecture, scholar and search scenarios cannot pass; say so in the pull request instead of weakening a scenario.

A scenario that fails and then passes when run alone again is reported as FLAKY. Do not ignore it: fix its timing or tell us.

## Size of a pull request

Aim for 100 to 500 changed lines. A thousand is the most we will review in one pull request. Split bigger work into steps that each pass `npm run factory` on their own.

## What CI runs

On every pull request and every push to `main` (`.github/workflows/ci.yml`):

- `check` (required): typecheck, lint, selfcheck and `npm run build` on Node 22. No secrets.
- `e2e` (not required yet): the same offline production server and browser suite as `npm run factory`, in Google Chrome. It becomes required after ten passing runs in a row. When it fails, the logs and screenshots are attached to the run.

A newer push to the same branch cancels the run before it.

## Things spoken or heard

Arc speaks for itself, and the student's own screen reader is off. A passing test does not show that a line sounds right, arrives on time or does not talk over the lecturer. If you change anything that is spoken, heard or moved by a key, try it in a real browser with the sound on, by keys and by voice. The simulated user in `scripts/blind/` helps find dead ends, but it is not a person: Arc has not been tested with blind users or with a screen reader, so do not say it has.

## Rules that are easy to break

`CLAUDE.md` is not in the repository, but these rules hold: every fetch of an address a user supplied goes through `lib/server/safeFetch.ts`; nothing private goes to disk, a URL or a log; no stores of student data; every paid model call is reported to `lib/server/budget.ts`; never leave a student in silence.
