# Onboarding family & friends

Use this checklist when someone new starts their own household. These steps are for the instance admin.

## Request access from the login page

Anyone can tap **Request access** on the login page and give a name, an email and an optional note.

- Admins see it under **Settings → instance admin → access requests**, with approve and reject buttons. They can also get it by email (Settings → email alerts → *email me new access requests*), and through the household's alert channel.
- With a webhook router that supports actions (`WEBHOOK_ROUTER_URL`), the message carries **Approve** and **Reject** actions. Reacting ✅ or ❌ makes the router call signed links. Each link covers a single request and a single decision, and expires after 14 days. No password or token ever appears in the message.
- The requester gets a private status link, which is also remembered on the login page of the device they used. When email is set up, they get the link by email too, and again when approved. Once approved, the link lets them choose a password, and they get their own household.
- Guard rails: 3 requests per hour per IP, at most 30 waiting at once, a hidden spam-trap field, and the same reply for "already has an account" and "already requested", so the form can't be used to find out who has an account. Old requests that were never finished are deleted after 90 days.
- If approvals come through a chat channel, anyone who can react in that channel can approve. Keep it to admins.

## Family portal (optional)

If you run a family portal or SSO front page that already knows who people are, it can create Bunkerr accounts for them directly, with no invite link:

- Set `HUB_TOKEN` in Bunkerr's `.env` (on both hosts, if you run a failover pair). The portal calls `POST /api/hub/accounts` with `Authorization: Bearer <HUB_TOKEN>` and `{email, name, password}`. `GET /api/hub/accounts?email=` tells it whether an account exists.
- Each new account gets its **own household**, which it owns. To have someone join *your* household instead, send them a household invite. One account can belong to several households.
- An account that already exists is never changed (no password reset, no rename), so the portal just reports "already set up".
- The route only answers over the LAN or private network, never through Cloudflare (requests carrying `CF-Connecting-IP` are refused), and only on the active instance. A standby answers 503, so a portal can try the next address.
- The portal must verify identity itself, for example a verified Cloudflare Access JWT, never a forgeable header.

## Everyone else: invite link or email

Both invite forms take an optional **email**: Settings → Household → *invite to this household*, and the admin's *invite someone to start their own household*. With an address filled in, the button changes to **send invite**:

- Bunkerr emails the link from your instance's address, with **Reply-To set to you**, so replies reach you. You still see the link and can share it yourself.
- On their signup page, their email is filled in already.
- Pending invites show who they went to and when, with **resend**. That's the same link, at most 3 sends per invite. If you need a new link, revoke and create a new one.
- If email isn't set up, or sending fails, the invite is still created and you get the link to share, with the reason shown.
- Non-admins can send at most 20 invite emails a day, so the form can't be used to spam people through your mail server.


1. **Settings → Instance admin → invite** with a note ("Mom & Dad"). Send them the link (text or Signal). It expires in 7 days and works once.
2. They open it on their phone, choose a household name (e.g. *Cabin house*), and create an account.
3. Help them:
   - add the site to their home screen (see *Using Bunkerr → Install on your phone*),
   - invite the rest of their household (Settings → Household → create invite),
   - set up their own Discord webhook or ntfy topic for alerts,
   - set **people in household** so the food and water day estimates are right.
4. If they have Meshtastic nodes, they claim them under **Mesh → add node**. If they run a gateway, it needs the broker credentials (see *Meshtastic MQTT*). Give each household a separate `gateway` login if you want to be able to revoke one site.
5. If they use photo import heavily, raise their monthly quota in the admin table. Each photo is one Claude API call.

## Removing access

- A household owner removes members in Settings → Household. Access ends immediately.
- An admin can **disable** any account in the admin panel, which signs it out everywhere.
- **Reset pw** gives a temporary password to pass along.

## Privacy

Households can't see each other's inventory, gardens, nodes or settings. Instance admins can see the list of users and households, with item and node counts, but the UI doesn't show admins anyone else's inventory.
