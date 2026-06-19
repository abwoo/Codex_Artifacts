import fs from "node:fs";
import path from "node:path";
import { sourceContent } from "../artifacts/render";
import { ArtifactType, DEFAULT_PORT, SESSION_PATH, readConfig, writeConfig } from "../core/shared";
import { startServer } from "../server/app";

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
