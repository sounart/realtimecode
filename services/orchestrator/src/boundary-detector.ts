import type { BoundaryReason } from '@realtimecode/protocol';

export type BoundaryInput = {
  silenceMs: number;
  clipMs: number;
  hasHotkeyRelease: boolean;
  utteranceMs: number;
};

export function detectBoundary(input: BoundaryInput): BoundaryReason | null {
  if (input.hasHotkeyRelease) {
    return 'hotkey_release';
  }

  if (input.utteranceMs >= 12_000) {
    return 'max_duration';
  }

  if (input.clipMs >= 250 && input.silenceMs >= 650) {
    return 'silence';
  }

  return null;
}
