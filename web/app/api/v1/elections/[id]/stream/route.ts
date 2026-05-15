import { NextRequest } from 'next/server';

import { isMockMode, mockPollingUnits } from '@/lib/mock-data';
import { subscribeToEvents, type RedisEvent } from '@/lib/realtime';
import type { VerificationStatus } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Server-Sent Events stream of platform updates.
//
// In production, this subscribes to two Redis pub/sub channels:
//   openballot:events:submission   - per-submission lifecycle changes
//   openballot:events:verification - per-PU consensus updates
//
// and re-broadcasts to all connected browsers / embedders as SSE events.
// One Redis subscription per request would be wasteful; we use a single
// process-level subscriber that fans out to in-process listeners.
//
// In mock mode (no NEXT_PUBLIC_SUPABASE_URL configured) we fall back to
// the synthetic random-update generator so a fresh clone has a visibly
// moving map during demos.

interface Params { params: { id: string } }

export async function GET(_req: NextRequest, { params }: Params) {
  const encoder = new TextEncoder();
  const electionId = params.id;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`: stream open for ${electionId}\n\n`));

      const sendEvent = (name: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {/* client closed */}
      };

      let teardown: (() => void) | null = null;

      if (isMockMode()) {
        teardown = startMockStream(encoder, sendEvent);
      } else {
        teardown = subscribeToEvents((evt: RedisEvent) => {
          if (evt.election_id && evt.election_id !== electionId) return;
          if (evt.type === 'verified_result') {
            sendEvent('verified_result', { pu_code: evt.pu_code, status: evt.status });
          } else if (evt.type === 'submission.extracted') {
            sendEvent('submission_extracted', {
              submission_id: evt.submission_id,
              pu_code: evt.pu_code,
              confidence: evt.confidence,
              anomaly_count: evt.anomaly_count,
            });
          } else if (evt.type === 'submission.failed') {
            sendEvent('submission_failed', {
              submission_id: evt.submission_id,
              pu_code: evt.pu_code,
              error: evt.error,
            });
          }
        });
      }

      const heartbeat = setInterval(
        () => sendEvent('heartbeat', { ts: Date.now() }),
        15_000
      );

      const close = () => {
        clearInterval(heartbeat);
        teardown?.();
      };
      return close;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function startMockStream(
  encoder: TextEncoder,
  sendEvent: (name: string, data: unknown) => void
): () => void {
  const id = setInterval(() => {
    const units = mockPollingUnits();
    const u = units[Math.floor(Math.random() * units.length)];
    const statuses: VerificationStatus[] = [
      'consensus',
      'inec_confirmed',
      'discrepancy',
      'inec_conflict',
    ];
    const next = statuses[Math.floor(Math.random() * statuses.length)];
    sendEvent('verified_result', { pu_code: u.pu_code, status: next });
  }, 4_000);
  return () => clearInterval(id);
}
