# openclaw-multi-session-plugins

OpenClaw plugin for logical multi-session isolation and scoped XWorkmate artifact manifests.

## Why

XWorkmate talks to OpenClaw through `xworkmate-bridge` using the existing
`/gateway/openclaw` task contract. The bridge sends `chat.send`, waits for
`agent.wait`, then asks this plugin for a session/run-scoped artifact manifest.
The APP can then sync generated files into its local thread workspace without
changing the UI or adding provider-specific routes.

This plugin is not a scheduler. OpenClaw core owns sub-agents, multi-agent
routing, queues, cron, and cross-session execution. This package only adapts
those existing OpenClaw multi-task/session identities into isolated artifact
directories and signed artifact reads.

It registers four Gateway methods:

```text
xworkmate.artifacts.prepare
xworkmate.artifacts.export
xworkmate.artifacts.list
xworkmate.artifacts.read
```

`prepare` creates a per-task artifact scope under `tasks/` in the resolved OpenClaw workspace. `export`
and `read` then return safe, relative artifact entries that XWorkmate Bridge can normalize
into the APP `artifacts[]` contract.

## Install

Install from the npm package through OpenClaw:

```bash
openclaw plugins install openclaw-multi-session-plugins
openclaw plugins enable openclaw-multi-session-plugins
```

Or install from a Git checkout for development:

```bash
git clone https://github.com/x-evor/openclaw-multi-session-plugins.git
openclaw plugins install --link ./openclaw-multi-session-plugins
openclaw plugins enable openclaw-multi-session-plugins
```

Equivalent config shape for a linked checkout:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/path/to/openclaw-multi-session-plugins"
      ]
    },
    "entries": {
      "openclaw-multi-session-plugins": {
        "enabled": true
      }
    }
  }
}
```

## Contract

Prepare request params are supplied by the OpenClaw host, bridge, or APP
runtime. The plugin treats `sessionKey`, `runId`, and `workspaceDir` as the
trusted mapping into OpenClaw's built-in multi-session model; it does not parse
paths from chat text and does not invent fallback session/run identities.
Gateway methods accept these fields from bridge/app runtime params. The optional
agent tool does not expose these fields to the model; it only uses host-injected
tool context.

```json
{
  "sessionKey": "thread-main",
  "runId": "turn-1",
  "workspaceDir": "/home/user/.openclaw/workspace"
}
```

Prepare response payload:

```json
{
  "runId": "turn-1",
  "sessionKey": "thread-main",
  "remoteWorkingDirectory": "/home/user/.openclaw/workspace",
  "remoteWorkspaceRefKind": "remotePath",
  "artifactScope": "tasks/thread-main-.../turn-1-...",
  "scopeKind": "task",
  "artifactDirectory": "/home/user/.openclaw/workspace/tasks/thread-main-.../turn-1-...",
  "relativeArtifactDirectory": "tasks/thread-main-.../turn-1-...",
  "warnings": []
}
```

Export request params:

```json
{
  "sessionKey": "thread-main",
  "runId": "turn-1",
  "artifactScope": "tasks/thread-main-.../turn-1-...",
  "sinceUnixMs": 1770000000000,
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
  "artifactScope": "tasks/thread-main-.../turn-1-...",
  "scopeKind": "task",
  "artifacts": [
    {
      "relativePath": "reports/final.md",
      "label": "final.md",
      "contentType": "text/markdown",
      "sizeBytes": 1234,
      "sha256": "...",
      "artifactRef": "...",
      "artifactScope": "tasks/thread-main-.../turn-1-...",
      "scopeKind": "task"
    }
  ],
  "warnings": []
}
```

Files at or below `maxInlineBytes` also include `encoding: "base64"` and `content`.
When `artifactScope` is omitted, export/list defaults to the current task scope
derived from `sessionKey/runId`. If `sinceUnixMs` is provided, export also
adopts files created or changed in the workspace root during the current run by
copying them into that task scope before returning the manifest. This covers
agents that save output as `./file.md` while still keeping XWorkmate sync scoped
to `tasks/<session>/<run>`. Without `sinceUnixMs`, export/list only reads the
current task scope. The plugin never scans `tasks/` as a fallback and does not
borrow artifacts from earlier task scopes.

Each exported artifact includes `artifactRef`, a plugin-signed reference over
the issued session/run scope, artifact scope, path, size, and SHA-256 digest. `read` accepts
`artifactScope + relativePath` for the current `sessionKey/runId` task scope.
Signed task `artifactRef` values are accepted only for the same `sessionKey/runId`
that issued them. There is no unscoped arbitrary workspace read API.

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
          "allow": ["openclaw_multi_session_artifacts"]
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
- Pass the prepared `artifactScope`/`artifactDirectory` to `chat.send` and, if
  `chat.send` returns a different OpenClaw `runId`, prepare/export with that
  actual `runId` instead of the bridge request id.
- `xworkmate.artifacts.list` for a metadata-only manifest and Markdown table.
- `xworkmate.artifacts.read` with `artifactScope` and `relativePath` for one task file.
- `xworkmate.artifacts.read` with `artifactRef` for a plugin-returned task file.
- `xworkmate.artifacts.export` with `artifactScope` after `agent.wait` for the XWorkmate APP sync path.

Large files are metadata-only in the export payload, but XWorkmate Bridge can
generate its own signed download URL and call `xworkmate.artifacts.read` as the
only remote file access path.

## Limits

- Only files inside the resolved OpenClaw workspace are exported.
- `.git`, `.openclaw`, `.xworkmate`, `.pi`, build outputs, and dependency folders are excluded from task artifact exports.
- Workspace-root files are adopted only when `sinceUnixMs` is provided; adopted files are copied into the current `tasks/<safe-session-key>/<safe-run-id>` scope before listing or reading.
- Symlinks are skipped to avoid workspace escape.
- Files larger than `maxInlineBytes` are listed with metadata and a warning, but are not inlined.
- `artifactScope` must be `tasks/<safe-session-key>/<safe-run-id>`.
- `export` and `list` default to the current task scope when `artifactScope` is omitted.
- Direct `artifactScope + relativePath` reads and scoped exports must match the supplied `sessionKey/runId`.
- `artifactRef` is bound to the issued session/run and cannot be reused from another run.
- `artifactScope`, `artifactRef`, and `relativePath` must stay inside the workspace; absolute paths, `..`, empty path segments, and symlink escapes are rejected.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm pack:check
```
