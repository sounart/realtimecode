import type { SparkProfile, UtteranceMetadata } from './types.js';

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method:
    | 'session.start'
    | 'instruction.submit'
    | 'instruction.cancel'
    | 'session.stop';
  params: unknown;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

export type SessionStartRequest = {
  workdir: string;
  profile: SparkProfile;
};

export type SessionStartResponse = {
  sessionId: string;
  workdir: string;
  profile: SparkProfile;
  acceptedAt: string;
};

export type InstructionSubmitRequest = {
  text: string;
  metadata: UtteranceMetadata;
};

export type InstructionSubmitResponse = {
  instructionId: string;
  queued: boolean;
};

export type InstructionCancelRequest = {
  instructionId: string;
};

export type SessionStopRequest = {
  sessionId: string;
};
