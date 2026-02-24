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

Use a model-qualified Realtime URL:

```text
wss://api.openai.com/v1/realtime?model=<realtime_or_transcription_model>
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
    "type": "transcription",
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
          "silence_duration_ms": 800
        },
        "noise_reduction": { "type": "near_field" }
      }
    }
  }
}
```

Notes:
- Keep mode as `transcription` for speech-to-text-only behavior.
- Setting `transcription.language` can improve latency/accuracy when known.

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
- `gpt-4o-transcribe` is the higher-accuracy default.

