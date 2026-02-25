# Protocol Notes

Current transport is newline-delimited JSON-RPC 2.0 over a Unix domain socket.

## Methods
- `auth` with `{ token }`
- `start` with `{ workdir }`
- `audio` with `{ chunk }`
- `stop` with `{}`

## Event Types
- `transcript`
- `codex` (`tool_call`, `file_change`, `done`)
- `status`
- `error`

Codex textual output is streamed to the orchestrator process stdout (for terminal visibility) instead of being sent over socket events.
