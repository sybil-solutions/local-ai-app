# Security

Local AI starts models and coding agents on your own machine, so its security model is worth understanding before you run it. This page is both the reporting process and a short map of what the app does and does not defend.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately through GitHub:

<https://github.com/sybil-solutions/local-ai-app/security/advisories/new>

Include what the issue is, how to reproduce it, the version you ran, and the platform (Linux, macOS, Windows, or the iOS app). A proof of concept helps. We will acknowledge the report as soon as we can, usually within a few business days, and keep you informed until it is fixed.

## Supported versions

Only the newest published release and `main` are supported. Older versions are not patched.

## What is in scope

- The server (`server/`) and its HTTP API, including authentication.
- The web app (`web/`) and the Electron shell (`electron/`).
- `install.sh`, the release scripts, and the update path.
- The way the app launches engines and coding agents.

## What is not in scope

- Vulnerabilities in upstream model engines, Docker, Tailscale, or the operating system.
- Model weights and their licences.
- Anything that requires an already-compromised account or machine.

## The security model, briefly

- **The key.** The key in `~/.local-ai/config.json` (mode `0600`) guards the whole API. It is compared in constant time and is never handed to a caller just for coming from loopback. The desktop app and the installer hand it to their own window in the URL fragment; a browser asks for it once.
- **Your machines.** Another machine signed in to your Tailscale account as you is trusted, but only when the request addresses this machine's own tailnet name or address.
- **Other websites.** The page is served with a strict content policy, no CORS, and cannot be framed.
- **Registry recipes.** Container recipes run only with hash-pinned images and weights, with a short list of allowed Docker options and no privilege gains. Host recipes run as you, so they must be hash-pinned and are shown to you for approval first.
- **Updates.** Installed copies accept a release only when its file list is signed with the release key and every file matches the signed size and SHA-256. A copy cloned from the repository updates with `git pull`, which is not signed.
- **The desktop app** is sandboxed (context isolation, sandboxed renderer, Electron fuses) and navigates nowhere but its own page.

## Known limitations

These are deliberate trade-offs, not vulnerabilities, but they matter:

- **Engines have no key.** A model's port is not authenticated, so anything that can reach it can use the model. Keep the server on loopback or a private network such as Tailscale.
- **Coding agents run without approval prompts.** Agents opened from the app are started with their own confirmation steps disabled (Claude Code with `--dangerously-skip-permissions`, Codex with `--dangerously-bypass-approvals-and-sandbox`). A local model's output is still untrusted input; run an agent in a folder you are willing to have changed.
- **Tailnet sharing is on by default** when Tailscale is running. Set `LOCAL_AI_SHARE=0` or `LOCAL_AI_HOST=127.0.0.1` to keep the app on loopback only.
- **The registry is fetched over HTTPS but is not signed.** Recipes still have to be pinned, and a registry host recipe still has to be approved.
