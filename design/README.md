# Design

The approved design (v2) and the developer handoff. The app in `web/` was built from these; change the app, not these.

- `index.html` — the clickable design. Open it in a browser. A narrow window shows the panel, and the corner button opens the desktop layout.
- `template.html`, `fs.css`, `fs.js`, `data/`, `cards.json`, `fresco-crop.webp` — its sources. Rebuild with `python3 design/build.py design`.
- `handoff/local-ai-build-map.html` — every screen, how they connect, what each reads from the server, and the API routes. `page.html`, `spec.py`, `build.py` and `graph.json` are what it was generated from; the per-screen screenshots it embeds are not kept here.

Numbers inside the design are sample data. The painting is Michelangelo's Creation of Adam, from a public-domain Wikimedia Commons scan.
