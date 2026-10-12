/** Power equipment kinds, as the server's EQUIPMENT_KINDS. */
export type Kind = 'power_bank' | 'power_station' | 'ups' | 'generator' | 'solar' | 'battery' | 'other';

/** A new device to open the form with: from the "what are you adding?" chooser, or moved over from the supplies form. */
export interface DeviceDraft { kind: Kind; name?: string; capacity_mah?: number | null; location?: string }

// First match wins: "Jackery Solar Generator" is a power station, not a generator or a panel.
const GUESSES: [RegExp, Kind][] = [
  [/power station|solar generator|ecoflow|jackery|bluetti|solix/i, 'power_station'],
  [/generator/i, 'generator'],
  [/\bups\b|battery backup|back-?ups|cyberpower|\bapc\b/i, 'ups'],
  [/solar/i, 'solar'],
  [/power ?bank|battery pack|portable charger|jump ?start|\d\s*mah\b/i, 'power_bank'],
  [/rechargeable|eneloop|18650|lifepo4|deep.?cycle/i, 'battery'],
];
/** A supplies-form name that sounds like a rechargeable device, as a device draft (else null). */
export function guessDevice(name: string, location = ''): DeviceDraft | null {
  const kind = GUESSES.find(([re]) => re.test(name))?.[1];
  if (!kind) return null;
  const mah = /(\d[\d,]*)\s*mah\b/i.exec(name);
  return { kind, name: name.trim(), location, capacity_mah: mah ? Number(mah[1].replace(/,/g, '')) : null };
}

