export interface Env {
  HTML_BIN: KVNamespace;
}

interface PageMetadata {
  title: string;
  publishedAt: string;
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
async function listAllPages(
  env: Env
): Promise<{ key: string; title: string; publishedAt: string }[]> {
  const entries: { key: string; title: string; publishedAt: string }[] = [];
  let cursor: string | undefined;

  while (true) {
    const page = await env.HTML_BIN.list<PageMetadata>({ cursor, limit: 1000 });
    for (const k of page.keys) {
      entries.push({
        key: k.name,
        title: k.metadata?.title ?? k.name,
        publishedAt: k.metadata?.publishedAt ?? "",
      });
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }

  entries.sort((a, b) => a.title.localeCompare(b.title));
  return entries;
}

// Render the HTML listing page
async function renderListing(env: Env, origin: string): Promise<Response> {
  const pages = await listAllPages(env);

  const rows = pages
    .map(
      (p) => `
        <li>
          <a href="${origin}/${encodeURIComponent(p.key)}">
            <span class="title">${escapeHtml(p.title)}</span>
            <span class="slug">/${escapeHtml(p.key)}</span>
          </a>
        </li>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Published Pages (${pages.length})</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; background: #fafafa; }
    h1 { font-size: 1.5rem; margin-bottom: 4px; }
    .count { color: #888; font-size: 0.9rem; margin-bottom: 24px; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { margin-bottom: 8px; }
    a { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; text-decoration: none; color: inherit; transition: border-color 0.15s; }
    a:hover { border-color: #6366f1; }
    .title { font-weight: 500; }
    .slug { color: #888; font-size: 0.85rem; font-family: ui-monospace, monospace; }
    .empty { color: #888; padding: 40px; text-align: center; border: 2px dashed #e5e5e5; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>Published Pages</h1>
  <div class="count">${pages.length} page${pages.length === 1 ? "" : "s"}</div>
  ${
    pages.length
      ? `<ul>${rows}</ul>`
      : `<div class="empty">No pages published yet. POST some HTML to get started.</div>`
  }
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // --- POST: Store HTML (Create or Overwrite) ---
    if (request.method === "POST" && url.pathname === "/") {
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

      // Check if this is a new page or an overwrite (for the response only)
      const existing = await env.HTML_BIN.get(key);

      // KV put() overwrites if the key exists — this gives us
      // "replace on same title" behavior automatically.
      await env.HTML_BIN.put(key, htmlContent, {
        metadata: { title: rawTitle, publishedAt: new Date().toISOString() },
      });

      const publicUrl = `${url.origin}/${key}`;
      return new Response(
        JSON.stringify({
          url: publicUrl,
          key,
          title: rawTitle,
          isNew: existing === null,
        }),
        { status: existing === null ? 201 : 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // --- GET: Serve HTML by slug, or show listing at root ---
    if (request.method === "GET") {
      const key = url.pathname.slice(1);

      // Root path → listing page (HTML or JSON via ?format=json)
      if (key === "") {
        if (url.searchParams.get("format") === "json") {
          const pages = await listAllPages(env);
          return new Response(JSON.stringify({ count: pages.length, pages }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return renderListing(env, url.origin);
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

    return new Response("Not Found", { status: 404 });
  },
};
