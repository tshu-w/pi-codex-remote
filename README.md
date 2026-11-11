# Codex Remote

Use Pi remotely through ChatGPT's Codex remote control.

## Usage

Install the plugin:

```sh
pi install git:github.com/tshu-w/pi-codex-remote
```

Run in a Pi terminal:

- `/codex-remote pair`: start the background daemon and show a pairing code
- `/codex-remote start`: start the daemon with the existing pairing
- `/codex-remote status`: show the daemon and connection state
- `/codex-remote stop`: stop the daemon

After `pair` or `start`, the daemon starts with the next Pi session whenever it is not running, and replaces itself when the plugin is updated. After `stop`, it stays stopped until the next `start` or `pair`.

Pairing requires a Codex login on the machine running Pi. State and logs default to `~/.local/state/pi/codex-remote/`.

## Limits

- Tasks and `!` commands use Pi's local permissions and extensions, without Codex sandboxing. Direct commands from Codex Remote run in the official Codex sandbox without network access.
- Codex Remote turns do not support Pi dialogs; confirmation, selection and input requests are cancelled unless a terminal is attached to the session's [pi-agents](https://github.com/tshu-w/pi-agents) host.
- With pi-agents, Codex Remote joins sessions running in its hosts, including turns started from the terminal. Otherwise, sessions open in another Pi are read-only until closed there.
- Without pi-agents, Pi exits once idle so a desktop Pi can open the session.
- Native subagent cards support [pi-agents](https://github.com/tshu-w/pi-agents). Subagent sessions are read-only; manage them from their parent session.
- Archiving and deleting move session files to the macOS Trash once no pi-agents host uses them. Unarchiving restores them; deleting also removes the thread from Codex Remote.

See [METHODS.md](METHODS.md) for supported interfaces.

## Development

`vendor/` holds the app-server schema for Codex Remote's Codex version. After upgrading the Codex CLI, regenerate the protocol definitions and `METHODS.md`, then run the tests.

```sh
node scripts/update-protocol.mjs
node scripts/methods-doc.mjs > METHODS.md
npm test
```

## License

[AGPL-3.0](LICENSE)
