# html-bin

A small Cloudflare Worker that stores and serves HTML pages in KV. POST some HTML with a `<title>` tag, get back a public URL.

## Use cases

- **Share AI-generated HTML.** LLMs are good at producing single-file HTML, but chat windows are a poor place to open it. Paste the output in and send the link instead. Re-posting the same title updates the page in place, so a conversation can keep revising one URL.
- **Keep a collection of small webpages and utilities.** Calculators, converters, dashboards, cheat sheets, forms, a personal landing page. Each one is a single key, and the root path lists them all, so you never have to remember slugs.
- **Quick HTML previews.** Share a mockup or email template with a teammate without spinning up a repo, build step, or CI pipeline.
- **Throwaway notes and report pages.** Useful for anything that needs to render as a page rather than plain text, such as tables, charts, or print-friendly output.
- **Agent and automation output.** A workflow can POST its result and hand back a human-readable URL, no storage service or frontend to maintain.

## Setup

```bash
npm install
npm run check   # type check
npm run dev     # local dev server
```

The Worker expects a KV namespace bound as `HTML_BIN`. The namespace ID lives in `wrangler.toml`. To use your own:

```bash
npx wrangler kv namespace create HTML_BIN
# copy the id into wrangler.toml
```

### Authentication

`POST /` requires HTTP Basic auth. Credentials are read from the `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD` Worker secrets and are never stored in the repo.

```bash
# Production
npx wrangler secret put BASIC_AUTH_USERNAME
npx wrangler secret put BASIC_AUTH_PASSWORD

# Local development (.dev.vars is gitignored)
cat > .dev.vars <<'EOF'
BASIC_AUTH_USERNAME=admin
BASIC_AUTH_PASSWORD=change-me
EOF
```

## Usage

Publish a page. The `<title>` becomes the slug, and posting the same title overwrites the existing page. The request must include Basic auth credentials:

```bash
curl -X POST http://localhost:8787/ \
  -u "admin:change-me" \
  -H "Content-Type: text/html" \
  --data '<html><head><title>Hello World</title></head><body><h1>Hi</h1></body></html>'
```

Requests without valid credentials get `401 Unauthorized` with a `WWW-Authenticate: Basic` header. Reading pages (`GET`) remains public.

Response:

```json
{ "url": "http://localhost:8787/hello-world", "key": "hello-world", "title": "Hello World", "isNew": true }
```

Read pages:

```bash
curl http://localhost:8787/hello-world      # the stored HTML
curl http://localhost:8787/                 # HTML listing of all pages
curl "http://localhost:8787/?format=json"   # listing as JSON
```

## Deploy

```bash
npm run deploy
```

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the local Worker |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run check` | Type check with `tsc` |
| `npm run types` | Generate Worker types |
