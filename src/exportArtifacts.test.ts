import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportXWorkmateArtifacts, readXWorkmateArtifact } from "./exportArtifacts.js";

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
    expect(result.manifestMarkdown).toContain("reports/final.md");
    expect(result.manifestMarkdown).toContain("text/markdown");
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

  it("can list artifacts without inline content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-xworkmate-artifacts-"));
    await fs.writeFile(path.join(root, "small.txt"), "small");

    const result = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "thread-main",
        runId: "run-1",
        maxInlineBytes: 0,
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.artifacts[0]?.relativePath).toBe("small.txt");
    expect(result.artifacts[0]?.encoding).toBeUndefined();
    expect(result.artifacts[0]?.content).toBeUndefined();
    expect(result.warnings).toContain("small.txt exceeds maxInlineBytes and was not inlined");
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

  it("reads one artifact by relative path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-xworkmate-artifacts-"));
    await fs.mkdir(path.join(root, "reports"), { recursive: true });
    await fs.writeFile(path.join(root, "reports", "final.txt"), "final");

    const result = await readXWorkmateArtifact({
      params: {
        sessionKey: "thread-main",
        runId: "run-1",
        relativePath: "reports/final.txt",
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      relativePath: "reports/final.txt",
      contentType: "text/plain",
      encoding: "base64",
      content: Buffer.from("final").toString("base64"),
    });
  });

  it("reads artifact metadata without inline content when the file exceeds the limit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-xworkmate-artifacts-"));
    await fs.writeFile(path.join(root, "large.bin"), Buffer.from("large-content"));

    const result = await readXWorkmateArtifact({
      params: {
        sessionKey: "thread-main",
        runId: "run-1",
        relativePath: "large.bin",
        maxInlineBytes: 2,
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      relativePath: "large.bin",
      contentType: "application/octet-stream",
      sizeBytes: Buffer.byteLength("large-content"),
      sha256: createHash("sha256").update("large-content").digest("hex"),
    });
    expect(result.artifacts[0]?.encoding).toBeUndefined();
    expect(result.artifacts[0]?.content).toBeUndefined();
    expect(result.warnings).toContain("large.bin exceeds maxInlineBytes and was not inlined");
  });

  it("rejects relative path traversal when reading artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-xworkmate-artifacts-"));

    await expect(
      readXWorkmateArtifact({
        params: {
          sessionKey: "thread-main",
          runId: "run-1",
          relativePath: "../outside.txt",
        },
        pluginConfig: { workspaceDir: root },
      }),
    ).rejects.toThrow("relativePath must stay inside the workspace");
  });

  it("rejects symlink escapes when reading artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-xworkmate-artifacts-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-xworkmate-outside-"));
    const outsideFile = path.join(outsideRoot, "secret.txt");
    await fs.writeFile(outsideFile, "secret");
    await fs.symlink(outsideFile, path.join(root, "linked-secret.txt"));

    await expect(
      readXWorkmateArtifact({
        params: {
          sessionKey: "thread-main",
          runId: "run-1",
          relativePath: "linked-secret.txt",
        },
        pluginConfig: { workspaceDir: root },
      }),
    ).rejects.toThrow("relativePath must stay inside the workspace");
  });
});
