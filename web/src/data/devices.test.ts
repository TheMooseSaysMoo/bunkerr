import { describe, expect, it } from 'vitest';
import { guessDevice } from './devices';

describe('guessDevice', () => {
  it('spots rechargeable devices typed into the supplies form', () => {
    expect(guessDevice('Anker 10,000mAh Battery Pack 1', 'Desk Drawer Left')).toEqual({ kind: 'power_bank', name: 'Anker 10,000mAh Battery Pack 1', location: 'Desk Drawer Left', capacity_mah: 10000 });
    expect(guessDevice('Champion 3500W generator')?.kind).toBe('generator');
    expect(guessDevice('Jackery Solar Generator 1000')?.kind).toBe('power_station');
    expect(guessDevice('APC Back-UPS 600')?.kind).toBe('ups');
    expect(guessDevice('Eneloop AA 8 pack')?.kind).toBe('battery');
  });
  it('leaves disposable batteries and fuel alone', () => {
    for (const n of ['AA batteries, 24 pack', 'CR123A batteries, 6 pack', 'Propane tank, 20 lb', 'Gasoline, 5 gal can', 'Candles', 'Apple sauce']) expect(guessDevice(n)).toBeNull();
  });
});
