# xworkmate-artifacts

OpenClaw Gateway plugin that exports structured workspace artifact manifests for XWorkmate.

## Why

XWorkmate talks to OpenClaw through `xworkmate-bridge` using the existing
`/gateway/openclaw` task contract. The bridge sends `chat.send`, waits for
`agent.wait`, then asks this plugin for a structured artifact manifest. The APP
can then sync generated files into its local thread workspace without changing
the UI or adding provider-specific routes.

It registers four Gateway methods:

```text
xworkmate.artifacts.prepare
xworkmate.artifacts.export
xworkmate.artifacts.list
xworkmate.artifacts.read
```

`prepare` creates a per-task artifact scope under the resolved OpenClaw workspace. `export`
and `read` then return safe, relative artifact entries that XWorkmate Bridge can normalize
into the APP `artifacts[]` contract.

## Install

Install from the npm package through OpenClaw:

```bash
openclaw plugins install xworkmate-artifacts
openclaw plugins enable xworkmate-artifacts
```

Or install from a Git checkout for development:

```bash
git clone https://github.com/x-evor/xworkmate-artifacts.git
openclaw plugins install --link ./xworkmate-artifacts
openclaw plugins enable xworkmate-artifacts
```

Equivalent config shape for a linked checkout:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/path/to/xworkmate-artifacts"
      ]
    },
    "entries": {
      "xworkmate-artifacts": {
        "enabled": true
      }
    }
  }
}
```

## Contract

Prepare request params:

```json
{
  "sessionKey": "thread-main",
  "runId": "turn-1"
}
```

Prepare response payload:

```json
{
  "runId": "turn-1",
  "sessionKey": "thread-main",
  "remoteWorkingDirectory": "/home/user/.openclaw/workspace",
  "remoteWorkspaceRefKind": "remotePath",
  "artifactScope": ".xworkmate/artifacts/tasks/thread-main-.../turn-1-...",
  "scopeKind": "task",
  "artifactDirectory": "/home/user/.openclaw/workspace/.xworkmate/artifacts/tasks/thread-main-.../turn-1-...",
  "relativeArtifactDirectory": ".xworkmate/artifacts/tasks/thread-main-.../turn-1-...",
  "warnings": []
}
```

Export request params:

```json
{
  "sessionKey": "thread-main",
  "runId": "turn-1",
  "artifactScope": ".xworkmate/artifacts/tasks/thread-main-.../turn-1-...",
  "sinceUnixMs": 1770000000000,
  "latestIfEmpty": true,
  "maxFiles": 64,
  "maxInlineBytes": 10485760
}
```

Export response payload:

```json
{
  "runId": "turn-1",
  "sessionKey": "thread-main",
  "remoteWorkingDirectory": "/home/user/.openclaw/workspace",
  "remoteWorkspaceRefKind": "remotePath",
  "artifactScope": ".xworkmate/artifacts/tasks/thread-main-.../turn-1-...",
  "scopeKind": "task",
  "artifacts": [
    {
      "relativePath": "reports/final.md",
      "label": "final.md",
      "contentType": "text/markdown",
      "sizeBytes": 1234,
      "sha256": "...",
      "artifactScope": ".xworkmate/artifacts/tasks/thread-main-.../turn-1-...",
      "scopeKind": "task"
    }
  ],
  "warnings": []
}
```

Files at or below `maxInlineBytes` also include `encoding: "base64"` and `content`.
When scoped export finds no task files and `latestIfEmpty` is true, the plugin scans
the workspace root for the latest real files and returns them with `scopeKind:
"workspace-latest"`. This is a controlled recovery path for existing files already
present in `/home/ubuntu/.openclaw/workspace`; it still skips plugin metadata and
runtime directories.

## View And Download

After installation, enable the optional agent tool if you want OpenClaw chat to
show a quick artifact table:

```json5
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": ["xworkmate_artifacts"]
        }
      }
    ]
  }
}
```

Then ask OpenClaw to list artifacts in the current workspace. The tool returns a
Markdown table with the workspace path, relative file paths, content types, file
sizes, and hash prefixes. Files are still stored in the OpenClaw workspace, so
local users can open or download them directly from that workspace path.

Gateway clients can use:

- `xworkmate.artifacts.prepare` before `chat.send` to allocate a task artifact directory.
- `xworkmate.artifacts.list` for a metadata-only manifest and Markdown table.
- `xworkmate.artifacts.read` with `artifactScope` and `relativePath` for one inline base64 file.
- `xworkmate.artifacts.export` with `artifactScope` after `agent.wait` for the XWorkmate APP sync path.

Large files are metadata-only in the export payload, but XWorkmate Bridge can
generate its own signed download URL and call `xworkmate.artifacts.read` as the
only remote file access path.

## Limits

- Only files inside the resolved OpenClaw workspace are exported.
- `.git`, `.openclaw`, `.xworkmate`, `.pi`, build outputs, and dependency folders are skipped when scanning the workspace root.
- Symlinks are skipped to avoid workspace escape.
- Files larger than `maxInlineBytes` are listed with metadata and a warning, but are not inlined.
- `artifactScope` and `relativePath` must be workspace-relative paths; absolute paths, `..`, empty path segments, and symlink escapes are rejected.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm pack:check
```
