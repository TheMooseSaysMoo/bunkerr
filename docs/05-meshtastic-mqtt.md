# Meshtastic MQTT → Bunkerr

Bunkerr learns node health from your **own Mosquitto broker**. Wi-Fi gateway nodes (any ESP32 board, e.g. Heltec V3/V4) uplink mesh packets to it, and Bunkerr subscribes to the JSON topics. Battery-only nodes show up whenever a gateway hears them.

## 1. Broker

`deploy/mosquitto/` has a standalone compose file. Run it on any host (it can be the Bunkerr server). Create users first:

```sh
cd deploy/mosquitto
docker run --rm -v "$PWD:/m" eclipse-mosquitto:2 mosquitto_passwd -c -b /m/passwd gateway 'LONG-RANDOM-1'
docker run --rm -v "$PWD:/m" eclipse-mosquitto:2 mosquitto_passwd -b /m/passwd bunkerr 'LONG-RANDOM-2'
```

The `acl` file lets `gateway` read and write `msh/#` and lets `bunkerr` read only. Then `docker compose up -d` in that directory, and in Bunkerr's `.env` set `MQTT_URL=mqtt://<broker-host>:1883`, `MQTT_USERNAME=bunkerr`, and `MQTT_PASSWORD=...`.

**Never use the public `mqtt.meshtastic.org` for the private channel.**

### Gateways at other sites

Meshtastic devices can't join a VPN. Pick one approach:

- **Bridge from a box at that site:** run a small Mosquitto on any always-on machine there that the gateway connects to on its LAN, and bridge it to your main broker over your private network (WireGuard, Tailscale…):
  ```
  # remote mosquitto.conf (in addition to the listener)
  connection home
  address <main broker private address>:1883
  remote_username gateway
  remote_password LONG-RANDOM-1
  topic msh/# both 0
  ```
- **TLS on the internet:** port-forward `8883` to your broker with a real certificate (for example Let's Encrypt for `mqtt.example.com`), and enable *TLS* in the gateway's MQTT settings. Keep strong passwords and the ACL.

## 2. Gateway node settings (ESP32, Wi-Fi)

In the Meshtastic app, on each gateway:

| Setting | Value |
|---|---|
| Network → Wi-Fi | your Wi-Fi |
| MQTT → Enabled | on |
| MQTT → Server address | broker host (e.g. `192.168.1.10` or `mqtt.example.com`) |
| MQTT → Username / Password | `gateway` / its password |
| MQTT → Root topic | `msh/US/MyTown` (anything under `msh/` works) |
| MQTT → **JSON output enabled** | **on** (Bunkerr reads JSON; ESP32 only) |
| MQTT → Encryption enabled | off on your private broker. Some firmware only publishes JSON with it off; the broker is protected by auth/TLS instead |
| MQTT → TLS | on if you connect over the internet |
| Channels → *private channel* → Uplink | on (downlink as needed) |
| Channels → LongFast → Uplink | off |

### Important: which channel carries telemetry

Node info, device telemetry and position are sent on the **primary channel (index 0)**. If your private channel is a secondary channel and only it has uplink enabled, Bunkerr never sees telemetry.

Choose one:
- make the **private channel the primary** (index 0) and LongFast a secondary on every family node (recommended for this setup), **or**
- enable uplink on LongFast too. Then everything heard publicly goes to your broker, and Bunkerr ignores nodes you haven't claimed.

Device telemetry is broadcast every 30 minutes by default (Telemetry → Device metrics interval). Keep Bunkerr's *node offline after* setting (Settings, default 120 min) comfortably above that.

## 3. Claim nodes in Bunkerr

**Mesh → add node.** Enter the ID (`!a1b2c3d4`, shown in the app's node list), plus a label and a site (Home, Cabin, Car…). A node can be claimed by only one household. Admins also see a list of recently heard unclaimed node IDs to make claiming easier.

## Troubleshooting

- **Broker "disconnected":** check `MQTT_URL`, the credentials, and `docker compose logs mosquitto`.
- **Connected, but a node is never heard:** watch the broker with `mosquitto_sub -h <broker> -u bunkerr -P ... -t 'msh/#' -v`. Do you see `/2/json/` topics? If you only see `/2/e/`, turn on JSON output (and turn MQTT encryption off).
- **Battery shows "USB":** Meshtastic reports 101% when the node is externally powered.
