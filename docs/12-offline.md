# Offline

Bunkerr keeps working when your phone or computer can't reach the server: no signal, internet down, or the server itself down. This works in any browser and in the app installed to your home screen, on iPhone and Android.

## What works offline

| | Offline |
|---|---|
| Dashboard, inventory (every tab, search, expiry filters), power equipment, settings, gardens, mesh, docs | ✓ from the copy saved on the device |
| Armory list and firearm details (if the armory is on) | ✓ (serial numbers are saved masked: `••••1234`) |
| Add items, **−1 / used**, discard, edit, delete | ✓ saved on the device, synced later |
| Power reminders **✓ done** | ✓ saved on the device, synced later |
| Scanning a barcode you've entered before | ✓ (your own items) |
| Scanning a new product, receipt photos | needs a connection: the product database lives on the server |
| Settings changes, invites, gardens edits, armory edits | needs a connection: you'll see *"You're offline. This needs a connection."* |

A cyan **offline** banner shows when the device is working from its saved copy, how old that copy is, and how many changes are waiting. Items changed offline are tagged **not synced** until they've been sent.

## How it works

- **Saved copy.** While online, the app quietly downloads the main pages in the background: on start, when the connection comes back, and every 10 minutes. Pages work offline even if you never opened them on that device. Each household is saved separately.
- **Changes made offline** are queued on the device in the order you made them, and sent automatically when the server is reachable again. The app checks every 20 seconds while offline. Items you added offline can be used or edited before they sync.
- **Nothing is applied twice.** Each queued change carries a one-time key that the server remembers for 14 days. If a change got through but the reply was lost, sending it again returns the first result instead of, say, using a second can.
- **Conflicts.** If someone else changed the same item in the meantime, the change you made last wins. If the item was deleted, your change is dropped and a yellow banner says which one.
- **Changes stay in their household.** Changes queued in one household are only sent while that household is active.
- **Logging out** clears everything this account saved on the device. If changes are still waiting, you're warned first.

## Limits

- The first time on a device you need to be online to log in. After that, the app opens offline with the last saved copy.
- The dashboard totals don't recalculate offline. Inventory itself is always up to date with your offline changes.
- New products can't be looked up offline (the 135 MB product database is on the server). Type the name once, and its barcode is remembered.
- If the server is down for days, the saved copy is still there, but nothing syncs between people until it comes back.
