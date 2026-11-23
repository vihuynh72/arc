# Security

Arc reads pages from a student's own signed-in browser, so a security problem here can expose private course material. Reports are welcome and taken seriously.

## Reporting a problem

Please do not open a public issue. Use GitHub's private report form: on this repository, open the **Security** tab and choose **Report a vulnerability**. Say what you found, how to reproduce it, and what it could expose.

You should get a first answer within a week. Arc is maintained by one person, so a fix can take longer than that; you will be told what is planned.

## What counts

- Anything that lets a web page, or another person, read a student's private page, uploaded file or question.
- A way to make Arc's server fetch an address it should refuse (private networks, non-web addresses).
- A way to make the helper extension read a site the student did not allow, click or type on a page, or open a quiz attempt.
- A way to make Arc give, hint at or confirm an answer on a quiz or test.
- A way around the spend guard or the visitor limits.

## How Arc is built to limit harm

- Every fetch of an address a person or a page supplied goes through one guard (`lib/server/safeFetch.ts`): http and https only, public addresses only, checked again on each redirect.
- Private pages and uploads are held in memory only, for about two hours, and never written to disk, an address or a log.
- The helper only reads. It reads a site only after the student allowed it, and only Arc's own pages can message it.
- `npm run selfcheck` includes the security rules (`scripts/checks/security.ts`).

See also [what Arc does with your data](docs/privacy.md).
