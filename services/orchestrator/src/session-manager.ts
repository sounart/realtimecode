export type SessionState = 'idle' | 'active' | 'stopped';

export class SessionManager {
  private activeSessionId: string | null = null;

  get state(): SessionState {
    if (this.activeSessionId === null) {
      return 'idle';
    }

    return this.activeSessionId === 'stopped' ? 'stopped' : 'active';
  }

  start(): string {
    this.activeSessionId = `session-${Date.now()}`;
    return this.activeSessionId;
  }

  stop(): void {
    this.activeSessionId = 'stopped';
  }
}
