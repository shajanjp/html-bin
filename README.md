# html-bin

A small Cloudflare Worker that stores and serves HTML pages in KV. POST some HTML with a `<title>` tag, get back a public URL. You can also describe a page in a prompt and let DeepSeek write or modify it.

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

Static pages live in `pages/` and are bundled as text via the `[[rules]]` entry in `wrangler.toml`. `pages/listing.html` uses `{{count}}`, `{{pagesLabel}}`, and `{{list}}` placeholders that are filled in at request time. Add more `.html` files there and import them in `index.ts`; `types.d.ts` provides the module type.

The DeepSeek system prompts live in `prompts.ts` so they can be reviewed and edited without touching the route handlers.

### Authentication

`POST /`, `PATCH /:key`, `DELETE /:key`, `POST /prompt`, `POST /:key/prompt`, and the listing at `GET /` require HTTP Basic auth. Credentials are read from the `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD` Worker secrets and are never stored in the repo. Published pages and the `/submit` and `/prompt` forms remain public.

The prompt routes also need a DeepSeek API key. `DEEPSEEK_API_KEY` is required; `DEEPSEEK_MODEL` is optional and defaults to `deepseek-flash`. `USD_INR_RATE` is optional and sets the INR per USD rate used for costs (default `88`).

```bash
# Production
npx wrangler secret put BASIC_AUTH_USERNAME
npx wrangler secret put BASIC_AUTH_PASSWORD
npx wrangler secret put DEEPSEEK_API_KEY

# Local development (.dev.vars is gitignored)
cat > .dev.vars <<'EOF'
BASIC_AUTH_USERNAME=admin
BASIC_AUTH_PASSWORD=change-me
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-flash
USD_INR_RATE=88
EOF
```

## Usage

Publish a page. The `<title>` becomes the slug, and posting the same title overwrites the existing page. The request must include Basic auth credentials:

```bash
curl -X POST http://localhost:8787/ \
  -u "admin:change-me" \
  -H "Content-Type: text/html" \
  -H "X-Page-Tags: design,work" \
  --data '<html><head><title>Hello World</title></head><body><h1>Hi</h1></body></html>'
```

Tags are optional. They can be passed with the `X-Page-Tags` header (comma-separated or a JSON array) or the `tags` query parameter. Omitting tags on an overwrite keeps the existing tags; sending an empty value clears them.

### Generate a page from a prompt

`POST /prompt` sends the prompt to DeepSeek and stores the generated HTML. The model is asked for a complete standalone document with a `<title>`, and that title becomes the key exactly like `POST /`.

```bash
curl -X POST http://localhost:8787/prompt \
  -u "admin:change-me" \
  -H "Content-Type: application/json" \
  --data '{"prompt":"A pricing page with three tiers and a monthly/yearly toggle","tags":["design"]}'
```

Response:

```json
{
  "url": "http://localhost:8787/saas-pricing",
  "key": "saas-pricing",
  "title": "SaaS Pricing",
  "tags": ["design"],
  "isNew": true,
  "usage": {
    "promptTokens": 512,
    "completionTokens": 4096,
    "cacheHitTokens": 0,
    "cacheMissTokens": 512,
    "peak": false,
    "costUsd": 0.002534,
    "costInr": 0.222992
  }
}
```

Limits and behaviour:

- `prompt` is required and limited to 2000 characters.
- `tags` is optional and uses the same validation as `POST /`. Omitting tags on an overwrite keeps the existing tags.
- Both routes instruct DeepSeek to style the page with Tailwind CSS utility classes and to include the Tailwind browser CDN script in `<head>`. The system prompts also push for strong visual hierarchy, responsive mobile-first layouts, accessible contrast, real copy, polished states. They live in `prompts.ts`.
- DeepSeek runs with thinking mode disabled and `max_tokens` 16000. If the API fails, or the response has no usable `<title>`, the request returns `502` and nothing is written to KV.
- A missing `DEEPSEEK_API_KEY` returns `500`.

### Modify a page with a prompt

`POST /:key/prompt` loads the existing page, sends a minified copy plus the instruction to DeepSeek, and stores the full rewritten document under the same key.

```bash
curl -X POST http://localhost:8787/saas-pricing/prompt \
  -u "admin:change-me" \
  -H "Content-Type: application/json" \
  --data '{"prompt":"Make the middle tier highlighted and add a FAQ section"}'
```

Response (same shape as `PATCH /:key`):

```json
{
  "key": "saas-pricing",
  "url": "http://localhost:8787/saas-pricing",
  "title": "SaaS Pricing",
  "tags": ["design"],
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "renamed": false,
  "usage": { "promptTokens": 9000, "completionTokens": 4200, "cacheHitTokens": 0, "cacheMissTokens": 9000, "peak": false, "costUsd": 0.00387, "costInr": 0.34056 }
}
```

Rules:

- The model may change the `<title>`, which renames the key and deletes the old one. Renaming onto an existing key returns `409 Conflict`.
- Tags are preserved unless `tags` is provided in the body.
- Before sending, the stored HTML is minified: comments are removed and indentation/blank lines are collapsed. Content inside `<pre>`, `<textarea>`, `<script>`, and `<style>` is left untouched.
- If the minified HTML is larger than 400 KB the request returns `413` instead of truncating the page.
- Missing keys return `404 Not Found`. Other failures match `POST /prompt`.

### Token usage and cost

Both prompt routes return a `usage` object with `promptTokens`, `completionTokens`, optional `reasoningTokens`, `cacheHitTokens`, `cacheMissTokens`, `peak`, `costUsd`, and `costInr`. Costs use DeepSeek's published `deepseek-flash` rates and half-price off-peak rates. Peak is detected as Monday to Friday, 01:00-04:00 and 06:00-10:00 UTC. Chinese public holidays are not modelled, so those requests are estimated at peak rates.

The total `tokens` and `costInr` for each page are stored in KV metadata. Creating a page with `/prompt` starts the totals; editing it with `/:key/prompt` adds to them. Plain `POST /` and `PATCH /:key` writes keep the existing totals, and renaming a page carries them to the new key. Costs are converted at the `USD_INR_RATE` in effect when the request runs.

When a page has usage, the listing shows the cumulative cost in rupees and token count, abbreviated with `k` or `m` (for example `₹0.0372 · 2.4k tokens`). The same values are available as `tokens` and `costInr` in `GET /?format=json`.

### Update a page

`PATCH /:key` updates an existing page in place. Send a JSON object with any combination of `html`, `title`, and `tags`. Fields you omit are left untouched.

```bash
curl -X PATCH http://localhost:8787/hello-world \
  -u "admin:change-me" \
  -H "Content-Type: application/json" \
  --data '{"tags":["design","personal"]}'
```

The title drives the URL key, so renaming a page moves it:

```bash
curl -X PATCH http://localhost:8787/hello-world \
  -u "admin:change-me" \
  -H "Content-Type: application/json" \
  --data '{"title":"Hello Again","html":"<html><head><title>Hello Again</title></head><body>Updated</body></html>"}'
```

Response:

```json
{ "key": "hello-again", "url": "http://localhost:8787/hello-again", "title": "Hello Again", "tags": ["design", "personal"], "updatedAt": "2026-01-01T00:00:00.000Z", "renamed": true }
```

Rules:

- At least one of `html`, `title`, or `tags` is required.
- `html` must be a non-empty string and is stored as-is.
- The effective title is `title`, then the incoming HTML's `<title>`, then the stored title.
- If the resulting key differs from the requested one, the page is moved and the old key is deleted. Renaming onto an existing key returns `409 Conflict`.
- `createdAt` is preserved; `updatedAt` and `publishedAt` move to now.
- `title` on its own renames the page but leaves the stored HTML untouched. Send `html` as well if the page's own `<title>` should change too.
- Tag limits and metadata size limits are the same as for `POST /`.
- Unknown keys return `404 Not Found`.

Requests without valid credentials get `401 Unauthorized` with a `WWW-Authenticate: Basic` header. Reading an individual page (`GET /:key`) remains public.

Delete a page by slug. Requires the same Basic auth credentials:

```bash
curl -X DELETE http://localhost:8787/hello-world \
  -u "admin:change-me"
```

Response:

```json
{ "deleted": true, "key": "hello-world" }
```

Deleting a key that does not exist returns `404 Not Found`.

Response:

```json
{ "url": "http://localhost:8787/hello-world", "key": "hello-world", "title": "Hello World", "tags": ["design", "work"], "isNew": true }
```

### Tags

Tags are stored in KV metadata with the page title and dates. A page can have up to 20 tags, each up to 32 characters. Tags are trimmed, internal whitespace is collapsed, and duplicates are removed case-insensitively. They can be set when publishing with `POST /` or changed later with `PATCH /:key`.

Tags are also included in `GET /?format=json`. Invalid tags, too many tags, or metadata above KV's 1024 byte limit return `400 Bad Request`.

Read pages:

```bash
curl http://localhost:8787/hello-world      # the stored HTML (public)
curl -u "admin:change-me" http://localhost:8787/                 # HTML listing of all pages
curl -u "admin:change-me" "http://localhost:8787/?format=json"  # listing as JSON
```

Or open `http://localhost:8787/submit` in a browser for a form with an HTML textarea and credential fields. It calls the same `POST /` endpoint via `fetch` and links to the published page. `/prompt` hosts the equivalent form for AI generation and posts to `POST /prompt`.

The listing page (`GET /`) also has a Delete button next to each page. It reuses the Basic auth credentials the browser captured when the listing loaded, so no separate prompt is needed. Deleting uses `DELETE /:key`.

The listing also includes a client-side search box that filters by title, URL/slug, and tags without any network requests, opens pages in a new tab, shows the last updated date when KV metadata has one (`createdAt`/`updatedAt`, falling back to the legacy `publishedAt` field), and has copy and tag buttons. Copy places the page's absolute URL on the clipboard (with a legacy fallback for non-secure contexts). The tag button opens a dialog where tags can be added or removed, saved through `PATCH /:key`. The first publish stores `createdAt`; later overwrites keep it and only move `updatedAt`.

Submission and generation are separate pages. `/submit` has the raw HTML box and Publish sends the HTML to `POST /`. `/prompt` has the AI prompt box and Generate sends it to `POST /prompt`, then shows the token count and estimated cost after the page is created. Each page links to the other.

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
