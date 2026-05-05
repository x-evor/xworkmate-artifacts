import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportXWorkmateArtifacts } from "./exportArtifacts.js";

describe("exportXWorkmateArtifacts", () => {
  it("exports changed files with metadata and base64 content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-xworkmate-artifacts-"));
    await fs.mkdir(path.join(root, "reports"), { recursive: true });
    const filePath = path.join(root, "reports", "final.md");
    await fs.writeFile(filePath, "# Done\n");
    const stat = await fs.stat(filePath);

    const result = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "thread-main",
        runId: "run-1",
        sinceUnixMs: stat.mtimeMs - 1,
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.remoteWorkingDirectory).toBe(await fs.realpath(root));
    expect(result.remoteWorkspaceRefKind).toBe("remotePath");
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      relativePath: "reports/final.md",
      label: "final.md",
      contentType: "text/markdown",
      sizeBytes: Buffer.byteLength("# Done\n"),
      sha256: createHash("sha256").update("# Done\n").digest("hex"),
      encoding: "base64",
      content: Buffer.from("# Done\n").toString("base64"),
    });
  });

  it("filters old files by sinceUnixMs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-xworkmate-artifacts-"));
    const oldFile = path.join(root, "old.txt");
    await fs.writeFile(oldFile, "old");
    const stat = await fs.stat(oldFile);

    const result = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "thread-main",
        runId: "run-1",
        sinceUnixMs: stat.mtimeMs + 10_000,
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.artifacts).toEqual([]);
  });

  it("skips excluded directories and symlinks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-xworkmate-artifacts-"));
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git", "secret.txt"), "secret");
    await fs.writeFile(path.join(root, "real.txt"), "real");
    await fs.symlink(path.join(root, "real.txt"), path.join(root, "linked.txt"));

    const result = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "thread-main",
        runId: "run-1",
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.artifacts.map((entry) => entry.relativePath)).toEqual(["real.txt"]);
    expect(result.warnings.some((entry) => entry.includes("linked.txt"))).toBe(true);
  });

  it("leaves oversized artifacts out of inline content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-xworkmate-artifacts-"));
    await fs.writeFile(path.join(root, "large.pdf"), Buffer.from("large-content"));

    const result = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "thread-main",
        runId: "run-1",
        maxInlineBytes: 2,
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.artifacts[0]?.relativePath).toBe("large.pdf");
    expect(result.artifacts[0]?.encoding).toBeUndefined();
    expect(result.artifacts[0]?.content).toBeUndefined();
    expect(result.warnings).toContain("large.pdf exceeds maxInlineBytes and was not inlined");
  });

  it("limits exported files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-xworkmate-artifacts-"));
    await fs.writeFile(path.join(root, "a.txt"), "a");
    await fs.writeFile(path.join(root, "b.txt"), "b");

    const result = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "thread-main",
        runId: "run-1",
        maxFiles: 1,
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.artifacts).toHaveLength(1);
    expect(result.warnings).toContain("artifact limit reached; skipped remaining files after 1");
  });

  it("selects an agent workspace from agent session keys", async () => {
    const mainRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-xworkmate-main-"));
    const agentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-xworkmate-agent-"));
    await fs.writeFile(path.join(mainRoot, "main.txt"), "main");
    await fs.writeFile(path.join(agentRoot, "agent.txt"), "agent");

    const result = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "agent:research:thread-1",
        runId: "run-1",
      },
      config: {
        agents: {
          defaults: { workspace: mainRoot },
          list: [{ id: "research", workspace: agentRoot }],
        },
      },
    });

    expect(result.artifacts.map((entry) => entry.relativePath)).toEqual(["agent.txt"]);
  });
});
