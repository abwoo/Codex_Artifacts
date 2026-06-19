import { once } from "node:events";
import fs from "node:fs";
import { startServer } from "../server/app";
import { CONFIG_PATH } from "../core/shared";

async function main(): Promise<void> {
  process.env.CODEX_ARTIFACT_AUTO_OPEN = "0";
  const server = await startServer(0);
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Verification server did not expose a TCP port.");
    const base = `http://127.0.0.1:${address.port}`;
    process.env.CODEX_ARTIFACT_PUBLIC_BASE_URL = base;
    const creator = { "Content-Type": "application/json", "X-Codex-User": "creator" };
    const admin = { "Content-Type": "application/json", "X-Codex-User": "admin" };
    const outsider = { "Content-Type": "application/json", "X-Codex-User": "outsider" };

    await fetch(`${base}/api/admin/enable`, { method: "POST", headers: admin, body: "{}" });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ permissions: { deny: [] } }, null, 2));
    const approvalRequired = await fetch(`${base}/api/artifacts`, {
      method: "POST",
      headers: creator,
      body: JSON.stringify({ title: "Needs Approval", type: "dashboard", content: "## Nope", sourceType: "inline", sourcePath: "approval" })
    });
    assert(approvalRequired.status === 409, "publish without approval is rejected");
    const published = await json(await fetch(`${base}/api/artifacts`, {
      method: "POST",
      headers: creator,
      body: JSON.stringify({ title: "Verification Dashboard", type: "dashboard", icon: "✓", audience: "organization", approved: true, content: "# Verification\n\n## Status\n\n- Published", sourceType: "inline", sourcePath: "verify.md" })
    }));
    assert(published.id, "publish returns id");
    const sessionArtifact = await json(await fetch(`${base}/api/artifacts/session`, {
      method: "POST",
      headers: creator,
      body: JSON.stringify({ title: "Session Capture", summary: "Session summary", changedFiles: ["src/app.ts"], testOutput: "tests ok", gitDiff: "diff --git a/src/app.ts b/src/app.ts", project: "Codex_Artifacts", approved: true })
    }));
    const sessionVersion = await json(await fetch(`${base}/v1/compliance/code/artifacts/${sessionArtifact.id}/versions/1`, { headers: creator }));
    assert(sessionVersion.version.contentHtml.includes("Changed Files") && sessionVersion.version.contentHtml.includes("src/app.ts") && sessionVersion.version.contentHtml.includes("tests ok"), "session artifact includes context sections");
    const sessionWithUrl = await json(await fetch(`${base}/api/artifacts/session`, {
      method: "POST",
      headers: creator,
      body: JSON.stringify({ title: "Session With URL Text", summary: "Contains https://example.com as log text.", changedFiles: [], testOutput: "https://example.com/log\nfetch('/only-text')", gitDiff: "", project: "Codex_Artifacts", approved: true })
    }));
    assert(sessionWithUrl.id, "session artifact allows inert URL and fetch text in logs and diffs");
    const externalLinkBlocked = await fetch(`${base}/api/artifacts`, {
      method: "POST",
      headers: creator,
      body: JSON.stringify({ title: "Blocked External Link", type: "dashboard", approved: true, content: "<section><a href=\"https://example.com\">external</a></section>" })
    });
    assert(externalLinkBlocked.status === 500, "external links remain blocked");
    const fetchBlocked = await fetch(`${base}/api/artifacts`, {
      method: "POST",
      headers: creator,
      body: JSON.stringify({ title: "Blocked Fetch", type: "dashboard", approved: true, content: "<section><script>fetch('/api')</script></section>" })
    });
    assert(fetchBlocked.status === 500, "runtime fetch remains blocked");
    const htmlBoundary = await json(await fetch(`${base}/api/artifacts`, {
      method: "POST",
      headers: creator,
      body: JSON.stringify({
        title: "HTML Boundary",
        type: "tune",
        approved: true,
        content: "<!doctype html><html><head><title>Readable Math Lab</title><style>.bad-summary{color:red}</style></head><body><section><h2>Readable Quadratic Lab</h2><p>Explore vertex and roots.</p><button id=\"copyPrompt\">User copy</button><canvas id=\"quadCanvas\"></canvas><script>document.getElementById('copyPrompt').dataset.ready='1';</script></section></body></html>",
        sourceType: "inline",
        sourcePath: "boundary.html"
      })
    }));
    const htmlBoundaryVersion = await json(await fetch(`${base}/v1/compliance/code/artifacts/${htmlBoundary.id}/versions/1`, { headers: admin }));
    const boundaryHtml = htmlBoundaryVersion.version.contentHtml;
    assert((boundaryHtml.match(/<!doctype html>/gi) || []).length === 1 && !boundaryHtml.includes("<body><!doctype"), "full HTML input is not nested inside shell");
    assert(boundaryHtml.includes("id=\"codexArtifactCopyPrompt\"") && boundaryHtml.includes("id=\"copyPrompt\""), "shell and user copyPrompt ids coexist");
    assert(boundaryHtml.includes("id=\"codexArtifactContent\"") && boundaryHtml.includes("id=\"codexArtifactSectionNav\""), "shell ids use codexArtifact prefix");
    assert(boundaryHtml.includes("Readable Math Lab") && !boundaryHtml.includes("bad-summary{color:red}"), "summary prefers readable text over CSS");
    const shareUrl = published.shareUrl;
    const updated = await json(await fetch(`${base}/api/artifacts/${published.id}`, {
      method: "PATCH",
      headers: creator,
      body: JSON.stringify({ content: "# Verification\n\n## Status\n\n- Updated", sourceType: "inline", sourcePath: "verify-update.md" })
    }));
    assert(updated.shareUrl === shareUrl, "share URL remains stable after update");

    const versions = await json(await fetch(`${base}/api/artifacts/${published.id}/versions`, { headers: creator }));
    assert(versions.items.length >= 2, "versions endpoint returns history");
    await json(await fetch(`${base}/api/artifacts/${published.id}/share`, {
      method: "POST",
      headers: creator,
      body: JSON.stringify({ mode: "version", version: 1, audience: "organization" })
    }));
    const pinnedPage = await (await fetch(shareUrl, { headers: { "X-Codex-User": "viewer" } as any })).text();
    const pinnedSrcdoc = decodeHtmlAttribute(/srcdoc="([\s\S]*?)"><\/iframe>/.exec(pinnedPage)?.[1] || "");
    assert(pinnedSrcdoc.includes("<li>Published</li>") && !pinnedSrcdoc.includes("<li>Updated</li>"), "pinned share shows version 1");
    await json(await fetch(`${base}/api/artifacts/${published.id}/share`, {
      method: "POST",
      headers: creator,
      body: JSON.stringify({ mode: "latest", audience: "organization" })
    }));

    const viewer = await fetch(shareUrl, { headers: { Cookie: "codex_artifact_session=missing", "X-Codex-User": "viewer" } as any });
    assert(viewer.status === 200, "org viewer can open share URL");
    const denied = await fetch(shareUrl, { headers: outsider as any });
    assert(denied.status === 404, "non-member cannot open share URL");
    await json(await fetch(`${base}/api/artifacts/${published.id}/share`, {
      method: "POST",
      headers: creator,
      body: JSON.stringify({ mode: "latest", audience: "private" })
    }));
    const privateDenied = await fetch(shareUrl, { headers: { "X-Codex-User": "viewer" } as any });
    assert(privateDenied.status === 404, "private artifact is visible only to author");
    await json(await fetch(`${base}/api/artifacts/${published.id}/share`, {
      method: "POST",
      headers: creator,
      body: JSON.stringify({ mode: "latest", audience: "user:viewer" })
    }));
    const userAllowed = await fetch(shareUrl, { headers: { "X-Codex-User": "viewer" } as any });
    assert(userAllowed.status === 200, "specific-user share allows named user");
    await json(await fetch(`${base}/api/artifacts/${published.id}/share`, {
      method: "POST",
      headers: creator,
      body: JSON.stringify({ mode: "latest", audience: "public" })
    }));
    const publicAllowed = await fetch(shareUrl);
    assert(publicAllowed.status === 200, "public share allows anonymous access");
    const remix = await json(await fetch(`${base}/api/artifacts/${published.id}/remix`, { method: "POST", headers: creator, body: "{}" }));
    assert(remix.id && remix.id !== published.id, "remix creates a new artifact");
    const auditEvents = await json(await fetch(`${base}/v1/compliance/code/audit-events?action=share&artifactId=${published.id}&limit=2`, { headers: admin }));
    assert(auditEvents.items.length > 0 && auditEvents.items.every((event: any) => event.action === "share"), "compliance audit endpoint filters share events");
    const auditDenied = await fetch(`${base}/v1/compliance/code/audit-events`, { headers: creator });
    assert(auditDenied.status === 403, "compliance audit endpoint requires admin");

    await fetch(`${base}/api/admin/disable`, { method: "POST", headers: admin, body: "{}" });
    const blocked = await fetch(`${base}/api/artifacts`, {
      method: "POST",
      headers: creator,
      body: JSON.stringify({ title: "Blocked", type: "dashboard", approved: true, content: "## Nope" })
    });
    assert(blocked.status === 403, "disabled artifacts block publish");
    await fetch(`${base}/api/admin/enable`, { method: "POST", headers: admin, body: "{}" });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ permissions: { deny: ["Artifact"] } }, null, 2));
    const configBlocked = await fetch(`${base}/api/artifacts`, {
      method: "POST",
      headers: creator,
      body: JSON.stringify({ title: "Config Blocked", type: "dashboard", approved: true, content: "## Nope" })
    });
    assert(configBlocked.status === 403, "permissions.deny Artifact blocks publish");
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ permissions: { deny: [] } }, null, 2));

    await json(await fetch(`${base}/api/admin/retention`, { method: "POST", headers: admin, body: JSON.stringify({ privateDays: 0, sharedDays: 365, creatorRoles: ["admin", "creator"] }) }));
    const cleanup = await json(await fetch(`${base}/api/admin/retention:run`, { method: "POST", headers: admin, body: "{}" }));
    assert(typeof cleanup.deleted === "number", "retention cleanup returns deleted count");

    const compliance = await json(await fetch(`${base}/v1/compliance/code/artifacts?limit=2`, { headers: admin }));
    assert(compliance.items.length <= 2 && "hasMore" in compliance, "compliance list paginates");
    const complianceAll = await json(await fetch(`${base}/v1/compliance/code/artifacts`, { headers: admin }));
    assert(complianceAll.items.some((item: any) => item.id === published.id), "compliance list includes artifact");
    const exact = await json(await fetch(`${base}/v1/compliance/code/artifacts/${published.id}/versions/1`, { headers: admin }));
    assert(exact.version.contentHtml.includes("Verification"), "compliance version retrieves content");

    const deleted = await fetch(`${base}/v1/compliance/code/artifacts/${published.id}`, { method: "DELETE", headers: admin });
    assert(deleted.status === 204, "compliance delete returns 204");
    const normalList = await json(await fetch(`${base}/api/artifacts`, { headers: creator }));
    assert(!normalList.items.some((item: any) => item.id === published.id), "deleted artifact disappears from normal list");
    const deletedList = await json(await fetch(`${base}/v1/compliance/code/artifacts?status=deleted`, { headers: admin }));
    assert(deletedList.items.some((item: any) => item.id === published.id), "deleted artifact remains compliance-visible");
    const gallery = await json(await fetch(`${base}/api/gallery`, { headers: creator }));
    assert(Array.isArray(gallery.mine) && Array.isArray(gallery.sharedWithMe) && Array.isArray(gallery.recent) && gallery.deleted.some((item: any) => item.id === published.id), "gallery exposes mine/shared/recent/deleted groups");
    const revoked = await fetch(shareUrl, { headers: { "X-Codex-User": "viewer" } as any });
    assert(revoked.status === 404, "deleted share URL is revoked");

    console.log("Verified service parity workflow: approval gate, session publish, stable share URL, update, pinned/latest share, audiences/public share, remix, gallery groups, constraints controls, retention, compliance list/audit/version/delete, revocation.");
  } finally {
    delete process.env.CODEX_ARTIFACT_PUBLIC_BASE_URL;
    if (fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify({ permissions: { deny: [] } }, null, 2));
    server.close();
    try {
      await once(server, "close");
    } catch {
      // Windows/sql.js can assert on a failing close path; verification result is already decided.
    }
  }
}

async function json(response: Response): Promise<any> {
  const data = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${data}`);
  return data ? JSON.parse(data) : {};
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`Verification failed: ${message}`);
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
