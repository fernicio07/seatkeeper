import { summarizeFunnel } from './funnel';
import type { AnalyticsEvent } from '../services/interfaces';

const ev = (name: string, sessionId: string, props?: Record<string, unknown>): AnalyticsEvent => ({ name, sessionId, at: 0, props });

describe('summarizeFunnel', () => {
  it('splits conversion by whether the session continued on another surface', () => {
    const events = [
      // A: started web, resumed on mobile, completed → cross-surface, converted
      ev('checkout_started', 'A', { surface: 'web' }),
      ev('surface_resumed', 'A', { surface: 'web' }),
      ev('surface_resumed', 'A', { surface: 'mobile' }),
      ev('status_completed', 'A'),
      // B: web only, expired → single-surface, not converted
      ev('checkout_started', 'B', { surface: 'web' }),
      ev('surface_resumed', 'B', { surface: 'web' }),
      ev('status_expired', 'B'),
      // C: web only, completed
      ev('checkout_started', 'C', { surface: 'web' }),
      ev('status_completed', 'C'),
    ];
    expect(summarizeFunnel(events)).toMatchObject({
      sessions: 3,
      completed: 2,
      crossSurface: { sessions: 1, completed: 1, conversion: 1 },
      singleSurface: { sessions: 2, completed: 1, conversion: 0.5 },
      expired: 1,
    });
  });

  it('reports banner acknowledgment rate and replays; empty input yields null rates', () => {
    const s = summarizeFunnel([
      ev('checkout_started', 'A', { surface: 'mobile' }),
      ev('price_banner_shown', 'A'),
      ev('price_banner_shown', 'A'),
      ev('price_banner_acknowledged', 'A'),
      ev('checkout_replayed', 'A'),
    ]);
    expect(s.priceBanner).toEqual({ shown: 2, acknowledged: 1, ackRate: 0.5 });
    expect(s.replayedRequests).toBe(1);
    expect(summarizeFunnel([]).conversion).toBeNull();
  });
});
