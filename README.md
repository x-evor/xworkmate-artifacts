# xworkmate-artifacts

OpenClaw Gateway plugin that exports structured workspace artifact manifests for XWorkmate.

## Why

XWorkmate talks to OpenClaw through `xworkmate-bridge` using the existing
`/gateway/openclaw` task contract. The bridge sends `chat.send`, waits for
`agent.wait`, then asks this plugin for a structured artifact manifest. The APP
can then sync generated files into its local thread workspace without changing
the UI or adding provider-specific routes.

It registers one Gateway method:

```text
xworkmate.artifacts.export
```

The method scans the resolved OpenClaw workspace after a run finishes and returns safe, relative artifact entries that XWorkmate Bridge can normalize into the APP `artifacts[]` contract.

## Install

Install from npm:

```bash
npm install -g xworkmate-artifacts
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

Request params:

```json
{
  "sessionKey": "thread-main",
  "runId": "turn-1",
  "sinceUnixMs": 1770000000000,
  "maxFiles": 64,
  "maxInlineBytes": 10485760
}
```

Response payload:

```json
{
  "runId": "turn-1",
  "sessionKey": "thread-main",
  "remoteWorkingDirectory": "/home/user/.openclaw/workspace",
  "remoteWorkspaceRefKind": "remotePath",
  "artifacts": [
    {
      "relativePath": "reports/final.md",
      "label": "final.md",
      "contentType": "text/markdown",
      "sizeBytes": 1234,
      "sha256": "..."
    }
  ],
  "warnings": []
}
```

Files at or below `maxInlineBytes` also include `encoding: "base64"` and `content`.

## Limits

- Only files inside the resolved OpenClaw workspace are exported.
- `.git`, `.openclaw`, `.pi`, build outputs, and dependency folders are skipped.
- Symlinks are skipped to avoid workspace escape.
- Files larger than `maxInlineBytes` are listed with metadata and a warning, but are not inlined.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm pack:check
```
