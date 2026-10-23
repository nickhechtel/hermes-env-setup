# env-setup — Setup Assistant for Hermes

Guided credential setup: the agent asks for environment variables **by name
only**; the user fills a **masked desktop form**; values are written
**directly to `.env`** and never enter the chat, the tool results, or the
model context.

## Why

"Normies" cannot edit `.env` files — but they also should never paste
secrets into a chat with an LLM. This plugin removes both problems:

```
User:  "Richte mir die Mailanbindung ein"
Agent: calls env_setup_prompt(fields=[{name: EMAIL_IMAP_HOST, ...}, ...])
  → masked form opens in the desktop app
  → user types the values into the form
  → values go straight to ~/.hermes/.env
Agent: sees ONLY {"status": "resolved", "configured": [...names...]}
```

## Components

| File | Runs in | Role |
|---|---|---|
| `plugin.yaml` | — | manifest, declares `provides_tools` |
| `__init__.py` | gateway | plugin entry point `register(ctx)` |
| `tools.py` | gateway/agent | `env_setup_prompt`, `env_setup_status` tools |
| `core.py` | gateway | request registry (process-global singleton), catalog, `.env` writer |
| `integrations.json` | — | static catalog (email, Telegram, Discord, OpenAI, Anthropic, OpenRouter, GitHub) |
| `dashboard/manifest.json` | — | backend mount declaration |
| `dashboard/plugin_api.py` | gateway | REST routes under `/api/plugins/env-setup/` |
| `desktop/plugin.js` | desktop app | Setups page (`/setup`), statusbar chip, forms |

## Security invariants

1. **Values never travel towards the model.** `env_setup_prompt` returns only
   `configured`/`skipped` variable *names*. `catalog()`, `status()` and all
   REST routes return names + set/unset flags only.
2. **ENV names are strictly validated**: `^[A-Z][A-Z0-9_]{1,63}$` — no `.env`
   format injection (no `=`, no newlines).
3. **Secret fields default to masked** (`secret: true` unless explicitly
   opted out).
4. **Only one open request** — a new prompt supersedes the old one (no
   dialog spam).
5. Empty form fields never overwrite existing `.env` values (empty → skip).

## Agent tool contract

- `env_setup_prompt(fields, title, reason, timeout_seconds)` — opens the form,
  waits (default 150 s). On timeout the request stays open in the desktop app;
  the agent picks up a late completion via `env_setup_status`.
- `env_setup_status()` — which integration variables are set/missing + any
  late resolutions.

## Install (one click)

```
hermes://plugin/install?repo=nickhechtel/hermes-env-setup&enable=1
```

The desktop app shows a confirmation dialog and picks the components:
- **Desktop half** — clone on the machine where the Hermes desktop app runs
- **Agent half** — for the gateway host (`hermes plugins enable env-setup` there; backend mounts on gateway restart)

Manual install on the gateway host:

```bash
git clone https://github.com/nickhechtel/hermes-env-setup ~/.hermes/plugins/env-setup
hermes plugins enable env-setup
```

For just the desktop UI on a remote-desktop setup, copy `desktop/plugin.js` to
`~/.hermes/desktop-plugins/env-setup/plugin.js` on the desktop machine.

## Install (dev)

```bash
ln -s ~/src/hermes-env-setup ~/.hermes/plugins/env-setup
hermes plugins enable env-setup
# Desktop app: Capabilities → Plugins → enable "Setup Assistant"
# (unified desktop halves ship opt-in; Rescan syncs the copy)
```

Restart the gateway (or start a new session) so the tools register.

## Dynamic catalog

`catalog()` merges `integrations.json` with the `requires_env` / `optional_env`
declarations of every installed plugin — plugins that declare credentials
appear on the Setups page automatically.

## License

MIT