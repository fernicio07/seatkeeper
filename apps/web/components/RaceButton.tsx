'use client';

/**
 * Dev-only demo lever. Presses "Place order" in both iframes in the same tick,
 * so both requests land inside the race window. (Done by hand, the second
 * surface re-validates when you click into it and simply converges to the
 * same order — re-validation is the first line of defense; this exercises the
 * second one, idempotent replay.) Same-origin iframes, so DOM access is allowed.
 */
export function RaceButton() {
  const race = () => {
    const buttons = [...document.querySelectorAll('iframe')]
      .map((f) => f.contentDocument)
      .map((d) => [...(d?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.includes('Place order')));
    if (buttons.some((b) => !b)) {
      alert('Both surfaces must show "Place order" (PENDING_PAYMENT) first.');
      return;
    }
    buttons.forEach((b) => b!.click());
  };
  return (
    <button type="button" className="secondary race" onClick={race}>
      ⚡ Race both surfaces: press Place order on web and mobile at once
    </button>
  );
}
