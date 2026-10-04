# Codex Remote

Use Pi remotely through ChatGPT's Codex remote control.

## Usage

Install the plugin:

```sh
pi install git:github.com/tshu-w/pi-codex-remote
```

Run in a Pi terminal:

- `/codex-remote pair`: start the background daemon and show the full pairing QR code, manual code and expiry above the editor
- `/codex-remote start`: start the daemon with the existing pairing
- `/codex-remote status`: show the daemon and connection state
- `/codex-remote stop`: stop the daemon

Pairing requires a Codex login on the machine running Pi. State and logs default to `~/.local/state/pi/codex-remote/`.

## Limits

- Tasks and `!` commands use Pi's local permissions and extensions, without Codex sandboxing. Direct commands from the app run in the official Codex sandbox without network access.
- Remote turns do not support Pi dialogs; confirmation, selection and input requests are cancelled.
- Sessions open in another Pi are read-only. Once closed there, sending a task takes the session over.
- Native subagent cards support [pi-agents](https://github.com/tshu-w/pi-agents). Subagent sessions are read-only; manage them from their parent session.
- Archiving and deleting move session files to the macOS Trash. Unarchiving restores them; deleting also removes the thread from Remote.

See [METHODS.md](METHODS.md) for supported interfaces.

## Protocol updates

`vendor/` holds the app-server schema for Remote's Codex version. After upgrading the Codex CLI, regenerate the protocol definitions and `METHODS.md`, then run the tests.

```sh
node scripts/update-protocol.mjs
node scripts/methods-doc.mjs > METHODS.md
npm test
```

Tests fail when any response or notification violates the schema.
