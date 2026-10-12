// Common cartridges with spelling aliases, so "5.56", "5.56 NATO" and "5.56x45" all match.
// `alsoFires` is the well-known ONE-WAY chamber compatibility (a .357 Magnum revolver fires
// .38 Special; a 5.56 NATO chamber fires .223 Rem). It's a convenience for counting rounds —
// the barrel marking and the manufacturer's manual are the authority.
export interface Caliber { key: string; label: string; aliases: string[]; alsoFires?: string[]; kind: 'pistol' | 'rifle' | 'rimfire' | 'shotgun' }

export const CALIBERS: Caliber[] = [
  { key: '22lr', label: '.22 LR', aliases: ['22', '22 lr', '22 long rifle', '.22'], kind: 'rimfire' },
  { key: '22wmr', label: '.22 WMR', aliases: ['22 mag', '22 magnum', '22 wmr'], kind: 'rimfire' },
  { key: '17hmr', label: '.17 HMR', aliases: ['17 hmr'], kind: 'rimfire' },
  { key: '380acp', label: '.380 ACP', aliases: ['380', '380 auto', '9mm kurz', '9x17'], kind: 'pistol' },
  { key: '9mm', label: '9mm Luger', aliases: ['9mm', '9x19', '9mm luger', '9mm parabellum', '9mm para', '9 mm'], kind: 'pistol' },
  { key: '38spl', label: '.38 Special', aliases: ['38', '38 special', '38 spl', '38 sp'], kind: 'pistol' },
  { key: '357mag', label: '.357 Magnum', aliases: ['357', '357 mag', '357 magnum'], alsoFires: ['38spl'], kind: 'pistol' },
  { key: '357sig', label: '.357 SIG', aliases: ['357 sig'], kind: 'pistol' },
  { key: '40sw', label: '.40 S&W', aliases: ['40', '40 s&w', '40 sw', '40 cal'], kind: 'pistol' },
  { key: '10mm', label: '10mm Auto', aliases: ['10mm', '10 mm', '10mm auto'], kind: 'pistol' },
  { key: '45acp', label: '.45 ACP', aliases: ['45', '45 acp', '45 auto'], kind: 'pistol' },
  { key: '44spl', label: '.44 Special', aliases: ['44 special', '44 spl'], kind: 'pistol' },
  { key: '44mag', label: '.44 Magnum', aliases: ['44 mag', '44 magnum', '44 rem mag'], alsoFires: ['44spl'], kind: 'pistol' },
  { key: '57x28', label: '5.7x28mm', aliases: ['5.7', '5.7x28', '5.7x28mm'], kind: 'pistol' },
  { key: '223rem', label: '.223 Remington', aliases: ['223', '223 rem', '223 remington'], kind: 'rifle' },
  { key: '556nato', label: '5.56x45 NATO', aliases: ['5.56', '556', '5.56 nato', '5.56x45', '5.56x45mm'], alsoFires: ['223rem'], kind: 'rifle' },
  { key: '223wylde', label: '.223 Wylde', aliases: ['223 wylde', 'wylde'], alsoFires: ['223rem', '556nato'], kind: 'rifle' },
  { key: '300blk', label: '.300 Blackout', aliases: ['300 blk', '300 blackout', '300 aac', '300blk', '7.62x35'], kind: 'rifle' },
  { key: '762x39', label: '7.62x39', aliases: ['7.62x39', '762x39', '7.62x39mm'], kind: 'rifle' },
  { key: '308win', label: '.308 Winchester', aliases: ['308', '308 win', '308 winchester'], kind: 'rifle' },
  { key: '762nato', label: '7.62x51 NATO', aliases: ['7.62x51', '7.62 nato', '762x51'], alsoFires: ['308win'], kind: 'rifle' },
  { key: '65cm', label: '6.5 Creedmoor', aliases: ['6.5 creedmoor', '6.5 cm', '6.5cm', '6.5 creed'], kind: 'rifle' },
  { key: '3006', label: '.30-06 Springfield', aliases: ['30-06', '3006', '30 06', '30-06 springfield'], kind: 'rifle' },
  { key: '270win', label: '.270 Winchester', aliases: ['270', '270 win'], kind: 'rifle' },
  { key: '3030', label: '.30-30 Winchester', aliases: ['30-30', '3030', '30 30'], kind: 'rifle' },
  { key: '762x54r', label: '7.62x54R', aliases: ['7.62x54r', '762x54r', '54r'], kind: 'rifle' },
  { key: '45-70', label: '.45-70 Government', aliases: ['45-70', '4570', '45-70 govt'], kind: 'rifle' },
  { key: '12ga', label: '12 gauge', aliases: ['12', '12ga', '12 ga', '12 gauge'], kind: 'shotgun' },
  { key: '20ga', label: '20 gauge', aliases: ['20', '20ga', '20 ga', '20 gauge'], kind: 'shotgun' },
  { key: '410', label: '.410 bore', aliases: ['410', '410 bore', '.410 ga'], kind: 'shotgun' },
];

const norm = (s: string) => s.toLowerCase().trim().replace(/^\.+/, '').replace(/[\s_]+/g, ' ');

/** Canonical key for a caliber string; unknown calibers key on their normalized text. */
export function caliberKey(input: string): string {
  const n = norm(input);
  for (const c of CALIBERS) {
    if (c.key === n || norm(c.label) === n || c.aliases.some((a) => norm(a) === n)) return c.key;
  }
  return n;
}

export function caliberLabel(input: string): string {
  const k = caliberKey(input);
  return CALIBERS.find((c) => c.key === k)?.label ?? input.trim();
}

/** Keys of ammunition a chamber of this caliber accepts (itself + one-way compatibles). */
export function chamberAccepts(input: string): string[] {
  const k = caliberKey(input);
  return [k, ...(CALIBERS.find((c) => c.key === k)?.alsoFires ?? [])];
}
