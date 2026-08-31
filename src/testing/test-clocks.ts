import type { Clock } from '../domain/clock.js';
import type { RandomSource } from '../domain/crypto.js';

let deterministicCounter = 0;
let deterministicUuidCounter = 0;

export function resetDeterministic(): void {
  deterministicCounter = 0;
  deterministicUuidCounter = 0;
}

export function deterministicBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = (deterministicCounter++ & 0xff) ^ 0x5a;
  }
  return bytes;
}

export function deterministicUuid(): string {
  deterministicUuidCounter++;
  return `00000000-0000-4000-8000-${deterministicUuidCounter.toString(16).padStart(12, '0')}`;
}

export const deterministicRandom: RandomSource = {
  bytes: deterministicBytes,
  uuid: deterministicUuid,
};

export interface TestClock {
  readonly clock: Clock;
  set(at: Date | number): void;
  advance(ms: number): void;
}

export function makeTestClock(initial: Date | number = 0): TestClock {
  let now =
    typeof initial === 'number'
      ? new Date(initial)
      : new Date(initial.getTime());
  const clock: Clock = {
    now(): Date {
      return new Date(now.getTime());
    },
  };
  return {
    clock,
    set(at: Date | number): void {
      now = typeof at === 'number' ? new Date(at) : new Date(at.getTime());
    },
    advance(ms: number): void {
      now = new Date(now.getTime() + ms);
    },
  };
}