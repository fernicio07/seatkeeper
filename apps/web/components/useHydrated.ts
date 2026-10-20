'use client';

import { useEffect, useState } from 'react';

export interface HydrationInfo {
  /** ms from document navigation start to hydration — only on a full page load. */
  ms: number | null;
}

/**
 * null during SSR and the hydration render, set after. Effects never run on
 * the server, so this is the earliest honest "JS is live" signal.
 *
 * performance.now() counts from the *document* load. After a client-side
 * navigation (Link, or a Server Action redirect) that origin belongs to an
 * earlier page, so we only report a timing when this page IS the document.
 */
export function useHydrated(): HydrationInfo | null {
  const [info, setInfo] = useState<HydrationInfo | null>(null);
  useEffect(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const isDocumentLoad = nav?.name === window.location.href;
    setInfo({ ms: isDocumentLoad ? Math.round(performance.now()) : null });
  }, []);
  return info;
}
