# Protocol Notes

Current transport is newline-delimited JSON-RPC 2.0 over a Unix domain socket.

## Methods
- `session.start(workdir, profile)`
- `instruction.submit(text, metadata)`
- `instruction.cancel(instructionId)`
- `session.stop(sessionId)`

## Event Types
- `stdout`
- `tool_call`
- `file_change`
- `status`
- `error`
