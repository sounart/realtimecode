export type StreamEvent =
  | StdoutEvent
  | ToolCallEvent
  | FileChangeEvent
  | StatusEvent
  | ErrorEvent
  | TranscriptEvent;

export type StdoutEvent = {
  type: 'stdout';
  instructionId: string;
  chunk: string;
  timestamp: string;
};

export type ToolCallEvent = {
  type: 'tool_call';
  instructionId: string;
  toolName: string;
  args: Record<string, unknown>;
  timestamp: string;
};

export type FileChangeEvent = {
  type: 'file_change';
  instructionId: string;
  path: string;
  changeType: 'create' | 'update' | 'delete';
  timestamp: string;
};

export type StatusEvent = {
  type: 'status';
  sessionId: string;
  state: 'idle' | 'listening' | 'transcribing' | 'executing' | 'error';
  timestamp: string;
};

export type ErrorEvent = {
  type: 'error';
  message: string;
  code?: string;
  recoverable: boolean;
  timestamp: string;
};

export type TranscriptEvent = {
  type: 'transcript';
  text: string;
  isFinal: boolean;
  timestamp: string;
};
