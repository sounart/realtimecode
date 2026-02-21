# RealtimeCode Architecture

## 1. Goal
RealtimeCode is a macOS desktop + terminal hybrid system that lets a developer:
1. launch from terminal,
2. select a working directory,
3. start Codex Spark in that directory,
4. capture voice instructions in real time,
5. stream those instructions to Codex Spark,
6. receive live code edits with visible status from a menu bar app and hotkey toggle.

The architecture prioritizes low latency, interruption control, and safe execution in a chosen repo.

## 2. Top-Level Architecture

```text
+---------------------+        +---------------------------+
| Terminal Launcher   |        | Menu Bar App (macOS)      |
| (CLI)               |        | - Mic state               |
| - choose directory  |        | - Push-to-talk / toggle   |
| - spawn Spark bridge|<------>| - Status + errors         |
+----------+----------+  IPC   +-------------+-------------+
           |                                  |
           |                                  |
           v                                  v
+-----------------------------------------------------------+
| Session Orchestrator (local daemon)                       |
| - session lifecycle                                       |
| - audio buffering + utterance detection                   |
| - transcript assembly                                     |
| - command queue + cancellation                            |
| - policy/safety checks                                    |
+----------------------+----------------------+-------------+
                       |                      |
             audio/text|                      | tool protocol
                       v                      v
       +---------------------------+   +--------------------------+
       | Speech Pipeline           |   | Codex Spark Bridge       |
       | (OpenAI Realtime API)     |   | - maintain Spark session |
       | - partial transcripts     |   | - send instruction turns |
       | - final transcript chunks |   | - stream tool output     |
       +---------------------------+   +-------------+------------+
                                                     |
                                                     v
                                         +-------------------------+
                                         | Workspace Filesystem    |
                                         | + git-aware operations  |
                                         +-------------------------+
```

## 3. Core Decisions

## 3.1 Voice Input Pipeline
**Decision:** Use OpenAI Realtime API as primary speech path for MVP.

**Why this over Whisper-local / batch STT:**
- Lowest end-to-end latency for interactive coding loops.
- Built-in streaming partials improve responsiveness.
- Simpler architecture: one streaming path instead of separate capture + batch transcription worker.
- Better interruption support (cancel and replace active turn).

**Fallback path (non-MVP):** Optional local Whisper model for offline mode and privacy-constrained environments.

## 3.2 Utterance Boundary Detection
**Decision:** Hybrid boundary strategy (semantic + acoustic + explicit hotkey).

Signals used:
1. **VAD pause threshold:** End utterance when silence > `650ms` (tunable).
2. **Minimum speech duration:** Ignore clips shorter than `250ms` to reduce false triggers.
3. **Semantic completion cues:** If transcript ends with command-like closure (e.g., "run tests", "apply that"), reduce waiting window.
4. **Hard boundary from hotkey:** Push-to-talk release or toggle-off commits immediately.
5. **Max utterance cap:** Force commit at `12s` to avoid long, ambiguous turns.

This hybrid model balances responsiveness against fragmented prompts.

## 3.3 Codex Spark Integration Protocol
**Decision:** Keep a persistent Spark session per working directory and send one instruction per committed utterance.

Protocol model:
1. `session.start(workdir, profile)`
2. `instruction.submit(text, metadata)`
3. stream events: `stdout`, `tool_call`, `file_change`, `status`, `error`
4. optional `instruction.cancel(active_instruction_id)` on interruption
5. `session.stop()`

Metadata attached to each utterance:
- timestamp
- confidence score
- boundary reason (`silence`, `hotkey_release`, `max_duration`, etc.)
- active file context (if available)

## 3.4 Tech Stack
**MVP stack (recommended):**
- **Core language:** TypeScript (Node.js 22+)
- **CLI:** `commander` + `inquirer` (or built-in prompts)
- **Local IPC:** Unix domain socket + JSON-RPC
- **Audio capture + hotkey + menu bar:** Swift/SwiftUI macOS menu bar app
- **Daemon/orchestrator:** Node service for session and pipeline management
- **Realtime API client:** WebSocket client in Node
- **State/logging:** SQLite for session history + structured logs (pino)

Rationale:
- TypeScript for faster iteration and shared types between CLI and daemon.
- Swift is the most reliable path for native macOS microphone permissions, menu bar UX, and global hotkeys.
- JSON-RPC keeps app/daemon boundary explicit and testable.

## 4. Detailed Data Flow
1. User runs `realtimecode` in terminal.
2. CLI prompts for directory and validates git/workspace status.
3. CLI starts/reuses local orchestrator daemon and initializes Spark session for chosen directory.
4. Menu bar app starts listener (or connects to existing daemon session).
5. Audio frames stream from menu bar app to orchestrator.
6. Orchestrator forwards audio stream to Realtime API and receives partial/final transcript events.
7. Boundary detector commits transcript to an instruction turn.
8. Spark bridge sends committed turn to Codex Spark.
9. Spark executes tools and edits files; streamed status/events are returned to orchestrator.
10. Orchestrator pushes state updates to both CLI and menu bar indicator.
11. User can interrupt via hotkey; orchestrator cancels active instruction and starts a new turn.

## 5. Component Responsibilities
- **CLI Launcher**
  - Session bootstrap, directory selection, startup diagnostics.
  - Shows textual event stream and manual controls.
- **Menu Bar App**
  - Mic control, hotkey, recording indicator, permission handling.
- **Session Orchestrator**
  - State machine for idle/listening/transcribing/executing/error.
  - Boundary detection and queueing policy.
- **Speech Pipeline Client**
  - Streaming transport, transcript confidence handling.
- **Spark Bridge**
  - Transport adapter to Codex Spark SDK/protocol.
  - Handles cancellation and incremental outputs.

## 6. Proposed Repository Structure
```text
realtimecode/
  ARCHITECTURE.md
  README.md
  apps/
    cli/
      src/
        index.ts
        commands/start.ts
    menubar-macos/
      RealtimeCodeMenuBar/
        App.swift
        HotkeyManager.swift
        MicCaptureService.swift
  services/
    orchestrator/
      src/
        server.ts
        session-manager.ts
        boundary-detector.ts
        transcript-assembler.ts
        spark-bridge.ts
        realtime-client.ts
        policy-engine.ts
  packages/
    protocol/
      src/
        rpc.ts
        events.ts
        types.ts
    shared/
      src/
        config.ts
        logger.ts
  docs/
    mvp-checklist.md
    protocol.md
```

## 7. MVP Scope
In scope:
- macOS-only menu bar app with mic toggle hotkey.
- CLI startup flow for selecting a local directory.
- Single active Spark session bound to that directory.
- Streaming speech-to-text through OpenAI Realtime API.
- Hybrid utterance boundary detection with configurable thresholds.
- Instruction cancellation and restart.
- Basic safety guardrails: directory confinement, command timeout defaults, confirmation for destructive ops.

Out of scope (post-MVP):
- Multi-repo simultaneous sessions.
- Full offline/local STT.
- Multi-user collaboration.
- Advanced semantic intent rewriting before Spark submission.
- Cross-platform desktop support.

## 8. Risks and Mitigations
- **Latency spikes from network variability**
  - Mitigation: adaptive boundary timeout + transcript fallback UI + retry logic.
- **False utterance boundaries**
  - Mitigation: configurable thresholds, hotkey hard commit, quick "append correction" command.
- **Accidental destructive code actions**
  - Mitigation: policy engine requiring confirmation phrases for high-risk operations.
- **Permission friction on macOS mic/hotkey**
  - Mitigation: first-run permission wizard and explicit status diagnostics.

## 9. Implementation Sequence
1. Define JSON-RPC protocol and event schema.
2. Build CLI bootstrap + daemon lifecycle.
3. Implement Spark bridge with mocked voice input.
4. Add Realtime streaming transcription.
5. Add boundary detector tuning + cancel flow.
6. Add menu bar app with hotkey and status sync.
7. Harden safety checks and add session logs.
