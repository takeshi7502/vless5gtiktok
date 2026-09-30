# Telegram free subscription test

`/test` opens the Telegram bot. The bot verifies the private Telegram user ID, creates one 3x-ui client in the configured inbounds, and replies with that client's subscription URL. Subsequent `/start` messages return the same link. `/admin` controls the policy and synchronizes existing web-created clients. The main site is unchanged.

## Setup

1. Create a separate Telegram bot. Rotate any bot or panel API token previously shared outside Vercel, then use `.env.example` as the list of Vercel Environment Variable names. Never put real values in that file or commit them. `XUI_API_TOKEN` needs 3x-ui admin scope. `XUI_ACCESS_URL` includes the panel's private base path; its HTTPS certificate must match the hostname (or IP SAN).
2. Connect an Upstash Redis store to the Vercel project. It supplies either `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` or `KV_REST_API_URL`/`KV_REST_API_TOKEN`; the backend accepts either complete pair. The store contains only the policy, a sequential email counter, and Telegram-ID-to-client mappings. Redeploy after changing environment variables.
3. Set `FREE_ADMIN_SECRET` to a random value of at least 32 characters. Open `/admin`, sign in with that value, select enabled VLESS or VMess inbounds, limits, expiry, group and the public subscription base URL ending in `/` (for example `https://sub.example/sub/`). Save, then register the Telegram webhook. Register it only on the production deployment.
4. Open `/test` and send `/start` to the bot. Verify one client appears in the configured 3x-ui group, its Telegram ID matches the account, and repeating `/start` returns the same URL. Use **Sync existing clients** after changing the admin policy. Inbound selection changes are attached/detached in batches; client credentials and traffic counters are retained.

`#001` is reserved and the first generated email is `#002`. If the counter starts behind manually created numbered clients, saving the admin policy advances it to the highest existing number. The `#` is URL-encoded in panel API paths. A Telegram account is not proof of a unique human, and anyone who receives a subscription URL can redistribute it.

## Vercel variables

Use the names in `.env.example`. `TELEGRAM_BOT_USERNAME` is the public bot username without `@`; `TELEGRAM_BOT_TOKEN` is the new BotFather token; `TELEGRAM_WEBHOOK_SECRET` and `FREE_ADMIN_SECRET` should be independently generated random secrets. `PUBLIC_SITE_URL` is the production site origin, such as `https://your-domain.example`, not `/test`. The Redis pair is injected by the Upstash integration. Configure all variables for Production, redeploy, then save the policy and register the webhook from the production `/admin` page.

`XUI_ACCESS_URL` must be reachable from Vercel over HTTPS and include the panel base path. Its certificate must validate for the hostname; an IP URL with a certificate issued only to a domain will fail. Do not disable TLS verification or expose the 3x-ui API token in browser code. The subscription URL set in `/admin` must be the public HTTPS base for 3x-ui subscriptions, ending in `/sub/` or the actual configured path.

The panel must run a version with the first-class `/panel/api/clients` endpoints. Check its live `/panel/api/openapi.json` if requests fail. The test deployment uses no live panel or bot credentials during local tests.
