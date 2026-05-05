# openclaw-xworkmate-artifacts

OpenClaw Gateway plugin that exports structured workspace artifact manifests for XWorkmate.

It registers one Gateway method:

```text
xworkmate.artifacts.export
```

The method scans the resolved OpenClaw workspace after a run finishes and returns safe, relative artifact entries that XWorkmate Bridge can normalize into the APP `artifacts[]` contract.

## Install locally

Link this directory into OpenClaw:

```bash
openclaw plugins install --link /Users/shenlan/workspaces/cloud-neutral-toolkit/openclaw-xworkmate-artifacts
openclaw plugins enable openclaw-xworkmate-artifacts
```

Equivalent config shape:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/Users/shenlan/workspaces/cloud-neutral-toolkit/openclaw-xworkmate-artifacts"
      ]
    },
    "entries": {
      "openclaw-xworkmate-artifacts": {
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
