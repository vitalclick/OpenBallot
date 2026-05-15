// Realtime bridge: Redis pub/sub -> in-process listener pool.
//
// In production each Next.js server process holds ONE Redis subscriber
// connection. Each open SSE request registers a listener; when an
// event lands on the Redis channel, the subscriber fans it out to
// every registered listener.
//
// The Redis connection is established lazily on the first subscribe()
// and re-used. We never tear it down - it survives until the process
// exits.

import Redis from 'ioredis';

import type { VerificationStatus } from './types';

export type RedisEvent =
  | {
      type: 'verified_result';
      election_id: string;
      pu_code: string;
      status: VerificationStatus;
    }
  | {
      type: 'submission.extracted';
      election_id: string;
      submission_id: string;
      pu_code: string;
      confidence: number;
      anomaly_count: number;
    }
  | {
      type: 'submission.failed';
      election_id: string;
      submission_id: string;
      pu_code: string;
      error: string;
    };

const CHANNELS = {
  SUBMISSION: 'openballot:events:submission',
  VERIFICATION: 'openballot:events:verification',
  ANOMALY: 'openballot:events:anomaly',
} as const;

let subscriber: Redis | null = null;
const listeners: Set<(evt: RedisEvent) => void> = new Set();

function bootstrap(): void {
  if (subscriber) return;
  const url = process.env.REDIS_URL || 'redis://localhost:6379/0';
  subscriber = new Redis(url, {
    maxRetriesPerRequest: null,    // pub/sub clients reconnect indefinitely
    enableReadyCheck: true,
  });
  subscriber.subscribe(...Object.values(CHANNELS));
  subscriber.on('message', (channel: string, msg: string) => {
    let parsed: RedisEvent;
    try {
      parsed = JSON.parse(msg) as RedisEvent;
    } catch {
      return;
    }
    for (const l of listeners) {
      try {
        l(parsed);
      } catch {/* listener bug must never break the subscriber */}
    }
  });
  subscriber.on('error', (e) => {
    // ioredis automatically reconnects; we just log here so operators
    // can spot persistent Redis trouble.
    // eslint-disable-next-line no-console
    console.warn('[realtime] redis subscriber error:', e.message);
  });
}

export function subscribeToEvents(listener: (evt: RedisEvent) => void): () => void {
  bootstrap();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
