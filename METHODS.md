# Codex app-server methods

Generated from the Codex 0.160.0 schema and `src/methods.mjs`. 47 implemented, 10 empty, 110 unimplemented. Full definitions and experimental markers are in [vendor/](vendor/).
Empty methods return no resources; unimplemented requests return -32601. Wildcards cover methods not already listed above them.

## Sessions and history

| Methods | Status | Limits and behavior |
| --- | --- | --- |
| `thread/start`, `thread/unsubscribe` | implemented |  |
| `thread/resume` | implemented | Sessions open in another Pi are read-only |
| `thread/fork` | implemented | Whole thread, through a turn, or before a turn |
| `thread/archive`, `thread/unarchive`, `thread/delete` | implemented | Moves the session file to the macOS Trash; Restores the session file from the Trash; Moves the session file to the macOS Trash and removes the thread from Remote |
| `thread/name/set` | implemented |  |
| `thread/list`, `thread/loaded/list`, `thread/read`, `thread/turns/list`, `thread/items/list` | implemented |  |
| `thread/search` | implemented | Session names and message text on the active branch |
| `thread/searchOccurrences` | implemented | Visible user messages and final assistant messages, with UTF-16 match ranges and turn cursors |
| `thread/timeline/list` | implemented | Ordinary history only; newest page first, chronological order within each page |
| `thread/metadata/update`, `fuzzyFileSearch`, `fuzzyFileSearch/*` | unimplemented |  |

## Conversation, queues and organization

| Methods | Status | Limits and behavior |
| --- | --- | --- |
| `turn/start`, `turn/steer`, `turn/interrupt` | implemented |  |
| `thread/settings/update` | implemented | Model and thinking level only |
| `thread/compact/start`, `thread/revert` | implemented | Keeps the abandoned branch in the Pi session file |
| `thread/queue/*` | implemented | Loaded Remote-owned threads automatically consume queued input; interrupt pauses consumption; Durable pending submissions; text and base64 data URL images only; Loaded Remote-owned threads only; resumes a paused queue. Uncertain dispatches are not retried: inspect history before deleting and resubmitting the entry |
| `thread/goal/get`, `threadSection/list`, `collaborationMode/list` | empty |  |
| `thread/goal/*`, `threadSection/*`, `thread/section/move`, `project/*` | unimplemented |  |
| `thread/realtime/*` | unimplemented |  |
| `turn/settings/update`, `review/start`, `thread/inject_items` | unimplemented |  |
| `thread/increment_elicitation`, `thread/decrement_elicitation`, `thread/approveGuardianDeniedAction` | unimplemented |  |

## Commands and files

| Methods | Status | Limits and behavior |
| --- | --- | --- |
| `thread/shellCommand` | implemented | Pi `!` command: runs Pi user_bash hooks without a sandbox and adds the output to the session context |
| `command/exec`, `command/exec/write`, `command/exec/terminate` | implemented | Official Codex Seatbelt sandbox via `codex sandbox`; readOnly or workspaceWrite only, no network, no PTY |
| `thread/backgroundTerminals/list` | empty | Pi has no background terminal registry |
| `thread/backgroundTerminals/*`, `command/exec/resize`, `process/*` | unimplemented |  |
| `fs/watch`, `fs/unwatch` | unimplemented |  |
| `fs/*` | implemented | Private attachment cache, not the host filesystem |
| `thread/attachment/*` | unimplemented |  |

## Models, configuration and extensions

| Methods | Status | Limits and behavior |
| --- | --- | --- |
| `model/list` | implemented | All Pi models with their supported thinking levels |
| `modelProvider/capabilities/read` | implemented | Codex provider capability flags are false; this does not restrict Pi tools |
| `permissionProfile/list`, `configRequirements/read` | implemented | Only :danger-full-access; Pi permission hooks still apply; Only Pi execution without a Codex sandbox |
| `config/read` | implemented | Current Pi model and thinking level; no Codex config layers |
| `skills/list` | implemented | Pi skills, read-only |
| `experimentalFeature/list`, `hooks/list`, `plugin/list`, `plugin/installed`, `app/list`, `mcpServerStatus/list` | empty |  |
| `config/*`, `experimentalFeature/*`, `windowsSandbox/*` | unimplemented |  |
| `skills/*`, `plugin/*`, `app/*`, `marketplace/*`, `mcpServer/*` | unimplemented |  |

## Connection, accounts and other requests

| Methods | Status | Limits and behavior |
| --- | --- | --- |
| `initialize` | implemented |  |
| `account/read` | implemented | Returns no account information; Pi manages model authentication |
| `remoteControl/*`, `account/*`, `userVerification/*` | unimplemented |  |
| `thread/memoryMode/set`, `memory/*`, `rollout/*` | unimplemented |  |
| `environment/*`, `externalAgentConfig/*` | unimplemented |  |
| `server/diagnostics`, `feedback/upload`, `mock/*` | unimplemented |  |
