# Protocol Notes

Current transport is newline-delimited JSON-RPC 2.0 over a Unix domain socket.

## Methods
- `auth` with `{ token }`
- `start` with `{ workdir }`
- `audio` with `{ chunk }`
- `stop` with `{}`

## Event Types
- `transcript`
- `codex` (`tool_call`, `file_change`, `output`, `done`)
- `status`
- `error`
