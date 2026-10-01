# Telegram free subscription

The main page is the public entry point. Its **Xác minh Telegram** button creates a short-lived one-use Telegram deep link. The browser keeps that claim only in its session for five minutes, polls its status, and reveals the account's personal subscription URL after the bot confirms verification. `/free` redirects to the same main page for compatibility. `/start` or `/start free` sent directly to the bot never provisions a client: an unverified account is directed to the main page, while a verified account receives its existing subscription URL.

This separate step prevents a bot deep link copied from a normal start message from being used to provision clients. A web claim transitions from pending to claimed to ready, keeping only the result needed by the original browser session. The claim expires after five minutes. Telegram `update_id` values are recorded for seven days, so webhook retries and duplicate delivery do not repeat client creation or the bot response.

## Static link mode

The main page supports both sharing modes through `node-metadata.json`. Set `subscription.url` to one public HTTPS subscription URL to use the original static shared-link page; the Telegram panel is hidden and the browser does not call the free-link APIs. Leave `subscription.url` as an empty string to use Telegram verification and personal links. The static mode uses `/api/subscription-source` as a server-side proxy, so its node list can load without requiring CORS on the subscription host.

## Setup

1. Create a separate Telegram bot. Rotate any bot or panel API token previously shared outside Vercel, then use `.env.example` as the list of Vercel Environment Variable names. Never put real values in that file or commit them. `XUI_API_TOKEN` needs 3x-ui admin scope. `XUI_ACCESS_URL` includes the panel's private base path; its HTTPS certificate must match the hostname (or IP SAN).
2. Connect an Upstash Redis store to the Vercel project. It supplies either `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` or `KV_REST_API_URL`/`KV_REST_API_TOKEN`; the backend accepts either complete pair. The store holds the policy, a sequential email counter, Telegram-ID-to-client mappings, one-use claims, webhook delivery records and short-lived rate-limit counters. Redeploy after changing environment variables.
3. Set `FREE_ADMIN_SECRET` to a random value of at least 32 characters. Open `/admin`, sign in with that value, select enabled VLESS or VMess inbounds, limits, expiry, group and the public subscription base URL ending in `/` (for example `https://sub.example/sub/`). Save. Saving also begins a visible synchronization of all clients already issued by this system. Keep the page open until the progress reaches the total. Register the Telegram webhook only on the production deployment.
4. Open the main page, press **Xác minh Telegram**, and start the generated deep link. The bot confirms success without sending the URL; return to the page and it reveals the account's personal subscription URL and import controls. Verify one client appears in the configured 3x-ui group and its Telegram ID matches the account. A user can send `/start` again to the bot to receive the same URL, limited to two replies per five minutes. Use **Sync existing clients** to resume a canceled synchronization.

The first generated email is `#001` in a new store. Existing counters are preserved; saving the admin policy advances the counter to the highest existing numbered client and never resets it or renumbers existing clients. The `#` is URL-encoded in panel API paths. A Telegram account is not proof of a unique human, and anyone who receives a subscription URL can redistribute it.

The 3x-ui panel is authoritative. Admin counts are read from its current client list when the page opens, every 30 seconds while visible, and after synchronization. Redis's active-email index is reconciled with this list. A verified web claim returns its previous link only when both the Telegram mapping in Redis and its managed panel client exist. If either is missing, including a panel deletion, the claim creates a fresh client and replaces the mapping. A client explicitly disabled on the panel is not recreated or re-enabled; the bot asks the user to contact the administrator. Network, authentication, and malformed-response errors never erase the index. Existing enabled clients retain panel-side limits, expiry, and inbound attachments when retrieving their link; only an explicit admin save/sync applies the web policy to them.

Synchronization continues from the last client email, so deleting clients on the panel between batches cannot skip the next clients. Disabled clients still count as existing, and their enabled state is preserved by synchronization.

The admin configuration includes traffic/IP/HWID limits, group, expiry, first-use activation, renewal interval/day/count, and hourly/daily/weekly/monthly traffic resets. These map to native 3x-ui client fields; the panel runs the schedules in its own timezone. An empty expiry means no expiry. First-use activation switches expiry to a duration in days. Legacy creation-relative duration policies retain their existing behavior until the first-use switch or the legacy Duration/Expiry selector is changed. Monthly traffic reset uses day 1..31; days missing in a month are handled by the panel. IP/HWID enforcement remains the panel's native enforcement, not a new external limiter.

Redis stores a small expiry-settings signature for each issued client. Synchronization preserves an activated first-use deadline and, when expiry settings have not changed, a deadline advanced by panel auto-renewal. Changing expiry settings explicitly applies the new expiry, except that already activated first-use clients retain their actual deadline; the duration is for clients awaiting activation. A recurring policy remains valid after its initial cutoff passes, allowing the panel to catch up its renewal schedule. Sync does not reset usage or renewal counters.

## Safeguards and limits

- `/api/free/claim`: 12 claim links per IP per 10 minutes, and 120 globally per 10 minutes. Its status endpoint accepts only the short-lived claim capability in an HTTP header.
- Bot: 2 ordinary `/start` replies per Telegram account per 5 minutes and 6 claim attempts per Telegram account per 10 minutes; ordinary starts are also capped at 120 globally per 5 minutes.
- Admin password: 8 attempts per IP per 15 minutes.
- All limits are stored atomically in Redis. They are deliberately small enough for normal use while protecting the panel and bot from automated bursts.
- Sync processes 20 clients per request, with at most 4 concurrent panel reads/updates. This keeps a 100-client update to roughly five browser requests while avoiding a large burst against 3x-ui.

For volumetric HTTP attacks, add an edge rate-limit rule in Vercel Firewall for `POST /api/free/claim`; application-level limits still remain necessary because they protect the bot and panel regardless of the edge configuration.

## Vercel variables

Use the names in `.env.example`. `TELEGRAM_BOT_USERNAME` is the public bot username without `@`; `TELEGRAM_BOT_TOKEN` is the new BotFather token; `TELEGRAM_WEBHOOK_SECRET` and `FREE_ADMIN_SECRET` should be independently generated random secrets. `PUBLIC_SITE_URL` is the production site origin, such as `https://your-domain.example`, not `/free`. The Redis pair is injected by the Upstash integration. Configure all variables for Production, redeploy, then save the policy and register the webhook from the production `/admin` page.

`XUI_ACCESS_URL` must be reachable from Vercel over HTTPS and include the panel base path. Its certificate must validate for the hostname; an IP URL with a certificate issued only to a domain will fail. Do not disable TLS verification or expose the 3x-ui API token in browser code. The subscription URL set in `/admin` must be the public HTTPS base for 3x-ui subscriptions, ending in `/sub/` or the actual configured path.

The panel must run a version with the first-class `/panel/api/clients` endpoints. Check its live `/panel/api/openapi.json` if requests fail. The test deployment uses no live panel or bot credentials during local tests.
