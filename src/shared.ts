import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import initSqlJs, { Database } from "sql.js";

export const ROOT = path.resolve(__dirname, "..");
export const DATA_DIR = path.join(ROOT, "data");
export const DB_PATH = path.join(DATA_DIR, "codex-artifacts.sqlite");
export const ARTIFACT_DIR = path.join(ROOT, "artifacts");
export const VERSION_DIR = path.join(ARTIFACT_DIR, "versions");
export const TEMPLATE_DIR = path.join(ROOT, "templates");
export const CONFIG_PATH = path.join(ROOT, "artifact.config.json");
export const SESSION_PATH = path.join(ROOT, ".artifact-session.json");
export const DEFAULT_PORT = Number(process.env.CODEX_ARTIFACT_PORT || 4177);

export type Role = "admin" | "creator" | "viewer";
export type ArtifactType = "dashboard" | "pr" | "compare" | "tune";
export type Audience = "private" | "organization" | "specific_users" | "public";
export type ShareMode = "latest" | "pinned_version";

export interface User {
  id: string;
  displayName: string;
  defaultOrgId: string;
  role: Role;
  orgId: string;
}

export interface ArtifactRecord {
  id: string;
  orgId: string;
  authorId: string;
  authorName?: string;
  title: string;
  type: ArtifactType;
  icon: string;
  visibility: "organization";
  status: "published" | "unpublished" | "deleted";
  createdAt: string;
  updatedAt: string;
  latestVersionId: string;
  shareSlug: string;
  shareMode: ShareMode;
  pinnedVersionId: string | null;
  audience: Audience;
  audienceUserId: string | null;
  approvedAt: string | null;
}

export interface VersionRecord {
  id: string;
  artifactId: string;
  versionNumber: number;
  contentHtml: string;
  sourceType: string;
  sourcePath: string;
  createdAt: string;
}

export interface AuditEventRecord {
  id: string;
  actorId: string;
  orgId: string;
  artifactId: string | null;
  action: string;
  metadata: string;
  createdAt: string;
}

export interface DbHandle {
  db: Database;
  save(): void;
}

export function now(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function ensureLayout(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(VERSION_DIR, { recursive: true });
}

export async function openDb(): Promise<DbHandle> {
  ensureLayout();
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(ROOT, "node_modules", "sql.js", "dist", file)
  });
  const bytes = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : undefined;
  const db = new SQL.Database(bytes);
  const handle = {
    db,
    save() {
      fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
    }
  };
  migrate(handle);
  seed(handle);
  handle.save();
  return handle;
}

function migrate({ db }: DbHandle): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL UNIQUE,
      default_org_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memberships (
      user_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (user_id, org_id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      org_id TEXT PRIMARY KEY,
      disable_artifact INTEGER NOT NULL DEFAULT 0,
      retention_days INTEGER NOT NULL DEFAULT 365,
      private_retention_days INTEGER NOT NULL DEFAULT 30,
      shared_retention_days INTEGER NOT NULL DEFAULT 365,
      creator_roles TEXT NOT NULL DEFAULT 'admin,creator',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '◈',
      visibility TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      latest_version_id TEXT NOT NULL,
      share_slug TEXT NOT NULL UNIQUE,
      share_mode TEXT NOT NULL DEFAULT 'latest',
      pinned_version_id TEXT,
      audience TEXT NOT NULL DEFAULT 'organization',
      audience_user_id TEXT,
      approved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      content_html TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (artifact_id, version_number)
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      artifact_id TEXT,
      action TEXT NOT NULL,
      metadata TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifact_approvals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      artifact_id TEXT,
      approved_at TEXT NOT NULL
    );
  `);
  addColumnIfMissing(db, "settings", "private_retention_days", "INTEGER NOT NULL DEFAULT 30");
  addColumnIfMissing(db, "settings", "shared_retention_days", "INTEGER NOT NULL DEFAULT 365");
  addColumnIfMissing(db, "settings", "creator_roles", "TEXT NOT NULL DEFAULT 'admin,creator'");
  addColumnIfMissing(db, "artifacts", "icon", "TEXT NOT NULL DEFAULT '◈'");
  addColumnIfMissing(db, "artifacts", "share_mode", "TEXT NOT NULL DEFAULT 'latest'");
  addColumnIfMissing(db, "artifacts", "pinned_version_id", "TEXT");
  addColumnIfMissing(db, "artifacts", "audience", "TEXT NOT NULL DEFAULT 'organization'");
  addColumnIfMissing(db, "artifacts", "audience_user_id", "TEXT");
  addColumnIfMissing(db, "artifacts", "approved_at", "TEXT");
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  const existing = db.exec(`PRAGMA table_info(${table})`)[0]?.values?.map((row) => row[1]);
  if (!existing?.includes(column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function seed(handle: DbHandle): void {
  const org = getOne<{ count: number }>(handle.db, "SELECT COUNT(*) AS count FROM organizations");
  if (org?.count) return;
  const ts = now();
  run(handle.db, "INSERT INTO organizations (id, name) VALUES (?, ?)", ["org_local", "Local Codex Team"]);
  run(handle.db, "INSERT INTO organizations (id, name) VALUES (?, ?)", ["org_outside", "Outside Org"]);
  for (const [user, orgId, role] of [
    ["admin", "org_local", "admin"],
    ["creator", "org_local", "creator"],
    ["viewer", "org_local", "viewer"],
    ["outsider", "org_outside", "viewer"]
  ]) {
    run(handle.db, "INSERT INTO users (id, display_name, default_org_id) VALUES (?, ?, ?)", [user, user, orgId]);
    run(handle.db, "INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, ?)", [user, orgId, role]);
  }
  run(handle.db, "INSERT INTO settings (org_id, disable_artifact, retention_days, private_retention_days, shared_retention_days, creator_roles, updated_at) VALUES (?, 0, 365, 30, 365, 'admin,creator', ?)", ["org_local", ts]);
  run(handle.db, "INSERT INTO settings (org_id, disable_artifact, retention_days, private_retention_days, shared_retention_days, creator_roles, updated_at) VALUES (?, 0, 365, 30, 365, 'admin,creator', ?)", ["org_outside", ts]);
}

export function run(db: Database, sql: string, params: unknown[] = []): void {
  db.run(sql, params);
}

export function all<T>(db: Database, sql: string, params: unknown[] = []): T[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows: T[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
    return rows;
  } finally {
    stmt.free();
  }
}

export function getOne<T>(db: Database, sql: string, params: unknown[] = []): T | undefined {
  return all<T>(db, sql, params)[0];
}

export function audit(handle: DbHandle, actorId: string, orgId: string, artifactId: string | null, action: string, metadata: Record<string, unknown> = {}): void {
  run(handle.db, "INSERT INTO audit_events (id, actor_id, org_id, artifact_id, action, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    id("aud"),
    actorId,
    orgId,
    artifactId,
    action,
    JSON.stringify(metadata),
    now()
  ]);
}

export function readConfig(): { disableArtifact?: boolean; publicBaseUrl?: string; permissions?: { deny?: string[] } } {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as { disableArtifact?: boolean; publicBaseUrl?: string; permissions?: { deny?: string[] } };
  } catch {
    return {};
  }
}

export function writeConfig(config: { disableArtifact?: boolean; publicBaseUrl?: string; permissions?: { deny?: string[] } }): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function findUser(db: Database, name: string): User | undefined {
  return getOne<User>(db, `
    SELECT u.id, u.display_name AS displayName, u.default_org_id AS defaultOrgId, m.role, m.org_id AS orgId
    FROM users u
    JOIN memberships m ON m.user_id = u.id AND m.org_id = u.default_org_id
    WHERE u.id = ? OR u.display_name = ?
  `, [name, name]);
}

export function artifactDisabled(db: Database, orgId: string): boolean {
  const config = readConfig();
  if (process.env.CODEX_ARTIFACT_DISABLE === "1") return true;
  if (config.disableArtifact) return true;
  if (config.permissions?.deny?.includes("Artifact")) return true;
  const row = getOne<{ disabled: number }>(db, "SELECT disable_artifact AS disabled FROM settings WHERE org_id = ?", [orgId]);
  return Boolean(row?.disabled);
}

export function roleCanCreate(db: Database, orgId: string, role: Role): boolean {
  const row = getOne<{ creatorRoles: string }>(db, "SELECT creator_roles AS creatorRoles FROM settings WHERE org_id = ?", [orgId]);
  const allowed = (row?.creatorRoles || "admin,creator").split(",").map((item) => item.trim());
  return allowed.includes(role);
}

export function roleAtLeast(role: Role, needed: Role): boolean {
  const order: Record<Role, number> = { viewer: 1, creator: 2, admin: 3 };
  return order[role] >= order[needed];
}
