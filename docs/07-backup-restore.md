# Backup & restore

The whole application state is one SQLite file: `/data/bunkerr.db` inside the container, which is `data/bunkerr.db` in the app folder. `data/barcodes.db` (about 140 MB) is only a downloaded copy of public product data. It doesn't need backing up, because it rebuilds itself if missing.

A failover standby is a live off-site copy, but it isn't a backup: a mistaken delete reaches it at the next sync.

## Daily snapshots (built in)

At 03:41 the active instance writes a consistent copy (SQLite backup API) to `data/backups/bunkerr-YYYY-MM-DD.db` and keeps 14 days. Point your normal backup tool at `data/backups/`. Those are clean files, unlike a live database with a write-ahead log.

Don't copy `bunkerr.db` itself with `cp` while the app is running. Write-ahead log pages may be missing.

Also keep a copy of `.env`. Its `INTERNAL_SECRET` is needed to read the saved SMTP password.

## Restore

```sh
docker compose stop bunkerr
cp data/backups/bunkerr-2026-10-01.db data/bunkerr.db
rm -f data/bunkerr.db-wal data/bunkerr.db-shm
docker compose start bunkerr
```

A standby picks up the restored data at its next sync.

## Export

**Inventory → export csv** downloads the current household's inventory as a spreadsheet. A printed copy in the go-bag is a good idea. **Armory → records csv** does the same for firearms and ammunition (owners and members only).
