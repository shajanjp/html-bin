import listingTemplate from "./pages/listing.html";
import submitTemplate from "./pages/submit.html";

export interface Env {
  HTML_BIN: KVNamespace;
  BASIC_AUTH_USERNAME: string;
  BASIC_AUTH_PASSWORD: string;
}

// Helper: Validate the Basic auth header against Worker secrets
function isAuthorized(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Basic ")) return false;

  if (!env.BASIC_AUTH_USERNAME || !env.BASIC_AUTH_PASSWORD) return false;

  let decoded: string;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return false;
  }

  const separator = decoded.indexOf(":");
  if (separator === -1) return false;

  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);

  return (
    username === env.BASIC_AUTH_USERNAME &&
    password === env.BASIC_AUTH_PASSWORD
  );
}

// Helper: 401 response that triggers the browser's Basic auth prompt
function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Basic realm="html-bin", charset="UTF-8"',
    },
  });
}

interface PageMetadata {
  title: string;
  // publishedAt is kept for backwards compatibility with older listings/tools.
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  tags?: string[];
}

interface PageEntry {
  key: string;
  title: string;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
}

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 32;
// Cloudflare KV serializes metadata into a 1024 byte field.
const MAX_METADATA_BYTES = 1024;

// Tags are trimmed and de-duplicated case-insensitively while keeping the
// casing the user typed for display.
function normalizeTags(value: unknown): { tags: string[] } | { error: string } {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : null;

  if (!raw) return { error: "Tags must be an array of strings." };

  const tags: string[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (typeof item !== "string") {
      return { error: "Each tag must be a string." };
    }

    const tag = item.replace(/\s+/g, " ").trim();
    if (!tag) continue;

    if (tag.length > MAX_TAG_LENGTH) {
      return { error: `Tags must be ${MAX_TAG_LENGTH} characters or fewer.` };
    }

    const normalized = tag.toLowerCase();
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    tags.push(tag);
  }

  if (tags.length > MAX_TAGS) {
    return { error: `A page can have at most ${MAX_TAGS} tags.` };
  }

  return { tags };
}

// Returns null when the header is absent so updates can keep existing tags.
function parseTagsHeader(
  header: string | null
): { tags: string[] } | { error: string } | null {
  if (header === null) return null;

  const value = header.trim();
  if (value === "") return { tags: [] };

  if (value.startsWith("[")) {
    try {
      return normalizeTags(JSON.parse(value));
    } catch {
      return { error: "X-Page-Tags must be a JSON array or a comma-separated list." };
    }
  }

  return normalizeTags(value);
}

function exceedsMetadataLimit(metadata: PageMetadata): boolean {
  const serialized = JSON.stringify(metadata);
  return new TextEncoder().encode(serialized).length > MAX_METADATA_BYTES;
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

// KV metadata is serialized into an HTTP header, so keep the stored title ASCII-only.
function toAsciiTitle(title: string): string {
  return title
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Helper: Extract <title> without a DOM (Workers have no DOM API)
function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim() : null;
}

// Helper: Convert title into a URL-safe KV key
function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Helper: Escape user-provided strings before injecting into HTML
function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[c]!;
  });
}

// Fetch every key from KV (handles pagination automatically)
async function listAllPages(env: Env): Promise<PageEntry[]> {
  const entries: PageEntry[] = [];
  let cursor: string | undefined;

  while (true) {
    const page = await env.HTML_BIN.list<PageMetadata>({ cursor, limit: 1000 });
    for (const k of page.keys) {
      const publishedAt = k.metadata?.publishedAt ?? "";
      entries.push({
        key: k.name,
        title: k.metadata?.title || k.name,
        publishedAt,
        createdAt: k.metadata?.createdAt ?? "",
        // Legacy entries only have publishedAt, which already tracks the last write.
        updatedAt: k.metadata?.updatedAt ?? publishedAt,
        tags: Array.isArray(k.metadata?.tags) ? k.metadata.tags : [],
      });
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }

  entries.sort((a, b) => a.title.localeCompare(b.title));
  return entries;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Stable server-side fallback; the browser re-formats it for the local timezone.
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${day} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

// Render the HTML listing page
async function renderListing(env: Env, origin: string): Promise<Response> {
  const pages = await listAllPages(env);

  const rows = pages
    .map((p) => {
      const displayDate = p.updatedAt || p.createdAt;
      const dateLabel =
        p.createdAt && p.updatedAt && p.createdAt !== p.updatedAt
          ? `Created ${formatDate(p.createdAt)} · Updated ${formatDate(p.updatedAt)}`
          : `Updated ${formatDate(displayDate)}`;

      const date = displayDate
        ? `<span class="date" title="${escapeHtml(dateLabel)}"><time datetime="${escapeHtml(
            displayDate
          )}" data-date>${escapeHtml(formatDate(displayDate))}</time></span>`
        : "";

      const pageUrl = `${origin}/${encodeURIComponent(p.key)}`;
      const tags = Array.isArray(p.tags) ? p.tags : [];
      const tagsHtml = tags
        .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
        .join("");

      return `
        <li class="row" data-row data-title="${escapeHtml(
          p.title
        )}" data-slug="${escapeHtml(p.key)}" data-tags="${escapeHtml(
          JSON.stringify(tags)
        )}">
          <a class="row-link" href="${pageUrl}" target="_blank" rel="noopener noreferrer">
            <span class="meta">
              <span class="title">${escapeHtml(p.title)}</span>
              <span class="slug">/${escapeHtml(p.key)}</span>
              <span class="tags" data-tags-container${tags.length ? "" : " hidden"}>${tagsHtml}</span>
            </span>
            <span class="row-end">
              ${date}
              <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
            </span>
          </a>
          <div class="row-actions" role="group" aria-label="Actions for ${escapeHtml(
            p.title
          )}">
            <button type="button" class="action action-tag" data-edit-tags aria-label="Edit tags for ${escapeHtml(
              p.title
            )}" title="Edit tags">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41 12 22l-9-9V4h9l8.59 8.59a2 2 0 0 1 0 2.82Z"/><circle cx="7.5" cy="7.5" r="1"/></svg>
            </button>
            <button type="button" class="action action-copy" data-copy data-url="${escapeHtml(
              pageUrl
            )}" aria-label="Copy link to ${escapeHtml(p.title)}" title="Copy link">
              <svg class="icon-copy" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              <svg class="icon-check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
            </button>
            <button type="button" class="action action-delete" data-delete data-key="${escapeHtml(
              p.key
            )}" data-title="${escapeHtml(p.title)}" aria-label="Delete ${escapeHtml(
              p.title
            )}" title="Delete">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
            </button>
          </div>
        </li>`;
    })
    .join("");

  const list = pages.length
    ? `<ul id="list">${rows}</ul><div id="empty" class="empty" hidden>No pages published yet. POST some HTML to get started.</div>`
    : `<ul id="list" hidden></ul><div id="empty" class="empty">No pages published yet. POST some HTML to get started.</div>`;

  const html = listingTemplate
    .replaceAll("{{count}}", String(pages.length))
    .replaceAll("{{pagesLabel}}", pages.length === 1 ? "page" : "pages")
    .replaceAll("{{list}}", list);

  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

// Render the submission form page
function renderSubmitPage(): Response {
  return new Response(submitTemplate, {
    headers: {
      "Content-Type": "text/html;charset=UTF-8",
      "Cache-Control": "no-store",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // --- POST: Store HTML (Create or Overwrite) ---
    if (request.method === "POST" && url.pathname === "/") {
      if (!isAuthorized(request, env)) return unauthorized();

      const htmlContent = await request.text();

      if (!htmlContent || htmlContent.trim() === "") {
        return new Response(
          JSON.stringify({ error: "HTML content cannot be empty." }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const rawTitle = extractTitle(htmlContent);
      if (!rawTitle) {
        return new Response(
          JSON.stringify({
            error: "HTML must contain a valid <title> tag to use as an identifier.",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const key = slugifyTitle(rawTitle);
      if (!key) {
        return new Response(
          JSON.stringify({ error: "Title could not be converted to a valid URL key." }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const tagHeader = request.headers.get("X-Page-Tags");
      const parsedTags = parseTagsHeader(
        tagHeader !== null ? tagHeader : url.searchParams.get("tags")
      );
      if (parsedTags && "error" in parsedTags) {
        return badRequest(parsedTags.error);
      }

      // Check if this is a new page or an overwrite, and preserve the original
      // creation time and tags when a page is replaced without new tags.
      const existing = await env.HTML_BIN.getWithMetadata<PageMetadata>(key);
      const isNew = existing.value === null;
      const now = new Date().toISOString();
      const createdAt =
        existing.metadata?.createdAt || existing.metadata?.publishedAt || now;
      const existingTags = Array.isArray(existing.metadata?.tags)
        ? existing.metadata.tags
        : [];
      const tags = parsedTags === null ? existingTags : parsedTags.tags;

      const metadata: PageMetadata = {
        title: toAsciiTitle(rawTitle),
        createdAt,
        updatedAt: now,
        publishedAt: now,
        tags,
      };

      if (exceedsMetadataLimit(metadata)) {
        return badRequest("Page metadata exceeds the 1024 byte KV limit.");
      }

      // KV put() overwrites if the key exists — this gives us
      // "replace on same title" behavior automatically.
      await env.HTML_BIN.put(key, htmlContent, { metadata });

      const publicUrl = `${url.origin}/${key}`;
      return new Response(
        JSON.stringify({
          url: publicUrl,
          key,
          title: rawTitle,
          tags,
          isNew,
        }),
        { status: isNew ? 201 : 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // --- PATCH: Update an existing page's HTML, title, or tags ---
    if (request.method === "PATCH") {
      if (!isAuthorized(request, env)) return unauthorized();

      const key = url.pathname.slice(1);
      if (!key) return badRequest("A page key is required.");

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return badRequest("Request body must be valid JSON.");
      }

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return badRequest("Request body must be a JSON object.");
      }

      const patch = body as { html?: unknown; title?: unknown; tags?: unknown };
      const hasHtml = "html" in patch;
      const hasTitle = "title" in patch;
      const hasTags = "tags" in patch;

      if (!hasHtml && !hasTitle && !hasTags) {
        return badRequest('Provide at least one of "html", "title", or "tags".');
      }

      if (hasHtml && (typeof patch.html !== "string" || patch.html.trim() === "")) {
        return badRequest('"html" must be a non-empty string.');
      }

      if (hasTitle && (typeof patch.title !== "string" || patch.title.trim() === "")) {
        return badRequest('"title" must be a non-empty string.');
      }

      const parsedTags = hasTags ? normalizeTags(patch.tags) : null;
      if (parsedTags && "error" in parsedTags) return badRequest(parsedTags.error);

      const existing = await env.HTML_BIN.getWithMetadata<PageMetadata>(key);
      if (existing.value === null) {
        return new Response(JSON.stringify({ error: "Not Found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const html = hasHtml ? (patch.html as string) : existing.value;

      // Title precedence: explicit title, then the incoming HTML's <title>,
      // then whatever title is already stored.
      const rawTitle =
        (hasTitle ? (patch.title as string) : null) ??
        (hasHtml ? extractTitle(html) : null) ??
        existing.metadata?.title ??
        extractTitle(html) ??
        key;

      const title = toAsciiTitle(rawTitle);
      const newKey = slugifyTitle(title);
      if (!newKey) {
        return badRequest("Title could not be converted to a valid URL key.");
      }

      // A title change renames the page, so the new key must be free.
      if (newKey !== key) {
        const collision = await env.HTML_BIN.get(newKey);
        if (collision !== null) {
          return new Response(
            JSON.stringify({
              error: `A page with the key "${newKey}" already exists.`,
            }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          );
        }
      }

      const now = new Date().toISOString();
      const createdAt =
        existing.metadata?.createdAt || existing.metadata?.publishedAt || now;
      const existingTags = Array.isArray(existing.metadata?.tags)
        ? existing.metadata.tags!
        : [];

      const metadata: PageMetadata = {
        title,
        createdAt,
        updatedAt: now,
        publishedAt: now,
        tags: parsedTags === null ? existingTags : parsedTags.tags,
      };

      if (exceedsMetadataLimit(metadata)) {
        return badRequest("Page metadata exceeds the 1024 byte KV limit.");
      }

      await env.HTML_BIN.put(newKey, html, { metadata });
      if (newKey !== key) await env.HTML_BIN.delete(key);

      return new Response(
        JSON.stringify({
          key: newKey,
          url: `${url.origin}/${newKey}`,
          title,
          tags: metadata.tags,
          updatedAt: now,
          renamed: newKey !== key,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // --- GET: Serve HTML by slug, or show the protected listing at root ---
    if (request.method === "GET") {
      const key = url.pathname.slice(1);

      // Root path → listing page (HTML or JSON via ?format=json)
      if (key === "") {
        // The listing exposes every stored page, so keep it behind Basic auth.
        // The browser caches these credentials and reuses them for DELETE.
        if (!isAuthorized(request, env)) return unauthorized();

        if (url.searchParams.get("format") === "json") {
          const pages = await listAllPages(env);
          return new Response(JSON.stringify({ count: pages.length, pages }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return renderListing(env, url.origin);
      }

      // Submission form
      if (key === "submit") {
        return renderSubmitPage();
      }

      const htmlContent = await env.HTML_BIN.get(key);

      if (htmlContent) {
        return new Response(htmlContent, {
          headers: {
            "Content-Type": "text/html;charset=UTF-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      }
    }

    // --- DELETE: Remove a page by slug ---
    if (request.method === "DELETE") {
      if (!isAuthorized(request, env)) return unauthorized();

      const key = url.pathname.slice(1);
      if (!key) {
        return new Response(
          JSON.stringify({ error: "A page key is required." }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const existing = await env.HTML_BIN.get(key);
      if (existing === null) {
        return new Response(JSON.stringify({ error: "Not Found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      await env.HTML_BIN.delete(key);
      return new Response(JSON.stringify({ deleted: true, key }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
