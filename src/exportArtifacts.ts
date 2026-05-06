import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_FILES = 64;
const DEFAULT_MAX_INLINE_BYTES = 10 * 1024 * 1024;
const TASK_SCOPE_ROOT = ".xworkmate/artifacts/tasks";
const GENERATED_ARTIFACT_REF_SECRET = randomBytes(32).toString("hex");

const SKIPPED_DIRS = new Set([
  ".git",
  ".openclaw",
  ".xworkmate",
  ".pi",
  ".dart_tool",
  ".next",
  ".turbo",
  "build",
  "dist",
  "node_modules",
]);

export type XWorkmateArtifact = {
  relativePath: string;
  label: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  artifactRef: string;
  artifactScope?: string;
  scopeKind?: XWorkmateArtifactScopeKind;
  encoding?: "base64";
  content?: string;
};

export type XWorkmateArtifactScopeKind = "task" | "workspace" | "workspace-latest";

export type XWorkmateArtifactExport = {
  runId: string;
  sessionKey: string;
  remoteWorkingDirectory: string;
  remoteWorkspaceRefKind: "remotePath";
  artifactScope?: string;
  scopeKind: XWorkmateArtifactScopeKind;
  artifacts: XWorkmateArtifact[];
  warnings: string[];
  manifestMarkdown: string;
};

export type XWorkmateArtifactPrepare = {
  runId: string;
  sessionKey: string;
  remoteWorkingDirectory: string;
  remoteWorkspaceRefKind: "remotePath";
  artifactScope: string;
  scopeKind: "task";
  artifactDirectory: string;
  relativeArtifactDirectory: string;
  warnings: string[];
};

type ExportInput = {
  params: Record<string, unknown>;
  config?: unknown;
  pluginConfig?: Record<string, unknown>;
};

type ReadInput = {
  params: Record<string, unknown>;
  config?: unknown;
  pluginConfig?: Record<string, unknown>;
};

type ArtifactRefPayload = {
  v: 1;
  workspaceRootHash: string;
  scopeKind: XWorkmateArtifactScopeKind;
  artifactScope?: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
};

type Candidate = {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
};

export async function prepareXWorkmateArtifacts(input: ExportInput): Promise<XWorkmateArtifactPrepare> {
  const params = input.params ?? {};
  const pluginConfig = input.pluginConfig ?? {};
  const runId = requiredString(params.runId, "runId required");
  const sessionKey = requiredString(params.sessionKey, "sessionKey required");
  const workspaceDir = resolveWorkspaceDir({
    config: input.config,
    pluginConfig,
    params,
    sessionKey,
  });
  const workspaceRoot = await fs.realpath(workspaceDir);
  const artifactScope = artifactScopeFor(sessionKey, runId);
  const scopeRoot = resolveScopeRoot(workspaceRoot, artifactScope);
  await fs.mkdir(scopeRoot, { recursive: true });
  return {
    runId,
    sessionKey,
    remoteWorkingDirectory: workspaceRoot,
    remoteWorkspaceRefKind: "remotePath",
    artifactScope,
    scopeKind: "task",
    artifactDirectory: scopeRoot,
    relativeArtifactDirectory: artifactScope,
    warnings: [],
  };
}

export async function exportXWorkmateArtifacts(input: ExportInput): Promise<XWorkmateArtifactExport> {
  const params = input.params ?? {};
  const pluginConfig = input.pluginConfig ?? {};
  const runId = requiredString(params.runId, "runId required");
  const sessionKey = requiredString(params.sessionKey, "sessionKey required");

  const maxFiles = positiveInteger(params.maxFiles, pluginConfig.maxFiles, DEFAULT_MAX_FILES);
  const maxInlineBytes = nonNegativeInteger(
    params.maxInlineBytes,
    pluginConfig.maxInlineBytes,
    DEFAULT_MAX_INLINE_BYTES,
  );
  const sinceUnixMs = nonNegativeNumber(params.sinceUnixMs, 0);
  const includeContent = optionalBoolean(params.includeContent, true);
  const latestIfEmpty = optionalBoolean(params.latestIfEmpty, false);
  const workspaceDir = resolveWorkspaceDir({
    config: input.config,
    pluginConfig,
    params,
    sessionKey,
  });
  const workspaceRoot = await fs.realpath(workspaceDir);
  const warnings: string[] = [];
  const artifactScope = optionalArtifactScope(params.artifactScope);
  const scopeRoot = artifactScope ? resolveScopeRoot(workspaceRoot, artifactScope) : workspaceRoot;
  const scopedExport = artifactScope !== "";
  let scopeKind: XWorkmateArtifactScopeKind = scopedExport ? "task" : "workspace";
  let candidates = await collectCandidates({
    scanRoot: scopeRoot,
    relativeRoot: scopeRoot,
    sinceUnixMs,
    skipTaskScopeRoot: !scopedExport,
    warnings,
  });

  if (candidates.length === 0 && latestIfEmpty) {
    const latestWarnings: string[] = [];
    const latestCandidates = await collectCandidates({
      scanRoot: workspaceRoot,
      relativeRoot: workspaceRoot,
      sinceUnixMs: 0,
      skipTaskScopeRoot: true,
      warnings: latestWarnings,
    });
    if (latestCandidates.length > 0) {
      warnings.push(...latestWarnings);
      if (scopedExport) {
        warnings.push("scoped artifact directory is empty; exported latest workspace files instead");
      }
      candidates = latestCandidates;
      scopeKind = "workspace-latest";
    }
  }

  candidates.sort((left, right) => {
    if (right.mtimeMs !== left.mtimeMs) {
      return right.mtimeMs - left.mtimeMs;
    }
    return left.relativePath.localeCompare(right.relativePath);
  });

  const artifacts: XWorkmateArtifact[] = [];
  for (const candidate of candidates) {
    if (artifacts.length >= maxFiles) {
      warnings.push(`artifact limit reached; skipped remaining files after ${maxFiles}`);
      break;
    }
    const bytes = await fs.readFile(candidate.absolutePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifact: XWorkmateArtifact = {
      relativePath: candidate.relativePath,
      label: path.posix.basename(candidate.relativePath),
      contentType: contentTypeForPath(candidate.relativePath),
      sizeBytes: bytes.byteLength,
      sha256,
      artifactRef: signArtifactRef(
        {
          v: 1,
          workspaceRootHash: workspaceRootHash(workspaceRoot),
          scopeKind,
          ...(scopeKind === "task" && artifactScope ? { artifactScope } : {}),
          relativePath: candidate.relativePath,
          sizeBytes: bytes.byteLength,
          sha256,
        },
        pluginConfig,
      ),
      scopeKind,
    };
    if (scopeKind === "task" && artifactScope) {
      artifact.artifactScope = artifactScope;
    }
    if (includeContent && bytes.byteLength <= maxInlineBytes) {
      artifact.encoding = "base64";
      artifact.content = bytes.toString("base64");
    } else if (includeContent) {
      warnings.push(`${candidate.relativePath} exceeds maxInlineBytes and was not inlined`);
    }
    artifacts.push(artifact);
  }

  const result = {
    runId,
    sessionKey,
    remoteWorkingDirectory: workspaceRoot,
    remoteWorkspaceRefKind: "remotePath" as const,
    ...(scopeKind === "task" && artifactScope ? { artifactScope } : {}),
    scopeKind,
    artifacts,
    warnings,
  };
  return {
    ...result,
    manifestMarkdown: formatArtifactManifestMarkdown(result),
  };
}

export async function readXWorkmateArtifact(input: ReadInput): Promise<XWorkmateArtifactExport> {
  const params = input.params ?? {};
  const pluginConfig = input.pluginConfig ?? {};
  const runId = optionalString(params.runId) || "read";
  const sessionKey = requiredString(params.sessionKey, "sessionKey required");
  const requestedArtifactRef = optionalString(params.artifactRef);
  let relativePath = "";
  let artifactScope = optionalArtifactScope(params.artifactScope);
  let refPayload: ArtifactRefPayload | undefined;
  const maxInlineBytes = nonNegativeInteger(
    params.maxInlineBytes,
    pluginConfig.maxInlineBytes,
    DEFAULT_MAX_INLINE_BYTES,
  );
  const workspaceDir = resolveWorkspaceDir({
    config: input.config,
    pluginConfig,
    params,
    sessionKey,
  });
  const workspaceRoot = await fs.realpath(workspaceDir);
  if (requestedArtifactRef) {
    refPayload = verifyArtifactRef(requestedArtifactRef, workspaceRoot, pluginConfig);
    relativePath = refPayload.relativePath;
    if (refPayload.artifactScope) {
      artifactScope = refPayload.artifactScope;
    }
    const requestedPath = optionalString(params.relativePath);
    if (requestedPath && safeInputRelativePath(requestedPath, "relativePath") !== relativePath) {
      throw new Error("artifactRef does not match relativePath");
    }
    const requestedScope = optionalArtifactScope(params.artifactScope);
    if (requestedScope && requestedScope !== artifactScope) {
      throw new Error("artifactRef does not match artifactScope");
    }
  } else {
    if (!artifactScope) {
      throw new Error("artifactScope or artifactRef required");
    }
    relativePath = safeInputRelativePath(params.relativePath, "relativePath");
  }
  const scopeRoot = artifactScope ? resolveScopeRoot(workspaceRoot, artifactScope) : workspaceRoot;
  const scopeKind: XWorkmateArtifactScopeKind = refPayload?.scopeKind ?? "task";
  const absolutePath = path.join(scopeRoot, relativePath.split("/").join(path.sep));
  const realPath = await fs.realpath(absolutePath);
  if (!isWithinRoot(scopeRoot, realPath)) {
    throw new Error("relativePath must stay inside the workspace");
  }
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) {
    throw new Error("relativePath must point to a file");
  }
  const bytes = await fs.readFile(realPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (refPayload && (refPayload.sizeBytes !== bytes.byteLength || refPayload.sha256 !== sha256)) {
    throw new Error("artifactRef does not match file content");
  }
  const artifact: XWorkmateArtifact = {
    relativePath: safeRelativePath(scopeRoot, realPath),
    label: path.posix.basename(relativePath),
    contentType: contentTypeForPath(relativePath),
    sizeBytes: bytes.byteLength,
    sha256,
    artifactRef:
      requestedArtifactRef ||
      signArtifactRef(
        {
          v: 1,
          workspaceRootHash: workspaceRootHash(workspaceRoot),
          scopeKind,
          ...(artifactScope ? { artifactScope } : {}),
          relativePath: safeRelativePath(scopeRoot, realPath),
          sizeBytes: bytes.byteLength,
          sha256,
        },
        pluginConfig,
      ),
    scopeKind,
  };
  if (artifactScope) {
    artifact.artifactScope = artifactScope;
  }
  const warnings: string[] = [];
  if (bytes.byteLength <= maxInlineBytes) {
    artifact.encoding = "base64";
    artifact.content = bytes.toString("base64");
  } else {
    warnings.push(`${artifact.relativePath} exceeds maxInlineBytes and was not inlined`);
  }
  const result = {
    runId,
    sessionKey,
    remoteWorkingDirectory: workspaceRoot,
    remoteWorkspaceRefKind: "remotePath" as const,
    ...(artifactScope ? { artifactScope } : {}),
    scopeKind,
    artifacts: [artifact],
    warnings,
  };
  return {
    ...result,
    manifestMarkdown: formatArtifactManifestMarkdown(result),
  };
}

export function formatArtifactManifestMarkdown(input: {
  remoteWorkingDirectory: string;
  artifactScope?: string;
  scopeKind?: XWorkmateArtifactScopeKind;
  artifacts: XWorkmateArtifact[];
  warnings: string[];
}): string {
  const lines = [
    "## XWorkmate artifacts",
    "",
    `Workspace: \`${input.remoteWorkingDirectory}\``,
    input.artifactScope ? `Artifact scope: \`${input.artifactScope}\`` : `Artifact scope: \`${input.scopeKind ?? "workspace"}\``,
    "",
  ];
  if (input.artifacts.length === 0) {
    lines.push("No artifacts found.");
  } else {
    lines.push("| File | Type | Size | SHA-256 | Inline |");
    lines.push("| --- | --- | ---: | --- | --- |");
    for (const artifact of input.artifacts) {
      lines.push(
        `| \`${escapeMarkdownCell(artifact.relativePath)}\` | ${escapeMarkdownCell(artifact.contentType)} | ${formatBytes(
          artifact.sizeBytes,
        )} | \`${artifact.sha256.slice(0, 12)}\` | ${artifact.encoding === "base64" ? "yes" : "no"} |`,
      );
    }
  }
  if (input.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of input.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  return lines.join("\n");
}

async function collectCandidates(input: {
  scanRoot: string;
  relativeRoot: string;
  sinceUnixMs: number;
  skipTaskScopeRoot: boolean;
  warnings: string[];
}): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  await walk(input.scanRoot);
  return candidates;

  async function walk(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      input.warnings.push(`cannot read ${safeDisplayPath(input.relativeRoot, currentDir)}: ${String(error)}`);
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") {
        continue;
      }
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        input.warnings.push(`skipped symlink ${safeDisplayPath(input.relativeRoot, absolutePath)}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (input.skipTaskScopeRoot && currentDir === input.relativeRoot && entry.name === TASK_SCOPE_ROOT) {
          continue;
        }
        if (SKIPPED_DIRS.has(entry.name)) {
          continue;
        }
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = await fs.stat(absolutePath);
      const changedAtMs = Math.max(stat.mtimeMs, stat.ctimeMs);
      if (changedAtMs < input.sinceUnixMs) {
        continue;
      }
      const realPath = await fs.realpath(absolutePath);
      if (!isWithinRoot(input.relativeRoot, realPath)) {
        input.warnings.push(`skipped path outside workspace ${entry.name}`);
        continue;
      }
      const relativePath = safeRelativePath(input.relativeRoot, realPath);
      if (!relativePath) {
        continue;
      }
      candidates.push({
        absolutePath: realPath,
        relativePath,
        sizeBytes: stat.size,
        mtimeMs: changedAtMs,
      });
    }
  }
}

function artifactScopeFor(sessionKey: string, runId: string): string {
  return [
    TASK_SCOPE_ROOT,
    safeScopeSegment(sessionKey),
    safeScopeSegment(runId),
  ].join("/");
}

function safeScopeSegment(value: string): string {
  const normalized = value
    .trim()
    .replaceAll(path.sep, "_")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 48);
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${normalized || "scope"}-${digest}`;
}

function optionalArtifactScope(value: unknown): string {
  const scope = optionalString(value);
  if (!scope) {
    return "";
  }
  return safeTaskArtifactScope(scope);
}

function safeTaskArtifactScope(value: unknown): string {
  const scope = safeInputRelativePath(value, "artifactScope");
  const parts = scope.split("/");
  const rootParts = TASK_SCOPE_ROOT.split("/");
  const scopeRoot = parts.slice(0, rootParts.length).join("/");
  if (parts.length !== rootParts.length + 2 || scopeRoot !== TASK_SCOPE_ROOT) {
    throw new Error("artifactScope must be a task artifact scope");
  }
  return scope;
}

function safeInputRelativePath(value: unknown, label: string): string {
  const relativePath = optionalString(value);
  if (!relativePath) {
    throw new Error(`${label} required`);
  }
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error(`${label} must stay inside the workspace`);
  }
  const normalized = relativePath.split(/[\\/]/).filter(Boolean).join("/");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error(`${label} must stay inside the workspace`);
  }
  return normalized;
}

function resolveScopeRoot(workspaceRoot: string, artifactScope: string): string {
  const normalizedScope = safeTaskArtifactScope(artifactScope);
  const scopeRoot = path.join(workspaceRoot, normalizedScope.split("/").join(path.sep));
  if (!isWithinRoot(workspaceRoot, scopeRoot)) {
    throw new Error("artifactScope must stay inside the workspace");
  }
  return scopeRoot;
}

function resolveWorkspaceDir(input: {
  config?: unknown;
  pluginConfig: Record<string, unknown>;
  params: Record<string, unknown>;
  sessionKey: string;
}): string {
  const explicit = optionalString(input.params.workspaceDir) || optionalString(input.pluginConfig.workspaceDir);
  if (explicit) {
    return expandUserPath(explicit);
  }
  const config = objectRecord(input.config);
  const agents = objectRecord(config.agents);
  const agentList = Array.isArray(agents.list)
    ? agents.list.map(objectRecord).filter((entry) => Object.keys(entry).length > 0)
    : [];
  const agentId = agentIdFromSessionKey(input.sessionKey);
  const selected =
    (agentId ? agentList.find((entry) => optionalString(entry.id) === agentId) : undefined) ??
    agentList.find((entry) => entry.default === true) ??
    agentList[0];
  const selectedWorkspace = selected ? optionalString(selected.workspace) : "";
  if (selectedWorkspace) {
    return expandUserPath(selectedWorkspace);
  }
  const defaults = objectRecord(agents.defaults);
  const defaultWorkspace = optionalString(defaults.workspace);
  if (defaultWorkspace) {
    return expandUserPath(defaultWorkspace);
  }
  const profile = process.env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(os.homedir(), ".openclaw", `workspace-${profile}`);
  }
  return path.join(os.homedir(), ".openclaw", "workspace");
}

function agentIdFromSessionKey(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length >= 3 && parts[0] === "agent") {
    return parts[1]?.trim() ?? "";
  }
  return "";
}

function safeRelativePath(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return "";
  }
  const normalized = relative.split(path.sep).join(path.posix.sep);
  if (normalized.split("/").some((part) => part === ".." || part === "")) {
    return "";
  }
  return normalized;
}

function safeDisplayPath(root: string, target: string): string {
  return safeRelativePath(root, target) || path.basename(target);
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function contentTypeForPath(relativePath: string): string {
  switch (path.extname(relativePath).toLowerCase()) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".html":
    case ".htm":
      return "text/html";
    case ".pdf":
      return "application/pdf";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredString(value: unknown, message: string): string {
  const resolved = optionalString(value);
  if (!resolved) {
    throw new Error(message);
  }
  return resolved;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function positiveInteger(primary: unknown, secondary: unknown, fallback: number): number {
  for (const value of [primary, secondary]) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric);
    }
  }
  return fallback;
}

function nonNegativeInteger(primary: unknown, secondary: unknown, fallback: number): number {
  for (const value of [primary, secondary]) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.floor(numeric);
    }
  }
  return fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric;
  }
  return fallback;
}

function signArtifactRef(payload: ArtifactRefPayload, pluginConfig: Record<string, unknown>): string {
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", artifactRefSigningSecret(pluginConfig)).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyArtifactRef(
  artifactRef: string,
  workspaceRoot: string,
  pluginConfig: Record<string, unknown>,
): ArtifactRefPayload {
  const [body, signature, ...extra] = artifactRef.split(".");
  if (!body || !signature || extra.length > 0) {
    throw new Error("invalid artifactRef");
  }
  const expectedSignature = createHmac("sha256", artifactRefSigningSecret(pluginConfig)).update(body).digest("base64url");
  if (!constantTimeEqual(signature, expectedSignature)) {
    throw new Error("invalid artifactRef");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid artifactRef");
  }
  const payload = objectRecord(parsed);
  const scopeKind = optionalString(payload.scopeKind) as XWorkmateArtifactScopeKind;
  if (!["task", "workspace", "workspace-latest"].includes(scopeKind)) {
    throw new Error("invalid artifactRef");
  }
  const relativePath = safeInputRelativePath(payload.relativePath, "artifactRef relativePath");
  const artifactScope = optionalArtifactScope(payload.artifactScope);
  if (scopeKind === "task" && !artifactScope) {
    throw new Error("invalid artifactRef");
  }
  if (scopeKind !== "task" && artifactScope) {
    throw new Error("invalid artifactRef");
  }
  const sizeBytes = nonNegativeInteger(payload.sizeBytes, undefined, -1);
  const sha256 = optionalString(payload.sha256).toLowerCase();
  if (payload.v !== 1 || sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("invalid artifactRef");
  }
  if (optionalString(payload.workspaceRootHash) !== workspaceRootHash(workspaceRoot)) {
    throw new Error("artifactRef does not match workspace");
  }
  return {
    v: 1,
    workspaceRootHash: workspaceRootHash(workspaceRoot),
    scopeKind,
    ...(artifactScope ? { artifactScope } : {}),
    relativePath,
    sizeBytes,
    sha256,
  };
}

function artifactRefSigningSecret(pluginConfig: Record<string, unknown>): string {
  return (
    optionalString(pluginConfig.artifactRefSigningSecret) ||
    optionalString(process.env.XWORKMATE_ARTIFACT_REF_SIGNING_SECRET) ||
    optionalString(process.env.XWORKMATE_ARTIFACT_DOWNLOAD_SIGNING_SECRET) ||
    GENERATED_ARTIFACT_REF_SECRET
  );
}

function workspaceRootHash(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex");
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function expandUserPath(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  const kib = sizeBytes / 1024;
  if (kib < 1024) {
    return `${Math.round(kib)} KB`;
  }
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll("|", "\\|");
}
