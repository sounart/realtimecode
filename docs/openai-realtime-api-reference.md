# OpenAI Realtime API Reference (RealtimeCode)

Primary sources:
- https://platform.openai.com/docs/guides/realtime-transcription
- https://platform.openai.com/docs/guides/realtime
- https://platform.openai.com/docs/guides/realtime-websocket
- https://platform.openai.com/docs/guides/realtime-model-capabilities
- https://platform.openai.com/docs/deprecations

## GA vs Beta

- Realtime should run on the GA interface.
- The Realtime beta interface is scheduled for shutdown on **February 27, 2026**.
- Do not send `OpenAI-Beta: realtime=v1` on new integrations.

## WebSocket Connection

Use a model-qualified Realtime URL with a realtime session model:

```text
wss://api.openai.com/v1/realtime?model=<realtime_session_model>
```

Example:

```text
wss://api.openai.com/v1/realtime?model=gpt-realtime
```

Auth header:

```text
Authorization: Bearer <OPENAI_API_KEY>
```

## Session Setup (Transcription Mode)

After the socket opens, send `session.update`:

```json
{
  "type": "session.update",
  "session": {
    "type": "realtime",
    "audio": {
      "input": {
        "format": { "type": "audio/pcm", "rate": 24000 },
        "transcription": {
          "model": "gpt-4o-transcribe",
          "language": "en"
        },
        "turn_detection": {
          "type": "server_vad",
          "threshold": 0.5,
          "prefix_padding_ms": 300,
          "silence_duration_ms": 800,
          "create_response": false,
          "interrupt_response": false
        },
        "noise_reduction": { "type": "near_field" }
      }
    }
  }
}
```

Notes:
- Configure `audio.input.transcription` for speech-to-text behavior.
- For this app's WebSocket flow, use `session.type = "realtime"` in `session.update`.
- Keep the WebSocket URL model as a realtime model (for example `gpt-realtime`), and set the speech model in `audio.input.transcription.model`.
- Setting `transcription.language` can improve latency/accuracy when known.
- If you receive `Model \"...\" is not supported in realtime mode`, the URL model is likely set to a non-realtime model.

## Audio Format

- PCM16 signed little-endian
- 24kHz mono
- Base64-encoded in `input_audio_buffer.append`

## Core Client Events

- `session.update`
- `input_audio_buffer.append`

## Core Server Events (Transcription)

- `session.created` / `session.updated`
- `input_audio_buffer.speech_started`
- `input_audio_buffer.speech_stopped`
- `input_audio_buffer.committed`
- `conversation.item.input_audio_transcription.delta`
- `conversation.item.input_audio_transcription.completed`
- `conversation.item.input_audio_transcription.failed`
- `error`

## Model Performance Notes

- `gpt-4o-mini-transcribe` is available as a lower-latency/cost option.
- `gpt-4o-transcribe` is the higher-accuracy default for this app.
