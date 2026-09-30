# Telegram free subscription

`/free` is the public entry point. A visitor presses the button there, receives a short-lived one-use Telegram deep link, and the bot then creates or retrieves that Telegram account's single 3x-ui client. `/start` or `/start free` sent directly to the bot never provisions a client; it only replies with the `/free` URL.

This separate step prevents a bot deep link copied from a normal start message from being used to provision clients. The web claim expires after 10 minutes and is deleted immediately after use. Telegram `update_id` values are recorded for seven days, so webhook retries and duplicate delivery do not repeat client creation or the bot response.

## Setup

1. Create a separate Telegram bot. Rotate any bot or panel API token previously shared outside Vercel, then use `.env.example` as the list of Vercel Environment Variable names. Never put real values in that file or commit them. `XUI_API_TOKEN` needs 3x-ui admin scope. `XUI_ACCESS_URL` includes the panel's private base path; its HTTPS certificate must match the hostname (or IP SAN).
2. Connect an Upstash Redis store to the Vercel project. It supplies either `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` or `KV_REST_API_URL`/`KV_REST_API_TOKEN`; the backend accepts either complete pair. The store holds the policy, a sequential email counter, Telegram-ID-to-client mappings, one-use claims, webhook delivery records and short-lived rate-limit counters. Redeploy after changing environment variables.
3. Set `FREE_ADMIN_SECRET` to a random value of at least 32 characters. Open `/admin`, sign in with that value, select enabled VLESS or VMess inbounds, limits, expiry, group and the public subscription base URL ending in `/` (for example `https://sub.example/sub/`). Save. Saving also begins a visible synchronization of all clients already issued by this system. Keep the page open until the progress reaches the total. Register the Telegram webhook only on the production deployment.
4. Open `/free`, press the Telegram button, and start the generated deep link. Verify one client appears in the configured 3x-ui group, its Telegram ID matches the account, and the bot returns its subscription URL. A user needing the same link again must return to `/free` to obtain a new short-lived claim. Use **Sync existing clients** to resume a canceled synchronization.

`#001` is reserved and the first generated email is `#002`. If the counter starts behind manually created numbered clients, saving the admin policy advances it to the highest existing number. The `#` is URL-encoded in panel API paths. A Telegram account is not proof of a unique human, and anyone who receives a subscription URL can redistribute it.

If an administrator deliberately deletes a managed client in 3x-ui, the next valid `/free` claim for that Telegram account restores the same email (for example `#004`) with a new credential and a fresh expiry calculation. This happens only after 3x-ui explicitly reports that client as missing; authentication, network and timeout errors never trigger recreation.

## Safeguards and limits

- `/api/free/claim`: 12 claim links per IP per 10 minutes, and 120 globally per 10 minutes.
- Bot: 4 ordinary `/start` replies and 6 claim attempts per Telegram account per 10 minutes; ordinary starts are also capped at 120 globally per 10 minutes.
- Admin password: 8 attempts per IP per 15 minutes.
- All limits are stored atomically in Redis. They are deliberately small enough for normal use while protecting the panel and bot from automated bursts.
- Sync processes 20 clients per request, with at most 4 concurrent panel reads/updates. This keeps a 100-client update to roughly five browser requests while avoiding a large burst against 3x-ui.

For volumetric HTTP attacks, add an edge rate-limit rule in Vercel Firewall for `POST /api/free/claim`; application-level limits still remain necessary because they protect the bot and panel regardless of the edge configuration.

## Vercel variables

Use the names in `.env.example`. `TELEGRAM_BOT_USERNAME` is the public bot username without `@`; `TELEGRAM_BOT_TOKEN` is the new BotFather token; `TELEGRAM_WEBHOOK_SECRET` and `FREE_ADMIN_SECRET` should be independently generated random secrets. `PUBLIC_SITE_URL` is the production site origin, such as `https://your-domain.example`, not `/free`. The Redis pair is injected by the Upstash integration. Configure all variables for Production, redeploy, then save the policy and register the webhook from the production `/admin` page.

`XUI_ACCESS_URL` must be reachable from Vercel over HTTPS and include the panel base path. Its certificate must validate for the hostname; an IP URL with a certificate issued only to a domain will fail. Do not disable TLS verification or expose the 3x-ui API token in browser code. The subscription URL set in `/admin` must be the public HTTPS base for 3x-ui subscriptions, ending in `/sub/` or the actual configured path.

The panel must run a version with the first-class `/panel/api/clients` endpoints. Check its live `/panel/api/openapi.json` if requests fail. The test deployment uses no live panel or bot credentials during local tests.

## Optional two-active-IP gateway

The `gateway/` directory adds an optional WebSocket-only admission service. It
keeps the first two active source IPs for each issued link and rejects a third
IP before that request reaches Xray. It is deliberately separate from 3x-ui;
do not enable 3x-ui `Limit IP` for the same free clients.

Deployment order matters:

1. Install and test `free-gateway` on every VPS/port that will serve the free
   WebSocket inbounds. The command and the VPS configuration are in
   [`gateway/README.md`](gateway/README.md). Each service uses the same Upstash
   database, so its two IP slots apply across all protected nodes.
2. Move each selected 3x-ui VLESS/WS inbound behind its gateway. Xray must
   listen on a local-only port, with its usual `/vless` WebSocket path; the
   gateway owns the old public port. Block direct Internet access to the Xray
   ports. First verify the gateway health endpoint and a manually imported WS
   link before changing Vercel.
3. In Vercel, set `FREE_GATEWAY_SUBSCRIPTION_BASE_URL` to the public web route,
   for example `https://210z.dev/free/sub/`. Set `FREE_GATEWAY_PUBLIC_PORT` to
   the gateway listener port (`443` by default); this replaces the private
   Xray port in every issued WS link. Optionally set
   `FREE_GATEWAY_PUBLIC_SECURITY` to `tls` for a TLS listener or `none` for a
   plain HTTP listener. For TLS, optionally set `FREE_GATEWAY_PUBLIC_SNI`; it
   otherwise defaults to the hostname in each rewritten link. Set
   `FREE_GATEWAY_TOKEN_PATH_PREFIX` when the VPS uses something other than
   `/f/`, and `FREE_GATEWAY_PUBLIC_HOST` only when all protected nodes use one
   shared public hostname. Redeploy, save the policy in `/admin`, and let the
   existing-client synchronization finish. That registers a token for every
   previously issued client.
4. From this point, the bot returns `/free/sub/<sub-id>` rather than the direct
   3x-ui subscription. The endpoint retrieves the upstream subscription,
   replaces only VLESS WebSocket paths with the client token, and omits all
   non-WS links so they cannot bypass the gateway.

This is a two-*active-public-IP* rule, not a hardware-device fingerprint. Two
devices behind the same NAT appear as one IP; a device moving between Wi-Fi and
mobile data may use a second slot. When using Cloudflare or another CDN, trust
an original-IP header only after firewalling the gateway port to that provider's
published CIDR ranges.
