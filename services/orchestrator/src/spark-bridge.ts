import type { InstructionSubmitRequest } from '@realtimecode/protocol';

export class SparkBridge {
  async submitInstruction(payload: InstructionSubmitRequest): Promise<{ instructionId: string }> {
    return {
      instructionId: `instruction-${payload.metadata.timestamp}`
    };
  }
}
