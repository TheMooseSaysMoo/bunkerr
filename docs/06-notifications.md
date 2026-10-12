# Notifications

Bunkerr sends a daily digest and urgent alerts per household, through any of:

- **Email**: each person subscribes themselves, once an admin has set up SMTP. See *Email alerts* below.
- **ntfy**: phone push through [ntfy.sh](https://ntfy.sh) or your own ntfy server.
- **Discord**: a channel webhook.

Set these up per household under **Settings → alerts & notifications** (owners), then **send test**.

## Discord webhook (every household)

1. In your Discord server, create a channel and open its settings.
2. Go to **Integrations → Webhooks → New Webhook** and click **Copy Webhook URL**.
3. Paste it in Bunkerr under **Settings → alerts & notifications**, save, then **send test**.

## ntfy

1. Install the ntfy app on your phone (iOS / Android) and subscribe to a topic with a long, hard-to-guess name, for example `bunkerr-7f3k2q9x`. Anyone who knows a topic on ntfy.sh can read it, so treat the name like a password.
2. In Bunkerr, tick **ntfy**, set the server (`https://ntfy.sh` or your own) and the topic. Add an access token if your server requires one.
3. **Save**, then **send test**.

Urgent alerts are sent at high priority, the digest at normal priority.

## What gets sent

| Message | When | Priority |
|---|---|---|
| Daily digest | once a day after the digest time, only if there's something to report | default |
| Mesh node offline | a claimed node not heard for the threshold (once per outage) | high |
| Mesh node back online | an offline node is heard again | default |
| Low battery | at most once per node per day | default |
| Failover / failback (ops) | from the watchdog on the standby | high |

Only the active instance sends household alerts, so failover never produces duplicates.

## Email alerts

Email is **in addition to** the household's channel above. Each person decides for themselves what lands in their inbox.

### Set up the mail server (admin, once)

**Settings → instance admin → email (SMTP)**:

1. Pick a **preset** (Gmail / Google Workspace, Microsoft 365, iCloud, Fastmail, Zoho) or type your provider's host, port and security.
2. Enter the **username** and **password**. Use an *app password* where the provider offers one. Gmail requires one, after turning on 2-step verification.
3. Set the **from address**. Most providers only accept their own mailbox (or a verified alias) as the sender.
4. Tick **send email from this instance**, **save**, then **send test**. If it fails, the error from the mail server is shown, for example `535 Username and Password not accepted`.

The password is encrypted at rest with the instance's `INTERNAL_SECRET` (in `.env`, the same on both hosts). It isn't readable from the database or its backups, and it's never sent back to the browser. If `INTERNAL_SECRET` ever changes, enter the password again. Email only goes out from the **active** instance, so a failover doesn't send duplicates.

### Subscribe (everyone)

**Settings → email alerts** lists each household you're in:

| Option | What you get |
|---|---|
| daily digest | the same daily summary as Discord: expiring, low stock, watering, power upkeep, mesh |
| urgent alerts | mesh node offline / back online, low node battery, as they happen |
| email me new access requests | admins only: someone asked for access on the login page |

Emails go to your account's address. **send me a test email** checks delivery. Viewer accounts get the digest without armory lines, unless the household shows the armory to viewers.

Every alert email has an **unsubscribe** link, and mail apps show their own one-click unsubscribe button (`List-Unsubscribe`). The link opens a page with a button, because mail scanners follow links and a scanner must not unsubscribe anyone. Leaving a household stops its emails immediately.

### Access requests

When email is set up, someone who requests access gets their private status link by email. They get it again when you approve, so they no longer have to keep the page open.

## Webhook router (advanced, optional)

If you already run a notification router that accepts Home Assistant-style webhooks, set `WEBHOOK_ROUTER_URL` in `.env` (a base URL, which gets `/api/webhook/homelab_alert` appended, or a full webhook URL). An instance admin can then turn on **webhook router** for a household. Bunkerr posts `{source, title, body, priority}`, and the household's direct Discord/ntfy settings become the fallback. Access-request messages also carry ntfy-style `actions` (approve/reject) for routers that can act on them.
