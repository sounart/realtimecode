export type PolicyDecision = {
  allowed: boolean;
  reason?: string;
};

const destructiveHints = ['rm -rf', 'drop database', 'force push'];

export function evaluateInstruction(text: string): PolicyDecision {
  const lowered = text.toLowerCase();
  const matched = destructiveHints.find((hint) => lowered.includes(hint));

  if (matched) {
    return {
      allowed: false,
      reason: `Instruction requires confirmation because it matched: ${matched}`
    };
  }

  return { allowed: true };
}
