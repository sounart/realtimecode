# OpenAI Realtime API Reference (for RealtimeCode implementation)

Source: https://developers.openai.com/api/docs/guides/realtime/

## Connection

**WebSocket URL:**
```
wss://api.openai.com/v1/realtime?model=gpt-realtime
```

**Auth Header:**
```
Authorization: Bearer <OPENAI_API_KEY>
```

## Session Setup

After connecting, send `session.update` to configure:
```json
{
  "type": "session.update",
  "session": {
    "type": "transcription",
    "input_audio_format": "pcm16",
    "input_audio_transcription": {
      "model": "gpt-4o-transcribe"
    },
    "turn_detection": {
      "type": "server_vad",
      "threshold": 0.5,
      "prefix_padding_ms": 300,
      "silence_duration_ms": 650
    }
  }
}
```

**IMPORTANT**: We use `"type": "transcription"` mode (NOT "realtime") because we only need speech-to-text, not speech-to-speech. We don't want the model to talk back — we just want the transcript to send to Codex Spark.

## Audio Format — PCM16

- 16-bit signed little-endian PCM
- 24kHz sample rate (mono)
- Base64-encoded when sent over WebSocket

## Client Events

### session.update
Configure session parameters.

### input_audio_buffer.append
```json
{
  "type": "input_audio_buffer.append",
  "audio": "<base64-encoded-pcm16>"
}
```

### input_audio_buffer.commit
Force-commit the current audio buffer (for push-to-talk / hotkey release).
```json
{
  "type": "input_audio_buffer.commit"
}
```

### input_audio_buffer.clear
Clear buffered audio without committing.

## Server Events

### session.created
Confirms WebSocket session is ready.

### input_audio_buffer.speech_started
VAD detected speech start.

### input_audio_buffer.speech_stopped
VAD detected speech end (silence threshold crossed).

### conversation.item.input_audio_transcription.completed
Final transcript for a committed audio segment:
```json
{
  "type": "conversation.item.input_audio_transcription.completed",
  "transcript": "add a loading spinner to the main page"
}
```

### conversation.item.input_audio_transcription.delta
Partial/streaming transcript updates.

### error
Error events with message details.

## Turn Detection (Server VAD)

Server-side Voice Activity Detection handles utterance boundaries:
- `threshold` (0.0-1.0): Sensitivity. Lower = more sensitive. Default 0.5.
- `prefix_padding_ms`: Audio before speech detection to include. Default 300ms.
- `silence_duration_ms`: How long silence before auto-commit. Default 650ms. Our ARCHITECTURE.md specifies 650ms.

## Implementation Notes for RealtimeCode

1. **Transcription-only mode**: Use `"type": "transcription"` — we don't need audio output, just text transcripts.
2. **Audio capture**: Swift menu bar app captures mic → PCM16 24kHz mono → base64 → sends to Node orchestrator via IPC.
3. **Orchestrator streams to Realtime API**: WebSocket connection, forwards audio chunks as `input_audio_buffer.append`.
4. **Boundary detection**: Combine server VAD (`speech_stopped` events) with our hybrid detector (hotkey release = instant `input_audio_buffer.commit`, max 12s cap).
5. **Transcript → Codex Spark**: On `transcription.completed`, boundary detector commits the transcript text to Spark bridge.
6. **Cancellation**: If user starts speaking while Spark is executing, send cancel to Spark bridge before starting new turn.
