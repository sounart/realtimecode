# RealtimeCode Architecture

## Goal

Choose a directory, hit record, speak, and watch Codex make changes in realtime.

## Architecture

```
┌─────────────────────────┐
│  macOS Menubar (Swift)  │  ← The entire UI
│  • Mic capture          │
│  • Hotkey toggle        │
│  • Directory picker     │
│  • Status display       │
└───────────┬─────────────┘
            │ Unix socket (JSON-RPC)
            v
┌─────────────────────────┐
│  Node.js Backend        │  ← Single process, 3 source files
│  • OpenAI Realtime API  │     (transcriber + codex + server)
│  • Codex exec runner    │
│  • Event relay          │
└─────────────────────────┘
```

## Backend (services/orchestrator)

Three source files under `services/orchestrator/src/`:

- **types.ts** — `JsonRpcRequest`, `JsonRpcResponse`, `SessionState` (idle | listening | executing)
- **transcriber.ts** — WebSocket to OpenAI Realtime API for streaming transcription with server VAD
- **codex.ts** — Spawns `codex exec` processes, parses JSONL output
- **server.ts** — Unix socket server, owns session state, wires transcriber → codex

### RPC Surface (3 methods)

| Method | Params | Description |
|--------|--------|-------------|
| `start` | `{ workdir }` | Connect transcriber, state → listening |
| `stop` | — | Kill codex, disconnect transcriber, state → idle |
| `audio` | `{ chunk }` | Notification, forward base64 audio to transcriber |

### Notifications (server → client)

| Method | Params | Description |
|--------|--------|-------------|
| `transcript` | `{ text, final }` | Partial/final speech |
| `codex` | `{ type, data }` | tool_call, file_change, output, done |
| `status` | `{ state }` | idle/listening/executing |
| `error` | `{ message }` | Any problem |

### Flow

1. Client sends `start { workdir }`
2. Server connects transcriber, state = listening
3. Client streams `audio` chunks from microphone
4. Transcriber sends partial transcripts → relayed to client
5. server_vad detects pause → final transcript → server runs codex
6. Codex events relayed to client, state = executing
7. Codex done → state = listening (auto-resumes)
8. New speech while executing → cancel current codex, run new instruction

## macOS Menubar App

Four Swift files:

- **MicCaptureService.swift** — PCM16, 24kHz, mono, base64 chunks via callback
- **HotkeyManager.swift** — Global hotkey toggle (CGEvent tap + NSEvent fallback)
- **OrchestratorClient.swift** — Unix socket JSON-RPC client, backend spawning
- **App.swift** — SwiftUI menubar app, state management, UI

## Repository Structure

```
realtimecode/
  ARCHITECTURE.md
  package.json
  tsconfig.base.json
  apps/
    menubar-macos/
      RealtimeCodeMenuBar/
        App.swift
        HotkeyManager.swift
        MicCaptureService.swift
        OrchestratorClient.swift
  services/
    orchestrator/
      package.json
      tsconfig.json
      src/
        types.ts
        transcriber.ts
        codex.ts
        server.ts
```
