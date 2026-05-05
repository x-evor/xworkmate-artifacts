import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const DEFAULT_MAX_FILES = 64;
const DEFAULT_MAX_INLINE_BYTES = 10 * 1024 * 1024;
const SKIPPED_DIRS = new Set([
    ".git",
    ".openclaw",
    ".pi",
    ".dart_tool",
    ".next",
    ".turbo",
    "build",
    "dist",
    "node_modules",
]);
export async function exportXWorkmateArtifacts(input) {
    const params = input.params ?? {};
    const pluginConfig = input.pluginConfig ?? {};
    const runId = optionalString(params.runId);
    if (!runId) {
        throw new Error("runId required");
    }
    const sessionKey = optionalString(params.sessionKey);
    if (!sessionKey) {
        throw new Error("sessionKey required");
    }
    const maxFiles = positiveInteger(params.maxFiles, pluginConfig.maxFiles, DEFAULT_MAX_FILES);
    const maxInlineBytes = positiveInteger(params.maxInlineBytes, pluginConfig.maxInlineBytes, DEFAULT_MAX_INLINE_BYTES);
    const sinceUnixMs = nonNegativeNumber(params.sinceUnixMs, 0);
    const workspaceDir = resolveWorkspaceDir({
        config: input.config,
        pluginConfig,
        params,
        sessionKey,
    });
    const workspaceRoot = await fs.realpath(workspaceDir);
    const warnings = [];
    const candidates = await collectCandidates({
        workspaceRoot,
        sinceUnixMs,
        warnings,
    });
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
        const artifact = {
            relativePath: candidate.relativePath,
            label: path.posix.basename(candidate.relativePath),
            contentType: contentTypeForPath(candidate.relativePath),
            sizeBytes: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
        };
        if (bytes.byteLength <= maxInlineBytes) {
            artifact.encoding = "base64";
            artifact.content = bytes.toString("base64");
        }
        else {
            warnings.push(`${candidate.relativePath} exceeds maxInlineBytes and was not inlined`);
        }
        artifacts.push(artifact);
    }
    return {
        runId,
        sessionKey,
        remoteWorkingDirectory: workspaceRoot,
        remoteWorkspaceRefKind: "remotePath",
        artifacts,
        warnings,
    };
}
async function collectCandidates(input) {
    const candidates = [];
    await walk(input.workspaceRoot);
    return candidates;
    async function walk(currentDir) {
        let entries;
        try {
            entries = await fs.readdir(currentDir, { withFileTypes: true });
        }
        catch (error) {
            input.warnings.push(`cannot read ${safeDisplayPath(input.workspaceRoot, currentDir)}: ${String(error)}`);
            return;
        }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            if (entry.name === "." || entry.name === "..") {
                continue;
            }
            const absolutePath = path.join(currentDir, entry.name);
            if (entry.isSymbolicLink()) {
                input.warnings.push(`skipped symlink ${safeDisplayPath(input.workspaceRoot, absolutePath)}`);
                continue;
            }
            if (entry.isDirectory()) {
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
            if (!isWithinRoot(input.workspaceRoot, realPath)) {
                input.warnings.push(`skipped path outside workspace ${entry.name}`);
                continue;
            }
            const relativePath = safeRelativePath(input.workspaceRoot, realPath);
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
function positiveInteger(primary, secondary, fallback) {
    for (const value of [primary, secondary]) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
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
function expandUserPath(value) {
    if (value === "~") {
        return os.homedir();
    }
    if (value.startsWith("~/")) {
        return path.join(os.homedir(), value.slice(2));
    }
    return path.resolve(value);
}
