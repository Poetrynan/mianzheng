export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Test/dev clock that can be advanced in jumps; reminders depend on wall-clock time. */
export class FixedClock implements Clock {
  private current: Date;
  constructor(start: Date | string) {
    this.current = new Date(start);
  }
  now(): Date {
    return new Date(this.current);
  }
  set(at: Date | string): void {
    this.current = new Date(at);
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  advanceHours(h: number): void {
    this.advanceMs(h * 3_600_000);
  }
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
