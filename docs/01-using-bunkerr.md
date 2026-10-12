# Using Bunkerr

Bunkerr tracks a household's emergency supplies, warns before things expire, plans garden beds, and watches the Meshtastic mesh.

## Households, people and roles

Everything (inventory, gardens, nodes, notification settings) belongs to a **household**. A person can be in several households and switch with the selector at the top of the screen.

| Role | Can do |
|---|---|
| owner | everything, plus members, invites, notification settings, delete household |
| member | add/edit inventory, gardens, mesh nodes |
| viewer | read-only (good for kids or a neighbour you share with) |

- **Invite someone to your household:** Settings → Household → *create invite*. Send the link; it works once and expires in 7 days.
- **Help someone start their own household:** an instance admin uses Settings → Instance admin → *create* to make a "new household" invite link. They register and become owner of a new, separate household.
- Anyone signed in can also start another household (e.g. a cabin) from Settings.
- Households never see each other's data.

## Inventory sections

**Stock** has a tab for each section: *all · food · water · medical · hygiene · power · tools · comms · garden · other*. Each tab shows how many batches it holds. On a phone the row scrolls sideways.

- Each section has its own **add** button (for example **add medical**). The form opens with that category already set, and suggestions from that section come first.
- An empty section shows **quick picks**, common items for that section. Tap one to add it with its usual size filled in.
- **power** holds both your power equipment (power banks, battery backups, generators, with charge reminders; see *Power equipment*) and power supplies (batteries, propane, fuel).
- **scan** goes to the barcode scanner and receipt photo import.

## Adding inventory

Go to **Add** (the `+` tab).

- **Quick add.** Type a name, quantity and expiry, then press enter. Leave *keep location / category / date* ticked to enter a whole shelf quickly. Names you've used before autocomplete and fill in their usual unit, category and location.
- **Scan barcode.** Tap *start camera* and point it at a UPC or EAN. Bunkerr checks your household's past entries first, then an offline copy of the USDA and Open Food Facts grocery databases (about 970k products, works with no internet), then online databases. For most groceries it also fills in calories per package. See [Barcode lookups](10-barcodes.md). You confirm the quantity and expiry before anything is saved. A USB or Bluetooth barcode scanner also works: click the barcode box and scan.
- **Receipt / shelf photo.** Take a photo. Claude reads the items and you review an editable table before adding. Expiry dates are only filled in when they're printed and legible. Each household has a monthly photo quota, which an admin can change.

Identical batches (same name, unit, location, category and expiry) are merged automatically. Different expiry dates stay as separate batches, so the **use first** list is accurate.

### Expiry colours

| Badge | Meaning |
|---|---|
| EXPIRED | past its date |
| USE SOON | within the "use soon" window (30 days by default) |
| < 90d | within the "upcoming" window |
| OK | further out |

Set **min qty** on an item to get a low-stock warning. Set **kcal per unit** on food so the dashboard can estimate how many days of food you have. Track water in `gal` or `L` for the water-days estimate (FEMA guideline: 1 gallon per person per day).

## Gardens

1. **Gardens → new garden.** Give it a width and depth in cells. The default cell is 1 ft, as in square-foot gardening.
2. Tap a plant in the palette, then tap a cell, or drag across cells to plant a block.
3. Tap a planting to see its sprout date, harvest date and watering schedule. From there you can mark it watered or harvested, move it, resize it, or remove it.
4. **~ watered everything** resets the watering clock for the whole bed. Use it after rain too.

The plant catalogue has about 40 common crops with sowing windows for SW Ohio. Add your own with **+ custom**.

## Mesh

**Mesh → add node.** Enter the node ID shown in the Meshtastic app (`!a1b2c3d4`). Bunkerr shows when each node was last heard, plus battery, channel utilisation and signal. It sends an alert when a node goes offline, comes back, or runs low on battery. Setup is in [Meshtastic MQTT](#/docs/05-meshtastic-mqtt).

## Notifications

Owners set up ntfy or Discord in **Settings → alerts & notifications**, and everyone can subscribe to email alerts in **Settings → email alerts**. You get:
- a **daily digest** at the time you choose (expired, use soon, low stock, watering, harvest, offline nodes). It's only sent when there's something to report.
- **immediate** mesh alerts.

See [Notifications](#/docs/06-notifications).

## Keyboard shortcuts (desktop)

Press `g` then: `h` home · `i` inventory · `a` add · `g` gardens · `r` armory · `m` mesh · `d` docs · `s` settings. On the inventory screen, press `/` to search.

## Install on your phone

Open the site in your phone's browser, then use *Add to Home Screen* (iOS: Share menu; Android: ⋮ menu). It opens full-screen like an app. The camera works for barcodes because the site is served over HTTPS.
