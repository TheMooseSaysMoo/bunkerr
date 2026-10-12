# Linked households

Link your household with a household on **another Bunkerr server**, such as a friend's or a relative's, so you can see each other's readiness. Each side chooses what it shares, and either side can end the link at any time. Optionally, the two servers can also relay a Meshtastic channel between your meshes.

## What can be shared

Each household decides for itself, per link. The other side never sees anything you haven't turned on.

| Switch | What the other household sees | Never included |
|---|---|---|
| **readiness summary** (on by default) | days of food and water, people in the household, batches per section, how many are expired, expiring soon or below minimum, power upkeep due, mesh nodes online | |
| **inventory** | item names, amounts, units, sections, expiry dates, minimums | locations, notes, barcodes |
| **power equipment** | devices, brand/model, capacity, output, fuel, charge level, next upkeep | serials, locations, notes |
| **mesh node status** | node names, site labels, hardware, online/offline, battery, last heard | positions |

**The armory is never shared**, whatever the switches say.

Everyone in your household (owners, members and viewers) can see what linked households share with you. Only **owners** create links, change the switches, or remove a link.

## Linking

1. On one server, an owner opens **Settings → linked households → create link code**. It looks like `https://their-bunkerr.example.com/#/link/…`. It works once and expires in 7 days.
2. Send it to the other household's owner by text, email or anything else.
3. They paste the whole code into **Settings → linked households → connect** on *their* Bunkerr.

That's it. Both servers now fetch what the other shares every 5 minutes. Open **Linked** (desktop sidebar, or the *linked households* card on the dashboard) to see it, and use **update now** to fetch straight away. Owners on the server that made the code get a notification when the link is made, and when the other side ends it.

**When their server is down**, you keep seeing the last copy, with a note saying how old it is. This is deliberate: in an outage you still know what your people have.

### Requirements

- **Both servers must be reachable from each other over https.** They talk to each other at their `PUBLIC_URL`, so set it to your real https address (behind Caddy, Nginx Proxy Manager, a Cloudflare Tunnel, etc.). Cloudflare Tunnels work fine.
- Bunkerr won't link to plain-http or private addresses by default, so a link code can't be used to make your server reach into its own network. If **both** servers are on one private network (the same LAN, WireGuard or Tailscale) and you want to link over it, set `FEDERATION_ALLOW_PRIVATE=true` in `.env` on both and use those addresses as `PUBLIC_URL`.
- To turn the feature off on a server, set `FEDERATION=off`.

### Ending a link

**Settings → linked households → remove link.** The other server is told immediately (if it's reachable). Its copy of your data is deleted, and it shows *link ended by them*. If it was unreachable, it notices on its next fetch.

### How it works

- The code holds your server's address and a one-time secret. When the other owner pastes it, their server calls yours, and the two exchange random tokens, one for each direction. A token is stored hashed on the server that checks it. The server that presents it keeps it encrypted with `INTERNAL_SECRET`.
- Each server **pulls** the other's shared data with its token (`GET /api/federation/feed`) and stores the validated copy. Nothing is pushed into your database except that copy.
- With a [failover pair](04-failover.md), links live in the database and move with it. Only the active server fetches or answers.

## Mesh relay (optional)

Two separate Meshtastic meshes, for example yours and a friend's 50 miles away, can carry one shared channel between them through the two Bunkerr servers. A message sent on that channel in one mesh is transmitted by a gateway in the other. Neither MQTT broker has to be opened to the internet; the packets travel over the https link.

### How it works

Your Wi-Fi gateways already publish every packet they hear on a channel to your broker, at `<root>/2/e/<channel>/<gateway id>`. For the channel names you choose, Bunkerr forwards those packets to the linked server. That server publishes them on its own broker under its own root, and its gateways with **downlink** enabled transmit them over LoRa. Each packet is passed on once, identified by sender and packet id. Packets that came from the other mesh are never sent back, even when several of your gateways hear them again.

### Setup (both sides)

1. **Same channel on both meshes.** Create the same channel *name* with the same *key* on the radios in both meshes, for example a secondary channel called `Family`. A channel name that differs at all, even in upper/lower case, won't match.
2. **Gateways:** on at least one Wi-Fi gateway per mesh, enable **Uplink** and **Downlink** on that channel (Channels → *channel* → Uplink / Downlink).
3. **Bunkerr's MQTT user needs to publish** to that channel's topic. With the broker in `deploy/mosquitto/`, add a write line to `acl`, then restart Mosquitto:
   ```
   user bunkerr
   topic read msh/#
   topic write msh/US/MyTown/2/e/Family/#
   ```
4. **Root topic:** Bunkerr publishes relayed packets under your gateways' root topic. It works this out from `MQTT_TOPICS` when that's a single root (`msh/US/MyTown/#`). Otherwise it uses the last root it saw traffic on. If your gateways use several roots, set `MQTT_ROOT=msh/US/MyTown` explicitly.
5. **`MQTT_TOPICS` must include the channel topics** (`.../2/e/...`). `msh/US/MyTown/#` does, while a filter that only covers `/2/json/` doesn't.
6. **Turn it on:** in **Settings → linked households**, the **instance admin** enters the channel name(s) under *mesh relay* and saves. Both servers must list the channel. Only the instance admin can do this, because the broker serves the whole server, not one household.

The link then shows *sent* / *received* counts. If the other side hasn't turned the relay on, it says which channels they don't relay.

### Notes

- Only the channels you list are relayed. Keep your primary or LongFast channel off the list unless you really want both meshes' telemetry and chatter crossing over.
- Direct messages between people in different meshes use Meshtastic's PKI topic and aren't relayed. Use the shared channel.
- Relayed packets keep the original gateway's id, so your own gateways don't ignore them.
- Packets queued while the other server is unreachable are kept for 5 minutes, then dropped as stale.
- **Alternative without Bunkerr:** bridge the two Mosquitto brokers directly. This needs one broker reachable from the other, over the internet with TLS or over a VPN. In `mosquitto.conf` on one side, the last two values map your root to theirs:
  ```
  connection friend
  address their-broker.example.com:8883
  remote_username ...
  remote_password ...
  bridge_capath /etc/ssl/certs
  topic Family/# both 0 msh/US/MyTown/2/e/ msh/US/TheirTown/2/e/
  ```

## Troubleshooting

| Message | Fix |
|---|---|
| *isn't https* / *is a private address* | The other server's `PUBLIC_URL` (or yours) isn't a public https address. Fix `PUBLIC_URL` and recreate the container (`docker compose up -d`), or set `FEDERATION_ALLOW_PRIVATE=true` on both if you link over a private network. |
| *That link code is invalid, expired or already used* | Ask for a new code. |
| *can't reach …* / *timed out* | Their server is down, or blocked by a firewall or Cloudflare Access policy. If you use Cloudflare Access, add a bypass rule for the path `/api/federation/*`. |
| *link ended by them* | They removed the link. Remove it on your side too, or ask for a new code. |
| Relay: *the other server doesn't relay: Family* | Their instance admin hasn't added the channel yet, or spelled it differently. |
| Relay: *doesn't know its MQTT root topic yet* | Set `MQTT_ROOT` (see step 4). |
| Relay sends but the other mesh hears nothing | Check Bunkerr's MQTT user can write to that topic (step 3), that a gateway there has **Downlink** on for the channel, and that the channel name and key match exactly. |
