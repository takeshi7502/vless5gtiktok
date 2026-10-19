# VLESS 5G TikTok

Static pages on Vercel with Node.js API functions, Telegram verification, 3x-ui and Redis.

## Source Layout

```text
pages/
  home/                 Main page HTML and browser JavaScript
  admin/                Admin page HTML, CSS and browser JavaScript
  top/                  Usage ranking HTML, CSS and browser JavaScript
assets/
  css/site.css          Shared styles for the homepage and ranking
  apps/                 Client app images
  icons/                UI icons
api/                    Vercel serverless endpoints
lib/                    Server-side helpers; never browser code
node-metadata.json      Static subscription URL and node metadata
vercel.json             Routes, legacy URL aliases and response headers
FREE_WEB.md             Deployment and operational documentation
```

Public page URLs remain `/`, `/free`, `/admin` and `/top`. Old root HTML, CSS and JS URLs
remain available through Vercel rewrites for cached pages and existing bookmarks. Use root-relative
asset paths so pages also work when opened through their nested source URLs.

Keep `node-metadata.json` at the project root: both the browser and subscription API use it.
Its compact hand-edited layout is excluded from automatic formatting. Set `subscription.url` to a
shared HTTPS subscription URL for static mode, or leave it empty for Telegram verification.

## Formatting

```sh
npm ci
npm run format
npm run format:check
```

Prettier formats application HTML, CSS, JavaScript, JSON and Markdown. It excludes generated files,
third-party assets, the separate gateway code and the ignored local test directory. Formatting does
not add a frontend framework or a build step. Deploy from the repository root as before.

See [FREE_WEB.md](FREE_WEB.md) for environment variables, Telegram commands and deployment setup.
