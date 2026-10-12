# Armory

Firearms, modifications and accessories, ammunition, and a range log, all per household like the rest of Bunkerr.

## Turning the armory off

Households without firearms can hide the whole section: **Settings → armory → armory tab** (owners only). The tab, the dashboard card and any armory digest lines disappear for everyone in the household, and the server refuses armory requests. Nothing is deleted. Turn it back on and everything is where you left it.

## Firearms

**Armory → add firearm.** Fill in make, model, variant or generation, caliber, type, action, barrel length, capacity, serial, acquisition date and price, condition, location, and status (active, stored, sold, transferred).

- **Round count** goes up automatically with every range session you log.
- Set **clean every (rds)** to get a *cleaning due* badge, and optionally a digest line. Use **# cleaned today** to reset it.
- Sold or transferred firearms stay in the records, dimmed, so the history and the insurance CSV stay complete.

## Modifications & accessories

Open a firearm, then **+ add modification**. You can record optics, lights, triggers, stocks, braces, muzzle devices, suppressors, handguards, magazines and more, with make, model, quantity, price, install date and serial.

**remove** moves a part to *spares* instead of deleting it. Spares and loose accessories (magazines, holsters, cases) live on the **parts** tab. Deleting a firearm turns its parts into spares.

## Ammunition

Each **lot** is one product: caliber, brand, product line, grain, bullet, purpose (range, defense, hunting), rounds, location, lot number and $/round.

- **+ / −** add or remove rounds, for a new box or a correction.
- **min rds** on any lot sets the low-ammo alert for that caliber. Totals are summed across lots.
- **scan box barcode** fills the form from a box you've entered before. Ammo is rarely in public barcode databases, so the first box of a product is typed once and remembered after that.

### Caliber matching

Common spellings are normalized, so `9x19`, `9mm`, `9mm Luger` and `9mm Parabellum` are the same caliber. A firearm counts ammo it can chamber, including the well-known one-way pairs:

| Chamber | Also counts |
|---|---|
| 5.56x45 NATO | .223 Remington |
| .223 Wylde | .223 Remington, 5.56 NATO |
| 7.62x51 NATO | .308 Winchester |
| .357 Magnum | .38 Special |
| .44 Magnum | .44 Special |

It never goes the other way: a .223 Remington chamber does **not** count 5.56. This only affects counting. The barrel marking and the manufacturer's manual are the authority on what's safe to fire.

## Range log

**log session**: choose the firearm, the ammo lot used, the rounds fired, the date and notes. The firearm's round count goes up and the lot goes down. **undo** reverses both.

## Privacy

| Data | Who sees it |
|---|---|
| Armory as a whole | owners and members. **Viewers don't see it** unless Settings → *show the armory to viewer accounts* is on |
| Full serial numbers | owners and members, by tapping **reveal**. Lists and viewer accounts show `••••1234` |
| Records CSV (insurance) | owners and members only. Includes full serials and prices |
| Daily digest (Discord) | nothing, unless *include low ammo & cleaning due* is on. Serials are never sent |

Serials are in the SQLite database. That means they're in the daily snapshots, any failover standby, and whatever backs up your data folder. Treat those copies like the paperwork they replace.

Keep a printed or offline copy of the **records csv** with your insurance documents.
