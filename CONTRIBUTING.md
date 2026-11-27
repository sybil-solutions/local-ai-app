# Contributing

Thanks for helping with Local AI. This project is deliberately small: plain Node on the server, plain ES modules in the browser, no build step and no framework. Please keep it that way.

## Before you start

- For a bug or a feature, open an issue first if the change is not small. It is easier to agree on the shape before writing code.
- For a security problem, **do not open a public issue**. Follow [`SECURITY.md`](SECURITY.md).
- By contributing, you agree that your contribution is licensed under the project's MIT License (see [`LICENSE`](LICENSE)).

## Set up

```bash
npm ci          # install the development tools
npm start       # the desktop app, from source
node server/index.js   # or just the server on http://127.0.0.1:18700
```

Node 20 or newer is required. Starting real models also needs Docker and a supported GPU, or Apple silicon with Python 3.11+; the tests use stand-ins and do not need either.

## Checks

Run the full suite before opening a pull request:

```bash
npm run check
```

That runs, in order:

- `npm run lint` — ESLint
- `npm run screens` — every screen rendered in every state
- `npm run fuzz` — hostile input against everything that decides what is safe
- `npm run test:integration` — the real server against stand-in engines, Docker and a second machine
- `npm run test:e2e` — the real desktop app, driven through its window

The end-to-end test needs a display; on a headless Linux machine run it under `xvfb-run -a`. There are no unit tests on purpose: a function that passes alone says little about an app whose real work is other programs. Add a case to the integration, fuzz, screens or end-to-end suite rather than a unit test.

## Code

- Keep the server dependency-free. It uses only Node built-ins.
- Put a comment where it answers *why*, not *what*.
- Security-sensitive decisions live in a few files (`server/docker.js`, `server/recipes.js`, `server/index.js`, `server/release.js`, `server/machines.js`). If you change one, add or extend the matching fuzz or integration case.
- If you change behaviour, update `README.md` and the relevant test in the same pull request.
- Do not commit secrets, keys, tokens, model weights, or `~/.local-ai` state.

## Pull requests

- Keep each pull request focused on one change.
- Say what changed and why, and which checks you ran.
- Link the issue it closes, if there is one.
- A maintainer will review it. Please be patient; this is a small project.

## Code of Conduct

All participation is covered by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
