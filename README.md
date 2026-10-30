# Desk

A private team tool. It shows nothing without a GitHub token that has access to the team's private repositories;
all content is read live from those repositories and is never stored here.

## Tests

- `node test/builder.test.mjs <factory clone>`: the in-browser builder (`js/builder.js`) makes exactly the same pages as
  the factory's own build scripts.
- `node test/e2e.mjs <factory clone> <release clone> [screenshots folder]`: all of Desk in a real browser (Playwright's
  Chromium), with GitHub's API answered from local copies of the two repositories. Signing in, the dashboard,
  submissions (play, test app, approve, decline), submitting and resubmitting, a teammate's limits, builds and the
  Adjust secrets, and the Art page (replacing, refusing, text styles, fonts, the preview of every screen, the warning
  about open proposals, proposing). Nothing reaches the network or the real repositories, and no real token is used.

