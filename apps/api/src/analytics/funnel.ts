import type { AnalyticsEvent } from '../services/interfaces';

// Answers the brief's instrumentation question: "how would you know whether
// continuity improves checkout conversion?" Group events by session, then
// compare conversion for sessions that continued on another surface against
// sessions that stayed on the one they started on.

export interface FunnelSummary {
  sessions: number;
  completed: number;
  conversion: number | null; // completed / sessions
  crossSurface: { sessions: number; completed: number; conversion: number | null };
  singleSurface: { sessions: number; completed: number; conversion: number | null };
  priceBanner: { shown: number; acknowledged: number; ackRate: number | null };
  expired: number;
  failed: number;
  replayedRequests: number;
}

const rate = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 1000);

export function summarizeFunnel(events: AnalyticsEvent[]): FunnelSummary {
  const bySession = new Map<string, AnalyticsEvent[]>();
  for (const e of events) bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), e]);

  let sessions = 0, completed = 0, crossN = 0, crossDone = 0, singleN = 0, singleDone = 0;
  for (const evs of bySession.values()) {
    const started = evs.find((e) => e.name === 'checkout_started');
    if (!started) continue; // client events for unknown sessions don't count
    sessions++;
    const origin = started.props?.surface;
    const done = evs.some((e) => e.name === 'status_completed');
    const continuedElsewhere = evs.some((e) => e.name === 'surface_resumed' && e.props?.surface !== origin);
    if (done) completed++;
    if (continuedElsewhere) {
      crossN++;
      if (done) crossDone++;
    } else {
      singleN++;
      if (done) singleDone++;
    }
  }

  const count = (name: string) => events.filter((e) => e.name === name).length;
  const shown = count('price_banner_shown');
  const acknowledged = count('price_banner_acknowledged');
  return {
    sessions,
    completed,
    conversion: rate(completed, sessions),
    crossSurface: { sessions: crossN, completed: crossDone, conversion: rate(crossDone, crossN) },
    singleSurface: { sessions: singleN, completed: singleDone, conversion: rate(singleDone, singleN) },
    priceBanner: { shown, acknowledged, ackRate: rate(acknowledged, shown) },
    expired: count('status_expired'),
    failed: count('status_failed'),
    replayedRequests: count('checkout_replayed'),
  };
}
