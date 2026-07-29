import { BotBuffer as BotBufferRedis } from './bot-buffer';
import { EventBuffer as EventBufferRedis } from './event-buffer';
import { ProfileBuffer as ProfileBufferRedis } from './profile-buffer';
import { ReplayBuffer } from './replay-buffer';
import { SessionBuffer } from './session-buffer';

export const eventBuffer = new EventBufferRedis();
export const profileBuffer = new ProfileBufferRedis();
export const botBuffer = new BotBufferRedis();
export const sessionBuffer = new SessionBuffer();
export const replayBuffer = new ReplayBuffer();

// Re-export flush observer types so the worker can bridge them into Prometheus.
export type {
  FlushObservation,
  FlushObserver,
  FlushPhaseTimings,
  FlushTrigger,
} from './base-buffer';
