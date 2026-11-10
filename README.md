# Local AI

Start local models from registry recipes, watch them, and open your coding agents.

```
./install.sh                  # runs the server as a user service and, on Omarchy, adds the app to the menu
node server/index.js          # just the server; open http://127.0.0.1:18700 in a browser
npm install && npm start      # the same app in an Electron window
```

A narrow window shows the panel; a wide one shows the desktop layout. The server needs Node 20+, Docker and an NVIDIA GPU with `nvidia-smi`.

| Setting | Default | |
|---|---|---|
| `LOCAL_AI_HOST` | `127.0.0.1` | Address for the server and engines. Use a Tailscale IP to reach them from other devices. |
| `LOCAL_AI_PORT` | `18700` | Engines use the next 99 ports. |
| `LOCAL_AI_HOME` | `~/.local-ai` | Config, your recipes, usage, events. |
| `LOCAL_AI_MODELS` | `~/.local-ai/models` | Downloaded weights. |

**T3 Code:** open `http://127.0.0.1:18700` in a Preview tab. For the chat picker, add a Pi provider with the environment variable `PI_CODING_AGENT_DIR=~/.local-ai/agents/pi`.

Engines have no key of their own, so keep `LOCAL_AI_HOST` on loopback or a private network such as Tailscale.

Everything that happens is in `~/.local-ai/events.jsonl`. What's running is whatever Docker says carries the `local-ai=1` label.

The approved design and the developer handoff are in `design/`.
