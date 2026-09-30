# Free WebSocket gateway

`free-gateway` is an optional admission proxy for the `free-web` clients. It
does not replace 3x-ui. Xray still validates the VLESS UUID and 3x-ui still
owns traffic, expiry, groups, and subscription IDs.

The gateway accepts a client-specific opaque path such as `/f/<token>`, keeps
at most two active source IP leases for that token in Upstash Redis, and then
proxies the WebSocket upgrade to Xray's normal `/vless` path. The first two
active IPs keep their slots; a third IP receives HTTP `429` before Xray sees
the connection.

## Install

Run on each VPS and public port that serves a protected VLESS WebSocket
inbound. This downloads source files from this repository and builds one small
binary; it does not use `git clone`.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/takeshi7502/vless5gtiktok/main/gateway/install.sh)
```

Edit the root-only file `/etc/free-gateway/free-gateway.env`, then start it:

```bash
nano /etc/free-gateway/free-gateway.env
systemctl enable --now free-gateway
systemctl status free-gateway --no-pager
```

Use the `KV_REST_API_URL` and `KV_REST_API_TOKEN` pair from the same Upstash
database already connected to Vercel. `GATEWAY_REDIS_KEY_PREFIX` must remain
`free-web:v1` unless the website is changed too.

## Required routing change

The public port must belong to this gateway, not directly to Xray. For a
normal TLS WebSocket inbound on port 443:

1. Move the 3x-ui inbound to a private local port, for example `127.0.0.1:10001`.
   Keep its WebSocket path `/vless`; disable TLS on this local hop.
2. Configure `LISTEN_ADDR=:443`, `BACKEND_URL=http://127.0.0.1:10001`, and
   `BACKEND_PATH=/vless` in the gateway environment. The Vercel variable
   `FREE_GATEWAY_PUBLIC_PORT` must be this public listener port (`443` by
   default), not `10001`; the subscription rewrite replaces the private port.
   Set `FREE_GATEWAY_PUBLIC_SECURITY=tls` in Vercel when this listener has a
   certificate, or `none` for a plain HTTP listener. For TLS, set
   `FREE_GATEWAY_PUBLIC_SNI` only when it differs from the node hostname.
3. If TLS terminates at the gateway, copy the certificate and private key into
   a directory readable by the `free-gateway` service, then set their paths in
   the environment file. For example:

   ```bash
   install -d -o root -g free-gateway -m 0750 /etc/free-gateway/tls
   install -o root -g free-gateway -m 0640 -T /etc/letsencrypt/live/vpn.example/fullchain.pem /etc/free-gateway/tls/fullchain.pem
   install -o root -g free-gateway -m 0640 -T /etc/letsencrypt/live/vpn.example/privkey.pem /etc/free-gateway/tls/privkey.pem
   systemctl restart free-gateway
   ```

   Use a Certbot deploy hook to repeat those copy commands after renewal. For
   a CDN forwarding plain HTTP to the VPS, leave both TLS variables empty and
   use `:80`.
4. Verify `curl -i http://127.0.0.1:443/healthz` from the VPS returns 200
   (use `https://` when TLS is configured).
5. Only after the gateway is healthy, set `FREE_GATEWAY_SUBSCRIPTION_BASE_URL`
   in Vercel and redeploy the website. The web service will then issue rewritten
   WS links under `/free/sub/<subscription-id>`.

Do not expose the former Xray port publicly. Otherwise a shared user can
replace the path with `/vless` and bypass the gateway.

## CDN and source IP headers

With a direct VPS connection, leave `TRUSTED_PROXY_CIDRS` empty. The gateway
uses the TCP peer IP and ignores `X-Forwarded-For`.

When a CDN/reverse proxy is in front, it is safe to use an original-client-IP
header only after the VPS firewall permits this listener **only** from that
provider's published IP ranges. Put those ranges in `TRUSTED_PROXY_CIDRS` and
set `CLIENT_IP_HEADER`, for example `CF-Connecting-IP` for Cloudflare. Never
trust such a header from an Internet-facing listener: a client could forge it.

## Scope and operations

- This release protects `type=ws` links only. The Vercel subscription endpoint
  deliberately omits non-WS links while gateway mode is enabled, preventing a
  direct xHTTP/VMess link from bypassing the rule.
- Install one gateway service for every node/port included in the protected
  subscription. They share slot state through Redis, so two IPs are enforced
  across all those nodes together.
- Set 3x-ui `Limit IP` to `0` for the free clients. Its Fail2ban job conflicts
  with this gateway's first-two-wins policy.
- The rule limits active public IPs, not physical hardware. A device moving
  from Wi-Fi to mobile data occupies another slot; two devices behind one NAT
  appear as one IP.
