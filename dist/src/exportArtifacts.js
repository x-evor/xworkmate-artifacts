import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const DEFAULT_MAX_FILES = 64;
const DEFAULT_MAX_INLINE_BYTES = 10 * 1024 * 1024;
const TASK_SCOPE_ROOT = "tasks";
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
export async function prepareXWorkmateArtifacts(input) {
    const params = input.params ?? {};
    const pluginConfig = input.pluginConfig ?? {};
    const runId = requiredString(params.runId, "runId required");
    const sessionKey = requiredString(params.sessionKey, "sessionKey required");
    const expectedArtifactScope = artifactScopeFor(sessionKey, runId);
    const requestedArtifactScope = optionalArtifactScope(params.artifactScope);
    if (requestedArtifactScope && requestedArtifactScope !== expectedArtifactScope) {
        throw new Error("artifactScope does not match sessionKey/runId");
    }
    const workspaceDir = resolveWorkspaceDir({
        config: input.config,
        pluginConfig,
        params,
        sessionKey,
    });
    const workspaceRoot = await fs.realpath(workspaceDir);
    const artifactScope = expectedArtifactScope;
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
export async function exportXWorkmateArtifacts(input) {
    const params = input.params ?? {};
    const pluginConfig = input.pluginConfig ?? {};
    const runId = requiredString(params.runId, "runId required");
    const sessionKey = requiredString(params.sessionKey, "sessionKey required");
    const maxFiles = positiveInteger(params.maxFiles, pluginConfig.maxFiles, DEFAULT_MAX_FILES);
    const maxInlineBytes = nonNegativeInteger(params.maxInlineBytes, pluginConfig.maxInlineBytes, DEFAULT_MAX_INLINE_BYTES);
    const sinceUnixMs = nonNegativeNumber(params.sinceUnixMs, 0);
    const includeContent = optionalBoolean(params.includeContent, true);
    const workspaceDir = resolveWorkspaceDir({
        config: input.config,
        pluginConfig,
        params,
        sessionKey,
    });
    const workspaceRoot = await fs.realpath(workspaceDir);
    const warnings = [];
    const expectedArtifactScope = artifactScopeFor(sessionKey, runId);
    const requestedArtifactScope = optionalArtifactScope(params.artifactScope);
    if (requestedArtifactScope && requestedArtifactScope !== expectedArtifactScope) {
        throw new Error("artifactScope does not match sessionKey/runId");
    }
    const sessionScope = taskSessionScopeFor(sessionKey);
    const artifactScope = requestedArtifactScope || expectedArtifactScope;
    const scopeRoot = resolveScopeRoot(workspaceRoot, artifactScope);
    const scopeKind = "task";
    const scopePrepared = await directoryExists(scopeRoot);
    if (!scopePrepared && sinceUnixMs > 0) {
        await fs.mkdir(scopeRoot, { recursive: true });
    }
    const scopedCandidates = (await directoryExists(scopeRoot))
        ? await collectCandidates({
            scanRoot: scopeRoot,
            relativeRoot: scopeRoot,
            sinceUnixMs,
            skipTaskScopeRoot: false,
            warnings,
        })
        : [];
    const adoptedCandidates = sinceUnixMs > 0
        ? await adoptWorkspaceRootCandidatesIntoScope({
            workspaceRoot,
            scopeRoot,
            artifactScope,
            sinceUnixMs,
            existingRelativePaths: new Set(scopedCandidates.map((candidate) => candidate.relativePath)),
            warnings,
        })
        : [];
    const candidates = [...scopedCandidates, ...adoptedCandidates];
    if (!scopePrepared && candidates.length === 0) {
        warnings.push("artifact scope is not prepared for this task run");
    }
    candidates.sort((left, right) => {
        if (right.mtimeMs !== left.mtimeMs) {
            return right.mtimeMs - left.mtimeMs;
        }
        return left.relativePath.localeCompare(right.relativePath);
    });
    const artifacts = [];
    for (const candidate of candidates) {
        if (artifacts.length >= maxFiles) {
            warnings.push(`artifact limit reached; skipped remaining files after ${maxFiles}`);
            break;
        }
        const bytes = await fs.readFile(candidate.absolutePath);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const artifactScopeForCandidate = candidate.artifactScope || (scopeKind === "task" && artifactScope ? artifactScope : "");
        const scopeKindForCandidate = candidate.scopeKind || scopeKind;
        const artifact = {
            relativePath: candidate.relativePath,
            label: path.posix.basename(candidate.relativePath),
            contentType: contentTypeForPath(candidate.relativePath),
            sizeBytes: bytes.byteLength,
            sha256,
            artifactRef: signArtifactRef({
                v: 2,
                workspaceRootHash: workspaceRootHash(workspaceRoot),
                scopeKind: scopeKindForCandidate,
                sessionScope,
                runScope: expectedArtifactScope,
                ...(artifactScopeForCandidate ? { artifactScope: artifactScopeForCandidate } : {}),
                relativePath: candidate.relativePath,
                sizeBytes: bytes.byteLength,
                sha256,
            }, pluginConfig),
            scopeKind: scopeKindForCandidate,
        };
        if (artifactScopeForCandidate) {
            artifact.artifactScope = artifactScopeForCandidate;
        }
        if (includeContent && bytes.byteLength <= maxInlineBytes) {
            artifact.encoding = "base64";
            artifact.content = bytes.toString("base64");
        }
        else if (includeContent) {
            warnings.push(`${candidate.relativePath} exceeds maxInlineBytes and was not inlined`);
        }
        artifacts.push(artifact);
    }
    const result = {
        runId,
        sessionKey,
        remoteWorkingDirectory: workspaceRoot,
        remoteWorkspaceRefKind: "remotePath",
        artifactScope,
        scopeKind,
        artifacts,
        warnings,
    };
    return {
        ...result,
        manifestMarkdown: formatArtifactManifestMarkdown(result),
    };
}
export async function readXWorkmateArtifact(input) {
    const params = input.params ?? {};
    const pluginConfig = input.pluginConfig ?? {};
    const runId = requiredString(params.runId, "runId required");
    const sessionKey = requiredString(params.sessionKey, "sessionKey required");
    const expectedArtifactScope = artifactScopeFor(sessionKey, runId);
    const expectedSessionScope = taskSessionScopeFor(sessionKey);
    const requestedArtifactRef = optionalString(params.artifactRef);
    let relativePath = "";
    let artifactScope = optionalArtifactScope(params.artifactScope);
    let refPayload;
    const maxInlineBytes = nonNegativeInteger(params.maxInlineBytes, pluginConfig.maxInlineBytes, DEFAULT_MAX_INLINE_BYTES);
    const workspaceDir = resolveWorkspaceDir({
        config: input.config,
        pluginConfig,
        params,
        sessionKey,
    });
    const workspaceRoot = await fs.realpath(workspaceDir);
    if (requestedArtifactRef) {
        refPayload = verifyArtifactRef(requestedArtifactRef, workspaceRoot, pluginConfig);
        assertArtifactRefMatchesRequest(refPayload, expectedArtifactScope, expectedSessionScope);
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
        assertArtifactScopeMatchesRequest(artifactScope, expectedArtifactScope);
    }
    else {
        if (!artifactScope) {
            throw new Error("artifactScope or artifactRef required");
        }
        assertArtifactScopeMatchesRequest(artifactScope, expectedArtifactScope);
        relativePath = safeInputRelativePath(params.relativePath, "relativePath");
    }
    const scopeRoot = artifactScope ? resolveScopeRoot(workspaceRoot, artifactScope) : workspaceRoot;
    const scopeKind = refPayload?.scopeKind ?? "task";
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
    const artifact = {
        relativePath: safeRelativePath(scopeRoot, realPath),
        label: path.posix.basename(relativePath),
        contentType: contentTypeForPath(relativePath),
        sizeBytes: bytes.byteLength,
        sha256,
        artifactRef: requestedArtifactRef ||
            signArtifactRef({
                v: 2,
                workspaceRootHash: workspaceRootHash(workspaceRoot),
                scopeKind,
                sessionScope: expectedSessionScope,
                runScope: expectedArtifactScope,
                ...(artifactScope ? { artifactScope } : {}),
                relativePath: safeRelativePath(scopeRoot, realPath),
                sizeBytes: bytes.byteLength,
                sha256,
            }, pluginConfig),
        scopeKind,
    };
    if (artifactScope) {
        artifact.artifactScope = artifactScope;
    }
    const warnings = [];
    if (bytes.byteLength <= maxInlineBytes) {
        artifact.encoding = "base64";
        artifact.content = bytes.toString("base64");
    }
    else {
        warnings.push(`${artifact.relativePath} exceeds maxInlineBytes and was not inlined`);
    }
    const result = {
        runId,
        sessionKey,
        remoteWorkingDirectory: workspaceRoot,
        remoteWorkspaceRefKind: "remotePath",
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
export function formatArtifactManifestMarkdown(input) {
    const lines = [
        "## XWorkmate artifacts",
        "",
        `Workspace: \`${input.remoteWorkingDirectory}\``,
        input.artifactScope ? `Artifact scope: \`${input.artifactScope}\`` : `Artifact scope: \`${input.scopeKind ?? "workspace"}\``,
        "",
    ];
    if (input.artifacts.length === 0) {
        lines.push("No artifacts found for this task run.");
    }
    else {
        lines.push("| File | Type | Size | SHA-256 | Inline |");
        lines.push("| --- | --- | ---: | --- | --- |");
        for (const artifact of input.artifacts) {
            lines.push(`| \`${escapeMarkdownCell(artifact.relativePath)}\` | ${escapeMarkdownCell(artifact.contentType)} | ${formatBytes(artifact.sizeBytes)} | \`${artifact.sha256.slice(0, 12)}\` | ${artifact.encoding === "base64" ? "yes" : "no"} |`);
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
async function adoptWorkspaceRootCandidatesIntoScope(input) {
    const rootCandidates = await collectCandidates({
        scanRoot: input.workspaceRoot,
        relativeRoot: input.workspaceRoot,
        sinceUnixMs: input.sinceUnixMs,
        skipTaskScopeRoot: true,
        warnings: input.warnings,
    });
    const adopted = [];
    for (const candidate of rootCandidates) {
        if (input.existingRelativePaths.has(candidate.relativePath)) {
            continue;
        }
        const targetPath = path.join(input.scopeRoot, candidate.relativePath.split("/").join(path.sep));
        if (!isWithinRoot(input.scopeRoot, targetPath)) {
            input.warnings.push(`skipped path outside task scope ${candidate.relativePath}`);
            continue;
        }
        if (await fileExists(targetPath)) {
            input.existingRelativePaths.add(candidate.relativePath);
            continue;
        }
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.copyFile(candidate.absolutePath, targetPath);
        const stat = await fs.stat(targetPath);
        const realPath = await fs.realpath(targetPath);
        adopted.push({
            absolutePath: realPath,
            relativePath: candidate.relativePath,
            sizeBytes: stat.size,
            mtimeMs: candidate.mtimeMs,
            artifactScope: input.artifactScope,
            scopeKind: "task",
        });
        input.existingRelativePaths.add(candidate.relativePath);
    }
    return adopted;
}
async function collectCandidates(input) {
    const candidates = [];
    await walk(input.scanRoot);
    return candidates;
    async function walk(currentDir) {
        let entries;
        try {
            entries = await fs.readdir(currentDir, { withFileTypes: true });
        }
        catch (error) {
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
function artifactScopeFor(sessionKey, runId) {
    return [taskSessionScopeFor(sessionKey), safeScopeSegment(runId)].join("/");
}
function taskSessionScopeFor(sessionKey) {
    return [TASK_SCOPE_ROOT, safeScopeSegment(sessionKey)].join("/");
}
function assertArtifactScopeMatchesRequest(artifactScope, expectedArtifactScope) {
    if (artifactScope === expectedArtifactScope) {
        return;
    }
    throw new Error("artifactScope does not match sessionKey/runId");
}
function assertArtifactRefMatchesRequest(payload, expectedRunScope, expectedSessionScope) {
    if (payload.sessionScope !== expectedSessionScope || payload.runScope !== expectedRunScope) {
        throw new Error("artifactRef does not match sessionKey/runId");
    }
}
function safeScopeSegment(value) {
    return value
        .trim()
        .replace(/[\\/]+/g, "_")
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/^[._-]+|[._-]+$/g, "")
        .slice(0, 96) || "scope";
}
function optionalArtifactScope(value) {
    const scope = optionalString(value);
    if (!scope) {
        return "";
    }
    return safeTaskArtifactScope(scope);
}
function safeTaskArtifactScope(value) {
    const scope = safeInputRelativePath(value, "artifactScope");
    const parts = scope.split("/");
    const rootParts = TASK_SCOPE_ROOT.split("/");
    const scopeRoot = parts.slice(0, rootParts.length).join("/");
    if (parts.length !== rootParts.length + 2 || scopeRoot !== TASK_SCOPE_ROOT) {
        throw new Error("artifactScope must be a task artifact scope");
    }
    return scope;
}
function safeTaskSessionScope(value) {
    const raw = optionalString(value);
    if (!raw) {
        throw new Error("invalid artifactRef");
    }
    let scope;
    try {
        scope = safeInputRelativePath(raw, "artifactRef sessionScope");
    }
    catch {
        throw new Error("invalid artifactRef");
    }
    const parts = scope.split("/");
    const rootParts = TASK_SCOPE_ROOT.split("/");
    const scopeRoot = parts.slice(0, rootParts.length).join("/");
    if (parts.length !== rootParts.length + 1 || scopeRoot !== TASK_SCOPE_ROOT) {
        throw new Error("invalid artifactRef");
    }
    return scope;
}
async function directoryExists(absolutePath) {
    try {
        const stat = await fs.stat(absolutePath);
        return stat.isDirectory();
    }
    catch {
        return false;
    }
}
async function fileExists(absolutePath) {
    try {
        const stat = await fs.stat(absolutePath);
        return stat.isFile();
    }
    catch {
        return false;
    }
}
function safeArtifactRefRunScope(value) {
    try {
        return safeTaskArtifactScope(value);
    }
    catch {
        throw new Error("invalid artifactRef");
    }
}
function safeInputRelativePath(value, label) {
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
function resolveScopeRoot(workspaceRoot, artifactScope) {
    const normalizedScope = safeTaskArtifactScope(artifactScope);
    const scopeRoot = path.join(workspaceRoot, normalizedScope.split("/").join(path.sep));
    if (!isWithinRoot(workspaceRoot, scopeRoot)) {
        throw new Error("artifactScope must stay inside the workspace");
    }
    return scopeRoot;
}
function resolveWorkspaceDir(input) {
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
    const selected = (agentId ? agentList.find((entry) => optionalString(entry.id) === agentId) : undefined) ??
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
function agentIdFromSessionKey(sessionKey) {
    const parts = sessionKey.split(":");
    if (parts.length >= 3 && parts[0] === "agent") {
        return parts[1]?.trim() ?? "";
    }
    return "";
}
function safeRelativePath(root, target) {
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
function safeDisplayPath(root, target) {
    return safeRelativePath(root, target) || path.basename(target);
}
function isWithinRoot(root, target) {
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function contentTypeForPath(relativePath) {
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
function objectRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function optionalString(value) {
    return typeof value === "string" ? value.trim() : "";
}
function requiredString(value, message) {
    const resolved = optionalString(value);
    if (!resolved) {
        throw new Error(message);
    }
    return resolved;
}
function optionalBoolean(value, fallback) {
    if (typeof value === "boolean") {
        return value;
    }
    return fallback;
}
function positiveInteger(primary, secondary, fallback) {
    for (const value of [primary, secondary]) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
            return Math.floor(numeric);
        }
    }
    return fallback;
}
function nonNegativeInteger(primary, secondary, fallback) {
    for (const value of [primary, secondary]) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric >= 0) {
            return Math.floor(numeric);
        }
    }
    return fallback;
}
function nonNegativeNumber(value, fallback) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) {
        return numeric;
    }
    return fallback;
}
function signArtifactRef(payload, pluginConfig) {
    const body = base64UrlEncode(JSON.stringify(payload));
    const signature = createHmac("sha256", artifactRefSigningSecret(pluginConfig)).update(body).digest("base64url");
    return `${body}.${signature}`;
}
function verifyArtifactRef(artifactRef, workspaceRoot, pluginConfig) {
    const [body, signature, ...extra] = artifactRef.split(".");
    if (!body || !signature || extra.length > 0) {
        throw new Error("invalid artifactRef");
    }
    const expectedSignature = createHmac("sha256", artifactRefSigningSecret(pluginConfig)).update(body).digest("base64url");
    if (!constantTimeEqual(signature, expectedSignature)) {
        throw new Error("invalid artifactRef");
    }
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    }
    catch {
        throw new Error("invalid artifactRef");
    }
    const payload = objectRecord(parsed);
    const scopeKind = optionalString(payload.scopeKind);
    if (scopeKind !== "task") {
        throw new Error("invalid artifactRef");
    }
    const relativePath = safeInputRelativePath(payload.relativePath, "artifactRef relativePath");
    const artifactScope = optionalArtifactScope(payload.artifactScope);
    if (scopeKind === "task" && !artifactScope) {
        throw new Error("invalid artifactRef");
    }
    const sizeBytes = nonNegativeInteger(payload.sizeBytes, undefined, -1);
    const sha256 = optionalString(payload.sha256).toLowerCase();
    if (payload.v !== 2 || sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(sha256)) {
        throw new Error("invalid artifactRef");
    }
    const sessionScope = safeTaskSessionScope(payload.sessionScope);
    const runScope = safeArtifactRefRunScope(payload.runScope);
    if (!runScope.startsWith(`${sessionScope}/`)) {
        throw new Error("invalid artifactRef");
    }
    if (optionalString(payload.workspaceRootHash) !== workspaceRootHash(workspaceRoot)) {
        throw new Error("artifactRef does not match workspace");
    }
    return {
        v: 2,
        workspaceRootHash: workspaceRootHash(workspaceRoot),
        scopeKind,
        sessionScope,
        runScope,
        ...(artifactScope ? { artifactScope } : {}),
        relativePath,
        sizeBytes,
        sha256,
    };
}
function artifactRefSigningSecret(pluginConfig) {
    return (optionalString(pluginConfig.artifactRefSigningSecret) ||
        optionalString(process.env.XWORKMATE_ARTIFACT_REF_SIGNING_SECRET) ||
        optionalString(process.env.XWORKMATE_ARTIFACT_DOWNLOAD_SIGNING_SECRET) ||
        GENERATED_ARTIFACT_REF_SECRET);
}
function workspaceRootHash(workspaceRoot) {
    return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex");
}
function base64UrlEncode(value) {
    return Buffer.from(value, "utf8").toString("base64url");
}
function constantTimeEqual(left, right) {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
function expandUserPath(value) {
    if (value === "~") {
        return os.homedir();
    }
    if (value.startsWith("~/")) {
        return path.join(os.homedir(), value.slice(2));
    }
    return path.resolve(value);
}
function formatBytes(sizeBytes) {
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
function escapeMarkdownCell(value) {
    return value.replaceAll("|", "\\|");
}
