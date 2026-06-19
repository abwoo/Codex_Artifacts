import http, { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import {
  ARTIFACT_DIR,
  ArtifactRecord,
  ArtifactType,
  AuditEventRecord,
  Audience,
  DEFAULT_PORT,
  DbHandle,
  Role,
  SESSION_PATH,
  ShareMode,
  VersionRecord,
  VERSION_DIR,
  User,
  all,
  artifactDisabled,
  audit,
  findUser,
  getOne,
  id,
  now,
  openDb,
  readConfig,
  roleAtLeast,
  roleCanCreate,
  run,
  writeConfig
} from "./shared";
import { escapeText, htmlAttr, renderArtifactDocument, sourceContent } from "./render";

interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  handle: DbHandle;
  user?: User;
}

export async function startServer(port = DEFAULT_PORT): Promise<http.Server> {
  const handle = await openDb();
  const server = http.createServer(async (req, res) => {
    try {
      const ctx = await context(req, res, handle);
      await route(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, 500, { error: { code: "internal_error", message, requestId: id("req") } });
    }
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}

async function context(req: IncomingMessage, res: ServerResponse, handle: DbHandle): Promise<Context> {
  const url = new URL(req.url || "/", `http://${req.headers.host || `127.0.0.1:${DEFAULT_PORT}`}`);
  const user = authenticate(handle, req);
  return { req, res, url, handle, user };
}

function authenticate(handle: DbHandle, req: IncomingMessage): User | undefined {
  const headerUser = req.headers["x-codex-user"];
  if (typeof headerUser === "string") return findUser(handle.db, headerUser);
  const cookie = req.headers.cookie || "";
  const token = /(?:^|;\s*)codex_artifact_session=([^;]+)/.exec(cookie)?.[1];
  if (!token) return undefined;
  const row = getOne<{ userId: string }>(handle.db, "SELECT user_id AS userId FROM sessions WHERE token = ?", [token]);
  return row ? findUser(handle.db, row.userId) : undefined;
}

async function route(ctx: Context): Promise<void> {
  const { req, res, url } = ctx;
  const method = req.method || "GET";
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/health") return json(res, 200, { ok: true });
  if (method === "GET" && pathname === "/login") return page(res, loginPage());
  if (method === "POST" && pathname === "/login") return webLogin(ctx);
  if (method === "GET" && pathname === "/logout") return logout(ctx);

  if (pathname.startsWith("/api/")) return apiRoute(ctx);
  if (pathname.startsWith("/v1/compliance/")) return complianceRoute(ctx);
  const publicShareMatch = /^\/share\/([^/]+)$/.exec(pathname);
  if (method === "GET" && publicShareMatch) {
    const publicArtifact = loadPublicArtifactBySlug(ctx.handle, publicShareMatch[1]);
    if (publicArtifact) return sharedViewer(ctx, undefined, publicShareMatch[1]);
  }

  const user = requireWebUser(ctx);
  if (!user) return;

  if (method === "GET" && pathname === "/") return redirect(res, "/artifacts");
  if (method === "GET" && pathname === "/artifacts") return artifactsPage(ctx, user);
  if (method === "GET" && pathname === "/admin") return adminPage(ctx, user);
  if (method === "POST" && pathname === "/admin/settings") return adminSettings(ctx, user);
  if (method === "POST" && pathname === "/admin/retention") return adminRetentionForm(ctx, user);
  if (method === "POST" && pathname === "/admin/retention-run") {
    if (!roleAtLeast(user.role, "admin")) return page(ctx.res, layout("Forbidden", user, `<section><h1>Admin only</h1></section>`), 403);
    runRetention(ctx.handle, user);
    return redirect(ctx.res, "/admin");
  }

  const versionMatch = /^\/artifacts\/([^/]+)\/versions\/([^/]+)$/.exec(pathname);
  if (method === "GET" && versionMatch) return artifactViewer(ctx, user, versionMatch[1], versionMatch[2]);
  const webShareMatch = /^\/artifacts\/([^/]+)\/share$/.exec(pathname);
  if (method === "POST" && webShareMatch) return webShareSettings(ctx, user, webShareMatch[1]);
  const webRemixMatch = /^\/artifacts\/([^/]+)\/remix$/.exec(pathname);
  if (method === "POST" && webRemixMatch) return webRemix(ctx, user, webRemixMatch[1]);
  const artifactMatch = /^\/artifacts\/([^/]+)$/.exec(pathname);
  if (method === "GET" && artifactMatch) return artifactViewer(ctx, user, artifactMatch[1]);
  const shareMatch = /^\/share\/([^/]+)$/.exec(pathname);
  if (method === "GET" && shareMatch) return sharedViewer(ctx, user, shareMatch[1]);

  notFound(res);
}

function requireWebUser(ctx: Context): User | undefined {
  if (ctx.user) return ctx.user;
  redirect(ctx.res, `/login?next=${encodeURIComponent(ctx.url.pathname)}`);
  return undefined;
}

function requireApiUser(ctx: Context, role: Role): User | undefined {
  if (!ctx.user) {
    json(ctx.res, 401, { error: { code: "unauthorized", message: "Login required.", requestId: id("req") } });
    return undefined;
  }
  if (!roleAtLeast(ctx.user.role, role)) {
    json(ctx.res, 403, { error: { code: "forbidden", message: `Requires ${role} role.`, requestId: id("req") } });
    return undefined;
  }
  return ctx.user;
}

async function apiRoute(ctx: Context): Promise<void> {
  const { req, res, url, handle } = ctx;
  const method = req.method || "GET";
  const artifactMatch = /^\/api\/artifacts\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && artifactMatch) {
    const user = requireApiUser(ctx, "viewer");
    if (!user) return;
    const artifact = loadArtifactForUser(handle, user, artifactMatch[1]);
    if (!artifact) return notFound(res);
    return json(res, 200, artifactResponse(artifact));
  }
  if (method === "POST" && url.pathname === "/api/artifacts") {
    const user = requireApiUser(ctx, "creator");
    if (!user) return;
    if (artifactDisabled(handle.db, user.orgId)) return json(res, 403, { error: { code: "artifacts_disabled", message: "Artifact publishing is disabled.", requestId: id("req") } });
    if (!roleCanCreate(handle.db, user.orgId, user.role)) return json(res, 403, { error: { code: "artifact_role_denied", message: "Your role cannot create artifacts.", requestId: id("req") } });
    const body = await bodyJson<{ title: string; type: ArtifactType; icon?: string; audience?: string; content: string; sourceType?: string; sourcePath?: string; approved?: boolean }>(req);
    if (!body.approved) return json(res, 409, { error: { code: "approval_required", message: "Publishing requires explicit approval.", requestId: id("req") } });
    const artifact = publishArtifact(handle, user, body.title, body.type || "dashboard", body.icon || "◈", parseAudience(body.audience || "organization"), body.content, body.sourceType || "inline", body.sourcePath || "stdin");
    return json(res, 201, artifactResponse(artifact));
  }
  if (method === "POST" && url.pathname === "/api/artifacts/session") {
    const user = requireApiUser(ctx, "creator");
    if (!user) return;
    if (artifactDisabled(handle.db, user.orgId)) return json(res, 403, { error: { code: "artifacts_disabled", message: "Artifact publishing is disabled.", requestId: id("req") } });
    if (!roleCanCreate(handle.db, user.orgId, user.role)) return json(res, 403, { error: { code: "artifact_role_denied", message: "Your role cannot create artifacts.", requestId: id("req") } });
    const body = await bodyJson<{ title?: string; summary?: string; changedFiles?: string[]; testOutput?: string; gitDiff?: string; project?: string; approved?: boolean }>(req);
    if (!body.approved) return json(res, 409, { error: { code: "approval_required", message: "Publishing requires explicit approval.", requestId: id("req") } });
    const content = sessionMarkdown(body);
    const artifact = publishArtifact(handle, user, body.title || "Codex Session", "dashboard", "◈", parseAudience("organization"), content, "session", body.project || "codex-session");
    return json(res, 201, artifactResponse(artifact));
  }
  if (method === "PATCH" && artifactMatch) {
    const user = requireApiUser(ctx, "creator");
    if (!user) return;
    if (artifactDisabled(handle.db, user.orgId)) return json(res, 403, { error: { code: "artifacts_disabled", message: "Artifact updates are disabled.", requestId: id("req") } });
    const body = await bodyJson<{ content: string; sourceType?: string; sourcePath?: string }>(req);
    const artifact = updateArtifact(handle, user, artifactMatch[1], body.content, body.sourceType || "inline", body.sourcePath || "stdin");
    if (!artifact) return notFound(res);
    return json(res, 200, artifactResponse(artifact));
  }
  if (method === "GET" && url.pathname === "/api/artifacts") {
    const user = requireApiUser(ctx, "viewer");
    if (!user) return;
    return json(res, 200, { items: listArtifacts(handle, user), nextCursor: null });
  }
  if (method === "GET" && url.pathname === "/api/gallery") {
    const user = requireApiUser(ctx, "viewer");
    if (!user) return;
    return json(res, 200, galleryResponse(handle, user));
  }
  const shareConfigMatch = /^\/api\/artifacts\/([^/]+)\/share$/.exec(url.pathname);
  if (shareConfigMatch && method === "GET") {
    const user = requireApiUser(ctx, "viewer");
    if (!user) return;
    const artifact = loadArtifactForUser(handle, user, shareConfigMatch[1], false, true);
    if (!artifact) return notFound(res);
    return json(res, 200, shareResponse(artifact));
  }
  if (shareConfigMatch && method === "POST") {
    const user = requireApiUser(ctx, "creator");
    if (!user) return;
    const body = await bodyJson<{ mode?: string; version?: number; audience?: string }>(req);
    const artifact = configureShare(handle, user, shareConfigMatch[1], body.mode || "latest", body.version, body.audience || "organization");
    if (!artifact) return notFound(res);
    return json(res, 200, artifactResponse(artifact));
  }
  const approveMatch = /^\/api\/artifacts\/([^/]+)\/approve$/.exec(url.pathname);
  if (approveMatch && method === "POST") {
    const user = requireApiUser(ctx, "creator");
    if (!user) return;
    const artifact = approveArtifact(handle, user, approveMatch[1]);
    if (!artifact) return notFound(res);
    return json(res, 200, artifactResponse(artifact));
  }
  const versionsMatch = /^\/api\/artifacts\/([^/]+)\/versions$/.exec(url.pathname);
  if (method === "GET" && versionsMatch) {
    const user = requireApiUser(ctx, "viewer");
    if (!user) return;
    const artifact = loadArtifactForUser(handle, user, versionsMatch[1]);
    if (!artifact) return notFound(res);
    return json(res, 200, { items: versionsFor(handle, artifact.id) });
  }
  const unpublishMatch = /^\/api\/artifacts\/([^/]+)\/unpublish$/.exec(url.pathname);
  if (method === "POST" && unpublishMatch) {
    const user = requireApiUser(ctx, "creator");
    if (!user) return;
    const ok = setArtifactStatus(handle, user, unpublishMatch[1], "unpublished");
    return ok ? json(res, 200, { ok: true }) : notFound(res);
  }
  if (method === "DELETE" && artifactMatch) {
    const user = requireApiUser(ctx, "creator");
    if (!user) return;
    const ok = setArtifactStatus(handle, user, artifactMatch[1], "deleted");
    return ok ? json(res, 204, null) : notFound(res);
  }
  const remixMatch = /^\/api\/artifacts\/([^/]+)\/remix$/.exec(url.pathname);
  if (method === "POST" && remixMatch) {
    const user = requireApiUser(ctx, "creator");
    if (!user) return;
    const remix = remixArtifact(handle, user, remixMatch[1]);
    if (!remix) return notFound(res);
    return json(res, 201, artifactResponse(remix));
  }
  if (method === "POST" && url.pathname === "/api/admin/enable") {
    const user = requireApiUser(ctx, "admin");
    if (!user) return;
    setDisabled(handle, user, false);
    return json(res, 200, { disableArtifact: false });
  }
  if (method === "POST" && url.pathname === "/api/admin/disable") {
    const user = requireApiUser(ctx, "admin");
    if (!user) return;
    setDisabled(handle, user, true);
    return json(res, 200, { disableArtifact: true });
  }
  if (method === "POST" && url.pathname === "/api/admin/retention") {
    const user = requireApiUser(ctx, "admin");
    if (!user) return;
    const body = await bodyJson<{ privateDays?: number; sharedDays?: number; creatorRoles?: string[] }>(req);
    setRetention(handle, user, body.privateDays, body.sharedDays, body.creatorRoles);
    return json(res, 200, adminSettingsResponse(handle, user.orgId));
  }
  if (method === "POST" && url.pathname === "/api/admin/retention:run") {
    const user = requireApiUser(ctx, "admin");
    if (!user) return;
    return json(res, 200, runRetention(handle, user));
  }
  notFound(res);
}

async function complianceRoute(ctx: Context): Promise<void> {
  const { req, res, url, handle } = ctx;
  const method = req.method || "GET";
  const user = requireApiUser(ctx, method === "DELETE" ? "admin" : "viewer");
  if (!user) return;
  if (method === "GET" && url.pathname === "/v1/compliance/code/artifacts") {
    const status = url.searchParams.get("status") || undefined;
    const limit = Math.min(Number(url.searchParams.get("limit") || "50"), 200);
    const cursor = url.searchParams.get("cursor") || undefined;
    const items = listArtifacts(handle, user, true).filter((artifact) => !status || artifact.status === status);
    const start = cursor ? Math.max(0, Number(cursor)) : 0;
    const pageItems = items.slice(start, start + limit);
    const nextCursor = start + limit < items.length ? String(start + limit) : null;
    return json(res, 200, { items: pageItems.map(artifactResponse), nextCursor, hasMore: Boolean(nextCursor) });
  }
  if (method === "GET" && url.pathname === "/v1/compliance/code/audit-events") {
    if (!roleAtLeast(user.role, "admin")) return json(res, 403, { error: { code: "forbidden", message: "Requires admin role.", requestId: id("req") } });
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || "50"), 1), 200);
    const cursor = url.searchParams.get("cursor") || undefined;
    const action = url.searchParams.get("action") || undefined;
    const artifactId = url.searchParams.get("artifactId") || undefined;
    const response = auditEventsResponse(handle, user, { limit, cursor, action, artifactId });
    return json(res, 200, response);
  }
  const versionMatch = /^\/v1\/compliance\/code\/artifacts\/([^/]+)\/versions\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && versionMatch) {
    const artifact = loadArtifactForUser(handle, user, versionMatch[1], true);
    if (!artifact) return notFound(res);
    const version = loadVersion(handle, artifact.id, versionMatch[2]);
    if (!version) return notFound(res);
    return json(res, 200, { artifact: artifactResponse(artifact), version });
  }
  const deleteMatch = /^\/v1\/compliance\/code\/artifacts\/([^/]+)$/.exec(url.pathname);
  if (method === "DELETE" && deleteMatch) {
    const ok = setArtifactStatus(handle, user, deleteMatch[1], "deleted", true);
    return ok ? json(res, 204, null) : notFound(res);
  }
  notFound(res);
}

function publishArtifact(handle: DbHandle, user: User, title: string, type: ArtifactType, icon: string, audienceSpec: { audience: Audience; audienceUserId: string | null }, content: string, sourceType: string, sourcePath: string): ArtifactRecord {
  const ts = now();
  const artifactId = id("art");
  const versionId = id("ver");
  const html = renderArtifactDocument({ title, type, version: 1, updatedAt: ts, source: sourcePath, content });
  const artifact: ArtifactRecord = {
    id: artifactId,
    orgId: user.orgId,
    authorId: user.id,
    title,
    type,
    icon,
    visibility: "organization",
    status: "published",
    createdAt: ts,
    updatedAt: ts,
    latestVersionId: versionId,
    shareSlug: id("share"),
    shareMode: "latest",
    pinnedVersionId: null,
    audience: audienceSpec.audience,
    audienceUserId: audienceSpec.audienceUserId,
    approvedAt: ts
  };
  run(handle.db, "INSERT INTO artifacts (id, org_id, author_id, title, type, icon, visibility, status, created_at, updated_at, latest_version_id, share_slug, share_mode, pinned_version_id, audience, audience_user_id, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    artifact.id, artifact.orgId, artifact.authorId, artifact.title, artifact.type, artifact.icon, artifact.visibility, artifact.status,
    artifact.createdAt, artifact.updatedAt, artifact.latestVersionId, artifact.shareSlug, artifact.shareMode, artifact.pinnedVersionId, artifact.audience, artifact.audienceUserId, artifact.approvedAt
  ]);
  insertVersion(handle, artifact, versionId, 1, html, sourceType, sourcePath, ts);
  approveSource(handle, user, artifact.id, sourcePath);
  audit(handle, user.id, user.orgId, artifact.id, "publish", { title, type, audience: artifact.audience });
  handle.save();
  return artifact;
}

function updateArtifact(handle: DbHandle, user: User, artifactId: string, content: string, sourceType: string, sourcePath: string): ArtifactRecord | undefined {
  const artifact = loadArtifactForUser(handle, user, artifactId);
  if (!artifact || artifact.status !== "published") return undefined;
  const latest = getOne<{ n: number }>(handle.db, "SELECT COALESCE(MAX(version_number), 0) AS n FROM versions WHERE artifact_id = ?", [artifact.id])?.n || 0;
  const versionNumber = Number(latest) + 1;
  const ts = now();
  const versionId = id("ver");
  const html = renderArtifactDocument({ title: artifact.title, type: artifact.type, version: versionNumber, updatedAt: ts, source: sourcePath, content });
  insertVersion(handle, artifact, versionId, versionNumber, html, sourceType, sourcePath, ts);
  run(handle.db, "UPDATE artifacts SET updated_at = ?, latest_version_id = ? WHERE id = ?", [ts, versionId, artifact.id]);
  audit(handle, user.id, user.orgId, artifact.id, "update", { versionNumber });
  handle.save();
  return loadArtifactForUser(handle, user, artifactId);
}

function insertVersion(handle: DbHandle, artifact: ArtifactRecord, versionId: string, versionNumber: number, html: string, sourceType: string, sourcePath: string, createdAt: string): void {
  run(handle.db, "INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?, ?)", [versionId, artifact.id, versionNumber, html, sourceType, sourcePath, createdAt]);
  fs.writeFileSync(path.join(VERSION_DIR, `${artifact.id}-v${versionNumber}.html`), html);
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${artifact.id}.html`), html);
}

function setArtifactStatus(handle: DbHandle, user: User, artifactId: string, status: "unpublished" | "deleted", includeDeleted = false): boolean {
  const artifact = loadArtifactForUser(handle, user, artifactId, includeDeleted);
  if (!artifact) return false;
  run(handle.db, "UPDATE artifacts SET status = ?, updated_at = ? WHERE id = ?", [status, now(), artifact.id]);
  audit(handle, user.id, user.orgId, artifact.id, status === "deleted" ? "delete" : "unpublish", {});
  handle.save();
  return true;
}

function setDisabled(handle: DbHandle, user: User, disabled: boolean): void {
  run(handle.db, "UPDATE settings SET disable_artifact = ?, updated_at = ? WHERE org_id = ?", [disabled ? 1 : 0, now(), user.orgId]);
  writeConfig({ ...readConfig(), disableArtifact: disabled });
  audit(handle, user.id, user.orgId, null, disabled ? "admin_disable" : "admin_enable", {});
  handle.save();
}

function artifactSelect(): string {
  return `a.id, a.org_id AS orgId, a.author_id AS authorId, u.display_name AS authorName, a.title, a.type, a.icon, a.visibility, a.status,
          a.created_at AS createdAt, a.updated_at AS updatedAt, a.latest_version_id AS latestVersionId, a.share_slug AS shareSlug,
          a.share_mode AS shareMode, a.pinned_version_id AS pinnedVersionId, a.audience, a.audience_user_id AS audienceUserId, a.approved_at AS approvedAt`;
}

function loadArtifactForUser(handle: DbHandle, user: User, artifactId: string, includeDeleted = false, allowShared = false): ArtifactRecord | undefined {
  const params: unknown[] = [artifactId, user.orgId];
  if (!allowShared) params.push(user.id);
  return getOne<ArtifactRecord>(handle.db, `
    SELECT ${artifactSelect()}
    FROM artifacts a
    JOIN users u ON u.id = a.author_id
    WHERE a.id = ? AND a.org_id = ? ${includeDeleted ? "" : "AND a.status != 'deleted'"} ${allowShared ? "" : "AND (a.author_id = ? OR a.audience != 'private')"}
  `, params);
}

function loadArtifactBySlug(handle: DbHandle, user: User, slug: string): ArtifactRecord | undefined {
  const artifact = getOne<ArtifactRecord>(handle.db, `
    SELECT ${artifactSelect()}
    FROM artifacts a
    JOIN users u ON u.id = a.author_id
    WHERE a.share_slug = ? AND a.org_id = ? AND a.status = 'published'
  `, [slug, user.orgId]);
  if (!artifact) return undefined;
  return canViewAudience(artifact, user) ? artifact : undefined;
}

function loadPublicArtifactBySlug(handle: DbHandle, slug: string): ArtifactRecord | undefined {
  return getOne<ArtifactRecord>(handle.db, `
    SELECT ${artifactSelect()}
    FROM artifacts a
    JOIN users u ON u.id = a.author_id
    WHERE a.share_slug = ? AND a.status = 'published' AND a.audience = 'public'
  `, [slug]);
}

function listArtifacts(handle: DbHandle, user: User, includeDeleted = false): ArtifactRecord[] {
  return all<ArtifactRecord>(handle.db, `
    SELECT ${artifactSelect()}
    FROM artifacts a
    JOIN users u ON u.id = a.author_id
    WHERE a.org_id = ? ${includeDeleted ? "" : "AND a.status != 'deleted'"}
    ORDER BY a.updated_at DESC
  `, [user.orgId]).filter((artifact) => includeDeleted || artifact.authorId === user.id || canViewAudience(artifact, user));
}

function versionsFor(handle: DbHandle, artifactId: string): Omit<VersionRecord, "contentHtml">[] {
  return all<Omit<VersionRecord, "contentHtml">>(handle.db, `
    SELECT id, artifact_id AS artifactId, version_number AS versionNumber, source_type AS sourceType, source_path AS sourcePath, created_at AS createdAt
    FROM versions WHERE artifact_id = ? ORDER BY version_number DESC
  `, [artifactId]);
}

function loadVersion(handle: DbHandle, artifactId: string, versionRef: string): VersionRecord | undefined {
  const by = /^\d+$/.test(versionRef) ? "version_number" : "id";
  return getOne<VersionRecord>(handle.db, `
    SELECT id, artifact_id AS artifactId, version_number AS versionNumber, content_html AS contentHtml, source_type AS sourceType, source_path AS sourcePath, created_at AS createdAt
    FROM versions WHERE artifact_id = ? AND ${by} = ?
  `, [artifactId, by === "version_number" ? Number(versionRef) : versionRef]);
}

function artifactResponse(artifact: ArtifactRecord) {
  const baseUrl = publicBaseUrl();
  return {
    ...artifact,
    url: `${baseUrl}/artifacts/${artifact.id}`,
    shareUrl: `${baseUrl}/share/${artifact.shareSlug}`
  };
}

function shareResponse(artifact: ArtifactRecord) {
  const baseUrl = publicBaseUrl();
  return {
    artifactId: artifact.id,
    shareUrl: `${baseUrl}/share/${artifact.shareSlug}`,
    mode: artifact.shareMode,
    pinnedVersionId: artifact.pinnedVersionId,
    audience: artifact.audience,
    audienceUserId: artifact.audienceUserId
  };
}

function parseAudience(value: string): { audience: Audience; audienceUserId: string | null } {
  if (value.startsWith("user:")) return { audience: "specific_users", audienceUserId: value.slice("user:".length) };
  if (value === "private") return { audience: "private", audienceUserId: null };
  if (value === "public") return { audience: "public", audienceUserId: null };
  return { audience: "organization", audienceUserId: null };
}

function canViewAudience(artifact: ArtifactRecord, user: User): boolean {
  if (artifact.authorId === user.id) return true;
  if (artifact.audience === "public") return true;
  if (artifact.audience === "organization") return true;
  if (artifact.audience === "specific_users") return artifact.audienceUserId === user.id;
  return false;
}

function configureShare(handle: DbHandle, user: User, artifactId: string, modeInput: string, version: number | undefined, audienceInput: string): ArtifactRecord | undefined {
  const artifact = loadArtifactForUser(handle, user, artifactId, false, true);
  if (!artifact || artifact.authorId !== user.id && !roleAtLeast(user.role, "admin")) return undefined;
  const mode: ShareMode = modeInput === "version" || modeInput === "pinned_version" ? "pinned_version" : "latest";
  let pinnedVersionId: string | null = null;
  if (mode === "pinned_version") {
    const target = loadVersion(handle, artifact.id, String(version || 1));
    if (!target) return undefined;
    pinnedVersionId = target.id;
  }
  const audience = parseAudience(audienceInput);
  run(handle.db, "UPDATE artifacts SET share_mode = ?, pinned_version_id = ?, audience = ?, audience_user_id = ?, updated_at = ? WHERE id = ?", [
    mode,
    pinnedVersionId,
    audience.audience,
    audience.audienceUserId,
    now(),
    artifact.id
  ]);
  audit(handle, user.id, user.orgId, artifact.id, "share", { mode, version, audience: audienceInput });
  handle.save();
  return loadArtifactForUser(handle, user, artifact.id, false, true);
}

function approveArtifact(handle: DbHandle, user: User, artifactId: string): ArtifactRecord | undefined {
  const artifact = loadArtifactForUser(handle, user, artifactId, false, true);
  if (!artifact) return undefined;
  const ts = now();
  run(handle.db, "UPDATE artifacts SET approved_at = ?, updated_at = ? WHERE id = ?", [ts, ts, artifact.id]);
  approveSource(handle, user, artifact.id, artifact.id);
  audit(handle, user.id, user.orgId, artifact.id, "approve", {});
  handle.save();
  return loadArtifactForUser(handle, user, artifact.id, false, true);
}

function approveSource(handle: DbHandle, user: User, artifactId: string, sourceKey: string): void {
  run(handle.db, "INSERT INTO artifact_approvals VALUES (?, ?, ?, ?, ?, ?)", [id("appr"), user.id, user.orgId, sourceKey, artifactId, now()]);
}

function galleryResponse(handle: DbHandle, user: User) {
  const visible = listArtifacts(handle, user);
  return {
    mine: visible.filter((artifact) => artifact.authorId === user.id).map(artifactResponse),
    sharedWithMe: visible.filter((artifact) => artifact.authorId !== user.id).map(artifactResponse),
    recent: visible.slice(0, 20).map(artifactResponse),
    deleted: listArtifacts(handle, user, true).filter((artifact) => artifact.status === "deleted").map(artifactResponse),
    nextCursor: null
  };
}

function auditEventsResponse(handle: DbHandle, user: User, options: { limit: number; cursor?: string; action?: string; artifactId?: string }) {
  const clauses = ["org_id = ?"];
  const params: unknown[] = [user.orgId];
  if (options.action) {
    clauses.push("action = ?");
    params.push(options.action);
  }
  if (options.artifactId) {
    clauses.push("artifact_id = ?");
    params.push(options.artifactId);
  }
  const rows = all<AuditEventRecord>(handle.db, `
    SELECT id, actor_id AS actorId, org_id AS orgId, artifact_id AS artifactId, action, metadata, created_at AS createdAt
    FROM audit_events
    WHERE ${clauses.join(" AND ")}
    ORDER BY created_at DESC, id DESC
  `, params);
  const start = options.cursor ? Math.max(0, Number(options.cursor)) : 0;
  const items = rows.slice(start, start + options.limit).map((event) => ({
    ...event,
    metadata: safeJson(event.metadata)
  }));
  const nextCursor = start + options.limit < rows.length ? String(start + options.limit) : null;
  return { items, nextCursor, hasMore: Boolean(nextCursor) };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function publicBaseUrl(): string {
  return (process.env.CODEX_ARTIFACT_PUBLIC_BASE_URL || readConfig().publicBaseUrl || `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/$/, "");
}

function sessionMarkdown(body: { title?: string; summary?: string; changedFiles?: string[]; testOutput?: string; gitDiff?: string; project?: string }): string {
  const files = body.changedFiles?.length ? body.changedFiles.map((file) => `- ${file}`).join("\n") : "- No changed files captured.";
  return `# ${body.title || "Codex Session"}

## Summary

${body.summary || "No session summary provided."}

## Project

${body.project || "Unknown project"}

## Changed Files

${files}

## Test Output

\`\`\`
${body.testOutput || "No test output captured."}
\`\`\`

## Git Diff

\`\`\`diff
${body.gitDiff || "No git diff captured."}
\`\`\`
`;
}

function remixArtifact(handle: DbHandle, user: User, artifactId: string): ArtifactRecord | undefined {
  const source = loadArtifactForUser(handle, user, artifactId, false, true);
  if (!source || !canViewAudience(source, user)) return undefined;
  const version = loadVersion(handle, source.id, source.latestVersionId);
  if (!version) return undefined;
  const remix = publishArtifact(handle, user, `Remix of ${source.title}`, source.type, source.icon, parseAudience("private"), version.contentHtml, "remix", source.id);
  audit(handle, user.id, user.orgId, remix.id, "remix", { sourceArtifactId: source.id });
  handle.save();
  return remix;
}

function adminSettingsResponse(handle: DbHandle, orgId: string) {
  return getOne<{ disableArtifact: number; privateRetentionDays: number; sharedRetentionDays: number; creatorRoles: string }>(handle.db, "SELECT disable_artifact AS disableArtifact, private_retention_days AS privateRetentionDays, shared_retention_days AS sharedRetentionDays, creator_roles AS creatorRoles FROM settings WHERE org_id = ?", [orgId]);
}

function setRetention(handle: DbHandle, user: User, privateDays?: number, sharedDays?: number, creatorRoles?: string[]): void {
  const current = adminSettingsResponse(handle, user.orgId);
  run(handle.db, "UPDATE settings SET private_retention_days = ?, shared_retention_days = ?, creator_roles = ?, updated_at = ? WHERE org_id = ?", [
    Number.isFinite(privateDays) ? privateDays : current?.privateRetentionDays || 30,
    Number.isFinite(sharedDays) ? sharedDays : current?.sharedRetentionDays || 365,
    creatorRoles?.length ? creatorRoles.join(",") : current?.creatorRoles || "admin,creator",
    now(),
    user.orgId
  ]);
  audit(handle, user.id, user.orgId, null, "retention_update", { privateDays, sharedDays, creatorRoles });
  handle.save();
}

function runRetention(handle: DbHandle, user: User) {
  const settings = adminSettingsResponse(handle, user.orgId);
  const privateCutoff = Date.now() - (settings?.privateRetentionDays || 30) * 24 * 60 * 60 * 1000;
  const sharedCutoff = Date.now() - (settings?.sharedRetentionDays || 365) * 24 * 60 * 60 * 1000;
  const candidates = all<ArtifactRecord>(handle.db, `
    SELECT ${artifactSelect()}
    FROM artifacts a
    JOIN users u ON u.id = a.author_id
    WHERE a.org_id = ? AND a.status = 'published'
  `, [user.orgId]);
  let deleted = 0;
  for (const artifact of candidates) {
    const cutoff = artifact.audience === "private" ? privateCutoff : sharedCutoff;
    if (new Date(artifact.updatedAt).getTime() < cutoff) {
      run(handle.db, "UPDATE artifacts SET status = 'deleted', updated_at = ? WHERE id = ?", [now(), artifact.id]);
      audit(handle, user.id, user.orgId, artifact.id, "retention_delete", { audience: artifact.audience });
      deleted++;
    }
  }
  handle.save();
  return { deleted };
}

async function artifactsPage(ctx: Context, user: User): Promise<void> {
  const gallery = galleryResponse(ctx.handle, user);
  page(ctx.res, layout("Artifacts", user, `
    <section class="hero-panel">
      <div><p class="kicker">Organization Gallery</p><h1>Codex Artifacts</h1><p>Private local pages shared inside ${escapeText(user.orgId)}.</p></div>
      <div class="metric"><span>${gallery.mine.length + gallery.sharedWithMe.length}</span><small>visible artifacts</small></div>
    </section>
    <h2>Mine</h2>
    <section class="grid">${gallery.mine.map((item) => artifactCard(item)).join("") || `<p>No artifacts published yet.</p>`}</section>
    <h2>Shared with me</h2>
    <section class="grid">${gallery.sharedWithMe.map((item) => artifactCard(item)).join("") || `<p>No shared artifacts yet.</p>`}</section>
    <h2>Recent</h2>
    <section class="grid">${gallery.recent.map((item) => artifactCard(item)).join("") || `<p>No recent artifacts yet.</p>`}</section>
    <h2>Deleted</h2>
    <section class="grid">${gallery.deleted.map((item) => artifactCard(item)).join("") || `<p>No deleted artifacts.</p>`}</section>
  `));
}

function artifactCard(item: ReturnType<typeof artifactResponse>): string {
  return `
      <article class="artifact-card">
        <div class="card-top"><span>${escapeText(item.icon)} ${escapeText(item.type)}</span><span>${escapeText(item.audience)}</span></div>
        <h2>${escapeText(item.title)}</h2>
        <p>By ${escapeText(item.authorName || item.authorId)} · ${escapeText(item.updatedAt)}</p>
        <div class="actions"><a href="/artifacts/${item.id}">Open</a><a href="${item.shareUrl}">Share URL</a></div>
      </article>`;
}

async function artifactViewer(ctx: Context, user: User, artifactId: string, versionRef?: string): Promise<void> {
  const artifact = loadArtifactForUser(ctx.handle, user, artifactId);
  if (!artifact || artifact.status !== "published") return notFound(ctx.res);
  const version = versionRef ? loadVersion(ctx.handle, artifact.id, versionRef) : loadVersion(ctx.handle, artifact.id, artifact.latestVersionId);
  if (!version) return notFound(ctx.res);
  audit(ctx.handle, user.id, user.orgId, artifact.id, "view", { version: version.versionNumber });
  ctx.handle.save();
  renderViewer(ctx, user, artifact, version);
}

async function sharedViewer(ctx: Context, user: User | undefined, slug: string): Promise<void> {
  const artifact = user ? loadArtifactBySlug(ctx.handle, user, slug) : loadPublicArtifactBySlug(ctx.handle, slug);
  if (!artifact) return notFound(ctx.res);
  const versionRef = artifact.shareMode === "pinned_version" && artifact.pinnedVersionId ? artifact.pinnedVersionId : artifact.latestVersionId;
  const version = loadVersion(ctx.handle, artifact.id, versionRef);
  if (!version) return notFound(ctx.res);
  audit(ctx.handle, user?.id || "anonymous", artifact.orgId, artifact.id, "share_open", {});
  ctx.handle.save();
  renderViewer(ctx, user || { id: "anonymous", displayName: "anonymous", defaultOrgId: artifact.orgId, role: "viewer", orgId: artifact.orgId }, artifact, version);
}

function renderViewer(ctx: Context, user: User, artifact: ArtifactRecord, version: VersionRecord): void {
  const versions = versionsFor(ctx.handle, artifact.id);
  page(ctx.res, layout(artifact.title, user, `
    <section class="viewer-head">
      <div><p class="kicker">${escapeText(artifact.icon)} ${escapeText(artifact.type)} / ${escapeText(artifact.status)} / ${escapeText(artifact.audience)}</p><h1>${escapeText(artifact.title)}</h1><p>By ${escapeText(artifact.authorName || artifact.authorId)} · Share mode: <strong>${escapeText(artifact.shareMode)}</strong> · Stable share URL: <code>/share/${escapeText(artifact.shareSlug)}</code></p></div>
      <div class="actions"><a href="/artifacts">Gallery</a><a href="/share/${artifact.shareSlug}">Latest Share</a></div>
    </section>
    <section>
      <h2>Share</h2>
      <form method="post" action="/artifacts/${artifact.id}/share" class="inline-form">
        <label>Mode <select name="mode"><option value="latest"${artifact.shareMode === "latest" ? " selected" : ""}>Always share latest version</option><option value="version"${artifact.shareMode === "pinned_version" ? " selected" : ""}>Share selected version</option></select></label>
        <label>Version <input name="version" value="${version.versionNumber}" inputmode="numeric"></label>
        <label>Audience <select name="audience"><option value="private"${artifact.audience === "private" ? " selected" : ""}>Private</option><option value="organization"${artifact.audience === "organization" ? " selected" : ""}>Organization</option><option value="public"${artifact.audience === "public" ? " selected" : ""}>Public</option><option value="user:viewer"${artifact.audienceUserId === "viewer" ? " selected" : ""}>User: viewer</option></select></label>
        <button>Apply share settings</button>
      </form>
      <form method="post" action="/artifacts/${artifact.id}/remix"><button>Remix</button></form>
    </section>
    <section class="viewer-layout">
      <aside class="version-list">
        <h2>Versions</h2>
        ${versions.map((v) => `<a class="${v.id === version.id ? "active" : ""}" href="/artifacts/${artifact.id}/versions/${v.versionNumber}">v${v.versionNumber}<small>${escapeText(v.createdAt)}</small></a>`).join("")}
      </aside>
      <iframe title="${htmlAttr(artifact.title)}" sandbox="allow-scripts" srcdoc="${htmlAttr(version.contentHtml)}"></iframe>
    </section>
  `));
}

async function adminPage(ctx: Context, user: User): Promise<void> {
  if (!roleAtLeast(user.role, "admin")) return page(ctx.res, layout("Forbidden", user, `<section><h1>Admin only</h1></section>`), 403);
  const settings = getOne<{ disableArtifact: number; retentionDays: number; privateRetentionDays: number; sharedRetentionDays: number; creatorRoles: string; updatedAt: string }>(ctx.handle.db, "SELECT disable_artifact AS disableArtifact, retention_days AS retentionDays, private_retention_days AS privateRetentionDays, shared_retention_days AS sharedRetentionDays, creator_roles AS creatorRoles, updated_at AS updatedAt FROM settings WHERE org_id = ?", [user.orgId]);
  const events = all<{ action: string; actorId: string; artifactId: string; metadata: string; createdAt: string }>(ctx.handle.db, "SELECT action, actor_id AS actorId, artifact_id AS artifactId, metadata, created_at AS createdAt FROM audit_events WHERE org_id = ? ORDER BY created_at DESC LIMIT 40", [user.orgId]);
  page(ctx.res, layout("Admin", user, `
    <section class="hero-panel"><div><p class="kicker">Admin Console</p><h1>Artifact Controls</h1><p>Creation is currently <strong>${settings?.disableArtifact ? "disabled" : "enabled"}</strong>.</p></div></section>
    <section><form method="post" action="/admin/settings"><button name="disable" value="${settings?.disableArtifact ? "0" : "1"}">${settings?.disableArtifact ? "Enable" : "Disable"} artifacts</button></form></section>
    <section><h2>Retention and Roles</h2><form method="post" action="/admin/retention" class="inline-form"><label>Private days <input name="privateDays" value="${settings?.privateRetentionDays || 30}"></label><label>Shared days <input name="sharedDays" value="${settings?.sharedRetentionDays || 365}"></label><label>Creator roles <input name="creatorRoles" value="${escapeText(settings?.creatorRoles || "admin,creator")}"></label><button>Save retention</button></form><form method="post" action="/admin/retention-run"><button>Run cleanup</button></form></section>
    <section><h2>Audit Log</h2><table><tr><th>Time</th><th>Actor</th><th>Action</th><th>Artifact</th></tr>${events.map((e) => `<tr><td>${escapeText(e.createdAt)}</td><td>${escapeText(e.actorId)}</td><td>${escapeText(e.action)}</td><td>${escapeText(e.artifactId || "")}</td></tr>`).join("")}</table></section>
  `));
}

async function webShareSettings(ctx: Context, user: User, artifactId: string): Promise<void> {
  const form = new URLSearchParams(await bodyText(ctx.req));
  configureShare(ctx.handle, user, artifactId, form.get("mode") || "latest", Number(form.get("version") || "1"), form.get("audience") || "organization");
  redirect(ctx.res, `/artifacts/${artifactId}`);
}

async function webRemix(ctx: Context, user: User, artifactId: string): Promise<void> {
  const artifact = remixArtifact(ctx.handle, user, artifactId);
  if (!artifact) return notFound(ctx.res);
  redirect(ctx.res, `/artifacts/${artifact.id}`);
}

async function adminSettings(ctx: Context, user: User): Promise<void> {
  if (!roleAtLeast(user.role, "admin")) return page(ctx.res, layout("Forbidden", user, `<section><h1>Admin only</h1></section>`), 403);
  const body = await bodyText(ctx.req);
  setDisabled(ctx.handle, user, /disable=1/.test(body));
  redirect(ctx.res, "/admin");
}

async function adminRetentionForm(ctx: Context, user: User): Promise<void> {
  if (!roleAtLeast(user.role, "admin")) return page(ctx.res, layout("Forbidden", user, `<section><h1>Admin only</h1></section>`), 403);
  const form = new URLSearchParams(await bodyText(ctx.req));
  setRetention(ctx.handle, user, Number(form.get("privateDays") || "30"), Number(form.get("sharedDays") || "365"), String(form.get("creatorRoles") || "admin,creator").split(","));
  redirect(ctx.res, "/admin");
}

async function webLogin(ctx: Context): Promise<void> {
  const form = new URLSearchParams(await bodyText(ctx.req));
  const userName = form.get("user") || "";
  const user = findUser(ctx.handle.db, userName);
  if (!user) return page(ctx.res, loginPage("Unknown user."), 401);
  const token = id("sess");
  run(ctx.handle.db, "INSERT INTO sessions VALUES (?, ?, ?)", [token, user.id, now()]);
  audit(ctx.handle, user.id, user.orgId, null, "login", { surface: "web" });
  ctx.handle.save();
  ctx.res.setHeader("Set-Cookie", `codex_artifact_session=${token}; HttpOnly; SameSite=Lax; Path=/`);
  redirect(ctx.res, ctx.url.searchParams.get("next") || "/artifacts");
}

function logout(ctx: Context): void {
  ctx.res.setHeader("Set-Cookie", "codex_artifact_session=; Max-Age=0; Path=/");
  redirect(ctx.res, "/login");
}

function loginPage(error = ""): string {
  return base("Login", `
    <main class="login">
      <form method="post" action="/login">
        <p class="kicker">Local Organization</p>
        <h1>Codex Artifacts</h1>
        ${error ? `<p class="error">${escapeText(error)}</p>` : ""}
        <label>User <input name="user" value="admin" autocomplete="username"></label>
        <button>Enter</button>
        <p class="hint">Seed users: admin, creator, viewer, outsider.</p>
      </form>
    </main>
  `);
}

function layout(title: string, user: User, body: string): string {
  return base(title, `
    <nav class="topnav"><a href="/artifacts">Artifacts</a><a href="/admin">Admin</a><span>${escapeText(user.displayName)} / ${escapeText(user.role)}</span><a href="/logout">Logout</a></nav>
    <main>${body}</main>
  `);
}

function base(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeText(title)}</title><style>
    :root{--ink:#171717;--paper:#faf7ef;--line:#d8d0bd;--card:#fffdf8;--accent:#0f766e;--danger:#a33a2a;--muted:#6f6a5f}
    *{box-sizing:border-box}body{margin:0;background:linear-gradient(90deg,rgba(15,118,110,.07) 1px,transparent 1px) 0 0/30px 30px,var(--paper);color:var(--ink);font-family:Aptos,Segoe UI,sans-serif}a{color:inherit}.topnav{display:flex;gap:14px;align-items:center;border-bottom:3px solid var(--ink);padding:14px 20px;font-weight:800}.topnav span{margin-left:auto;color:var(--muted)}main{width:min(1180px,calc(100% - 28px));margin:24px auto 56px}.kicker{font-size:.78rem;font-weight:900;text-transform:uppercase;color:var(--accent)}h1{font:700 clamp(2.2rem,6vw,5rem)/.95 Georgia,serif;margin:0 0 12px}h2{font:700 1.5rem Georgia,serif}.hero-panel,.viewer-head,section{background:rgba(255,253,248,.86);border:1px solid var(--line);border-radius:8px;padding:20px;box-shadow:0 14px 34px rgba(0,0,0,.08);margin-bottom:18px}.hero-panel,.viewer-head{display:flex;justify-content:space-between;gap:20px}.metric span{display:block;font:700 4rem Georgia,serif}.metric small,.card-top,p{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;background:transparent;border:0;box-shadow:none;padding:0}.artifact-card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px}.card-top,.actions{display:flex;justify-content:space-between;gap:10px}.actions a,button{border:1px solid var(--ink);border-radius:8px;background:var(--ink);color:var(--paper);font-weight:900;padding:9px 12px;text-decoration:none;cursor:pointer}.viewer-layout{display:grid;grid-template-columns:220px 1fr;gap:16px;background:transparent;border:0;box-shadow:none;padding:0}.version-list{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px}.version-list a{display:block;border-radius:8px;padding:8px;text-decoration:none}.version-list a.active{background:var(--ink);color:var(--paper)}.version-list small{display:block;font-size:.72rem}iframe{width:100%;min-height:76vh;border:1px solid var(--line);border-radius:8px;background:white}table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--line);padding:8px;text-align:left}.login{display:grid;min-height:100vh;place-items:center}.login form{width:min(440px,calc(100vw - 28px));background:var(--card);border:1px solid var(--line);border-radius:8px;padding:24px;box-shadow:0 18px 44px rgba(0,0,0,.12)}label{display:grid;gap:6px;font-weight:800}input{border:1px solid var(--line);border-radius:8px;font:inherit;padding:10px}.error{color:var(--danger);font-weight:900}@media(max-width:760px){.hero-panel,.viewer-head,.viewer-layout{grid-template-columns:1fr;display:grid}.topnav{flex-wrap:wrap}.topnav span{margin-left:0}}
  </style></head><body>${body}</body></html>`;
}

async function bodyJson<T>(req: IncomingMessage): Promise<T> {
  return JSON.parse(await bodyText(req)) as T;
}

function bodyText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) reject(new Error("Request body too large."));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  if (value === null) {
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value, null, 2));
}

function page(res: ServerResponse, html: string, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}

function notFound(res: ServerResponse): void {
  json(res, 404, { error: { code: "not_found", message: "Resource not found.", requestId: id("req") } });
}

export async function runCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  if (!command || command === "help") return console.log(help());
  if (command === "serve") {
    const port = Number(flags.port || DEFAULT_PORT);
    await startServer(port);
    console.log(`Codex Artifacts listening on http://127.0.0.1:${port}`);
    return;
  }
  if (command === "login") {
    const user = String(flags.user || positionals[0] || "admin");
    fs.writeFileSync(SESSION_PATH, JSON.stringify({ user }, null, 2));
    console.log(`CLI user set to ${user}`);
    return;
  }
  if (command === "config") {
    const action = positionals[0];
    if (action === "hosted-url") {
      const value = String(flags.set || positionals[1] || "");
      const current = readConfig();
      if (value) {
        writeConfig({ ...current, publicBaseUrl: value.replace(/\/$/, "") });
        console.log(`Hosted URL set to ${value.replace(/\/$/, "")}`);
      } else {
        console.log(current.publicBaseUrl || "");
      }
      return;
    }
  }

  const session = readCliSession();
  const baseUrl = String(flags.host || `http://127.0.0.1:${DEFAULT_PORT}`);
  if (command === "publish") {
    const type = (flags.type || "dashboard") as ArtifactType;
    if (flags.from === "-" && !flags.type) throw new Error("stdin publish requires an explicit --type.");
    if (!flags.yes && !await confirmPublish(flags.title || "Codex Artifact")) throw new Error("Publish cancelled.");
    const input = sourceContent(flags.from, type, flags.from === "-" ? fs.readFileSync(0, "utf8") : undefined);
    const response = await request(baseUrl, "POST", "/api/artifacts", session.user, { title: flags.title || "Codex Artifact", type, icon: flags.icon || "◈", audience: flags.audience || "organization", approved: true, ...input });
    writeCliSession({ ...session, lastArtifactId: response.id });
    console.log(`Published ${response.id}`);
    console.log(response.shareUrl);
    if (process.env.CODEX_ARTIFACT_AUTO_OPEN !== "0") openBrowser(response.url);
    return;
  }
  if (command === "publish-session") {
    if (!flags.yes && !await confirmPublish(flags.title || "Codex Session")) throw new Error("Publish cancelled.");
    const sessionArtifact = captureSession(flags);
    const response = await request(baseUrl, "POST", "/api/artifacts/session", session.user, { ...sessionArtifact, approved: true });
    writeCliSession({ ...session, lastArtifactId: response.id });
    console.log(`Published ${response.id}`);
    console.log(response.shareUrl);
    if (process.env.CODEX_ARTIFACT_AUTO_OPEN !== "0") openBrowser(response.url);
    return;
  }
  if (command === "update") {
    const artifact = await request(baseUrl, "GET", `/api/artifacts/${positionals[0]}`, session.user);
    const input = sourceContent(flags.from, artifact.type as ArtifactType, flags.from === "-" ? fs.readFileSync(0, "utf8") : undefined);
    const response = await request(baseUrl, "PATCH", `/api/artifacts/${positionals[0]}`, session.user, input);
    writeCliSession({ ...session, lastArtifactId: response.id });
    console.log(`Updated ${response.id}`);
    console.log(response.shareUrl);
    return;
  }
  if (command === "list") {
    const response = await request(baseUrl, "GET", "/api/artifacts", session.user);
    console.table(response.items.map((i: Record<string, unknown>) => ({ id: i.id, title: i.title, type: i.type, status: i.status, url: i.url })));
    return;
  }
  if (command === "share") {
    if (flags.mode || flags.audience || flags.version) {
      const artifact = await request(baseUrl, "POST", `/api/artifacts/${positionals[0]}/share`, session.user, { mode: flags.mode || "latest", version: flags.version ? Number(flags.version) : undefined, audience: flags.audience || "organization" });
      console.log(artifact.shareUrl);
    } else {
      const artifact = await request(baseUrl, "GET", `/api/artifacts/${positionals[0]}`, session.user);
      console.log(artifact.shareUrl);
    }
    return;
  }
  if (command === "remix") {
    const response = await request(baseUrl, "POST", `/api/artifacts/${positionals[0]}/remix`, session.user, {});
    writeCliSession({ ...session, lastArtifactId: response.id });
    console.log(`Remixed ${response.id}`);
    console.log(response.shareUrl);
    return;
  }
  if (command === "open") {
    openBrowser(`${baseUrl}/artifacts/${positionals[0]}`);
    console.log(`${baseUrl}/artifacts/${positionals[0]}`);
    return;
  }
  if (command === "versions") {
    const response = await request(baseUrl, "GET", `/api/artifacts/${positionals[0]}/versions`, session.user);
    console.table(response.items);
    return;
  }
  if (command === "view") {
    const version = flags.version || "1";
    const url = `${baseUrl}/artifacts/${positionals[0]}/versions/${version}`;
    openBrowser(url);
    console.log(url);
    return;
  }
  if (command === "unpublish") {
    await request(baseUrl, "POST", `/api/artifacts/${positionals[0]}/unpublish`, session.user, {});
    console.log(`Unpublished ${positionals[0]}`);
    return;
  }
  if (command === "delete") {
    await request(baseUrl, "DELETE", `/api/artifacts/${positionals[0]}`, session.user);
    console.log(`Deleted ${positionals[0]}`);
    return;
  }
  if (command === "reopen") {
    if (!session.lastArtifactId) throw new Error("No last artifact recorded for this CLI user.");
    const url = `${baseUrl}/artifacts/${session.lastArtifactId}`;
    openBrowser(url);
    console.log(url);
    return;
  }
  if (command === "update-url") {
    const artifactId = extractArtifactIdFromUrl(positionals[0]);
    const artifact = await request(baseUrl, "GET", `/api/artifacts/${artifactId}`, session.user);
    const input = sourceContent(flags.from, artifact.type as ArtifactType, flags.from === "-" ? fs.readFileSync(0, "utf8") : undefined);
    const response = await request(baseUrl, "PATCH", `/api/artifacts/${artifactId}`, session.user, input);
    writeCliSession({ ...session, lastArtifactId: response.id });
    console.log(`Updated ${response.id}`);
    console.log(response.shareUrl);
    return;
  }
  if (command === "retention") {
    const action = positionals[0];
    if (action === "set") {
      const response = await request(baseUrl, "POST", "/api/admin/retention", session.user, { privateDays: flags["private-days"] ? Number(flags["private-days"]) : undefined, sharedDays: flags["shared-days"] ? Number(flags["shared-days"]) : undefined, creatorRoles: flags["creator-roles"] ? flags["creator-roles"].split(",") : undefined });
      console.log(JSON.stringify(response, null, 2));
      return;
    }
    if (action === "run") {
      const response = await request(baseUrl, "POST", "/api/admin/retention:run", session.user, {});
      console.log(JSON.stringify(response, null, 2));
      return;
    }
  }
  if (command === "admin") {
    const action = positionals[0] === "disable" ? "disable" : "enable";
    await request(baseUrl, "POST", `/api/admin/${action}`, session.user, {});
    console.log(`Artifacts ${action === "disable" ? "disabled" : "enabled"}`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

function parseArgs(args: string[]): { flags: Record<string, string>; positionals: string[] } {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const item = args[i];
    if (item.startsWith("--")) {
      flags[item.slice(2)] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "1";
    } else {
      positionals.push(item);
    }
  }
  return { flags, positionals };
}

function readCliSession(): { user: string; lastArtifactId?: string } {
  if (!fs.existsSync(SESSION_PATH)) fs.writeFileSync(SESSION_PATH, JSON.stringify({ user: "admin" }, null, 2));
  return JSON.parse(fs.readFileSync(SESSION_PATH, "utf8")) as { user: string; lastArtifactId?: string };
}

function writeCliSession(session: { user: string; lastArtifactId?: string }): void {
  fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
}

async function confirmPublish(title: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(`Publish artifact "${title}"? This may share project context. [y/N] `);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (chunk) => resolve(String(chunk).trim().toLowerCase()));
  });
  return answer === "y" || answer === "yes";
}

function extractArtifactIdFromUrl(value: string): string {
  if (!value) throw new Error("Missing artifact URL.");
  try {
    const url = new URL(value);
    const match = /^\/artifacts\/([^/]+)/.exec(url.pathname);
    if (match) return match[1];
  } catch {
    // fall through
  }
  return value;
}

function captureSession(flags: Record<string, string>): { title: string; summary: string; project: string; changedFiles: string[]; gitDiff: string; testOutput: string } {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  const runGit = (args: string[]) => {
    try {
      return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const status = runGit(["status", "--short"]);
  const changedFiles = status ? status.split(/\r?\n/).map((line) => line.slice(3).trim()).filter(Boolean) : [];
  const diff = runGit(["diff", "--", "."]);
  const project = flags.project || path.basename(process.cwd());
  const testOutput = flags["test-output"] ? fs.readFileSync(flags["test-output"], "utf8") : flags.tests || "";
  return {
    title: flags.title || `${project} Session`,
    summary: flags.summary || "Captured from the current Codex workspace.",
    project,
    changedFiles,
    gitDiff: diff || "No working-tree diff captured.",
    testOutput: testOutput || "No test output provided."
  };
}

async function request(baseUrl: string, method: string, routePath: string, user: string, body?: unknown): Promise<any> {
  const res = await fetch(new URL(routePath, baseUrl), {
    method,
    headers: { "Content-Type": "application/json", "X-Codex-User": user },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 204) return {};
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error?.message || `${method} ${routePath} failed with ${res.status}`);
  return data;
}

function openBrowser(url: string): void {
  if (process.env.CODEX_ARTIFACT_AUTO_OPEN === "0") return;
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

function help(): string {
  return `Codex Artifacts

Commands:
  artifact serve
  artifact login --user <admin|creator|viewer|outsider>
  artifact publish --title "..." --type dashboard --from <file|->
  artifact publish-session --title "..." --summary "..." --test-output <file> --yes
  artifact config hosted-url --set https://artifacts.example.com
  artifact update <id> --from <file|->
  artifact open <id>
  artifact share <id>
  artifact share <id> --mode latest|version --version <number> --audience private|organization|user:<name>
  artifact remix <id>
  artifact versions <id>
  artifact view <id> --version <number>
  artifact reopen
  artifact update-url <url> --from <file|->
  artifact retention set --private-days <n> --shared-days <n>
  artifact retention run
  artifact unpublish <id>
  artifact delete <id>
  artifact list
  artifact admin enable|disable`;
}
