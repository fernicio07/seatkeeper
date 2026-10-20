import { StubClock, StubInventoryService } from './stubs';

describe('StubInventoryService hold lifecycle', () => {
  const setup = () => {
    const clock = new StubClock(1_000);
    return { clock, inv: new StubInventoryService(clock) };
  };

  it('hold → expires at expiresAt unless frozen', async () => {
    const { clock, inv } = setup();
    const h = (await inv.hold('lst_heat_1', 2_000))!;
    expect(await inv.isHoldValid(h)).toBe(true);
    clock.set(2_000);
    expect(await inv.isHoldValid(h)).toBe(false);
  });

  it('freeze → valid past expiresAt; release → seat available', async () => {
    const { clock, inv } = setup();
    const h = (await inv.hold('lst_heat_1', 2_000))!;
    await inv.freeze(h);
    clock.set(9_000);
    expect(await inv.isHoldValid(h)).toBe(true);
    await inv.release(h);
    expect(await inv.isAvailable('lst_heat_1')).toBe(true);
  });

  it('confirm → sold; a later release cannot un-sell it', async () => {
    const { inv } = setup();
    const h = (await inv.hold('lst_heat_1', 2_000))!;
    await inv.confirm(h);
    await inv.release(h);
    expect(await inv.isAvailable('lst_heat_1')).toBe(false);
  });

  it('a released hold cannot be frozen or confirmed back to life', async () => {
    const { inv } = setup();
    const h = (await inv.hold('lst_heat_1', 2_000))!;
    await inv.release(h);
    await inv.freeze(h);
    await inv.confirm(h);
    expect(await inv.isHoldValid(h)).toBe(false);
    expect(await inv.isAvailable('lst_heat_1')).toBe(true);
  });

  it('reset() clears holds and restores seed prices', async () => {
    const { inv } = setup();
    await inv.hold('lst_heat_1', 2_000);
    inv.setPrice('lst_heat_1', 1);
    inv.reset();
    expect(await inv.isAvailable('lst_heat_1')).toBe(true);
    expect((await inv.getListing('lst_heat_1'))!.price).toBe(18500);
  });
});
