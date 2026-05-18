import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportXWorkmateArtifacts,
  prepareXWorkmateArtifacts,
  readXWorkmateArtifact,
} from "./exportArtifacts.js";

describe("exportXWorkmateArtifacts", () => {
  it("prepares isolated task artifact scopes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));

    const first = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-1" },
      pluginConfig: { workspaceDir: root },
    });
    const second = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-2" },
      pluginConfig: { workspaceDir: root },
    });

    expect(first.artifactScope).toBe("tasks/thread-main/turn-1");
    expect(second.artifactScope).toBe("tasks/thread-main/turn-2");
    expect(first.artifactScope).not.toBe(second.artifactScope);
    expect((await fs.stat(first.artifactDirectory)).isDirectory()).toBe(true);
    expect(first.remoteWorkingDirectory).toBe(await fs.realpath(root));
    expect(first.scopeKind).toBe("task");
  });

  it("exports changed files with metadata and base64 content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const prepared = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "run-1" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.mkdir(path.join(prepared.artifactDirectory, "reports"), { recursive: true });
    const filePath = path.join(prepared.artifactDirectory, "reports", "final.md");
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
    expect(result.scopeKind).toBe("task");
    expect(result.artifactScope).toBe(prepared.artifactScope);
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
    expect(result.artifacts[0]?.artifactRef).toContain(".");
    expect(result.manifestMarkdown).toContain("reports/final.md");
    expect(result.manifestMarkdown).toContain("text/markdown");
  });

  it("filters old files by sinceUnixMs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const prepared = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "run-1" },
      pluginConfig: { workspaceDir: root },
    });
    const oldFile = path.join(prepared.artifactDirectory, "old.txt");
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const prepared = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "run-1" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.mkdir(path.join(prepared.artifactDirectory, ".git"), { recursive: true });
    await fs.mkdir(path.join(prepared.artifactDirectory, ".xworkmate", "artifacts"), { recursive: true });
    await fs.writeFile(path.join(prepared.artifactDirectory, ".git", "secret.txt"), "secret");
    await fs.writeFile(path.join(prepared.artifactDirectory, ".xworkmate", "artifacts", "index.json"), "{}");
    await fs.writeFile(path.join(prepared.artifactDirectory, "real.txt"), "real");
    await fs.symlink(path.join(prepared.artifactDirectory, "real.txt"), path.join(prepared.artifactDirectory, "linked.txt"));

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

  it("exports only files inside a task artifact scope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const first = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-1" },
      pluginConfig: { workspaceDir: root },
    });
    const second = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-2" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.mkdir(path.join(first.artifactDirectory, "reports"), { recursive: true });
    await fs.writeFile(path.join(first.artifactDirectory, "reports", "first.txt"), "first");
    await fs.writeFile(path.join(second.artifactDirectory, "second.txt"), "second");
    await fs.writeFile(path.join(root, "global.txt"), "global");

    const result = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "thread-main",
        runId: "turn-1",
        artifactScope: first.artifactScope,
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.scopeKind).toBe("task");
    expect(result.artifactScope).toBe(first.artifactScope);
    expect(result.artifacts.map((entry) => entry.relativePath)).toEqual(["reports/first.txt"]);
    expect(result.artifacts[0]).toMatchObject({
      artifactScope: first.artifactScope,
      scopeKind: "task",
    });
  });

  it("uses the current task scope when artifactScope is omitted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const current = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-1" },
      pluginConfig: { workspaceDir: root },
    });
    const other = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-2" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.writeFile(path.join(root, "global.txt"), "global");
    await fs.writeFile(path.join(current.artifactDirectory, "current.txt"), "current");
    await fs.writeFile(path.join(other.artifactDirectory, "other.txt"), "other");

    const result = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "thread-main",
        runId: "turn-1",
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.scopeKind).toBe("task");
    expect(result.artifactScope).toBe(current.artifactScope);
    expect(result.artifacts.map((entry) => entry.relativePath)).toEqual(["current.txt"]);
  });

  it("does not scan the workspace root without a current-run timestamp", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-1" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.writeFile(path.join(root, "global.txt"), "global");

    const result = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "thread-main",
        runId: "turn-1",
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.scopeKind).toBe("task");
    expect(result.artifacts).toEqual([]);
    expect(result.manifestMarkdown).toContain("No artifacts found for this task run.");
    expect(result.manifestMarkdown).toContain("Artifact scope: `tasks/thread-main/turn-1`");
  });

  it("adopts current-run workspace root files into the task artifact scope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-1" },
      pluginConfig: { workspaceDir: root },
    });
    const sinceUnixMs = Date.now() - 1_000;
    await fs.writeFile(path.join(root, "xhs_account_security.md"), "# Account security\n");

    const result = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "thread-main",
        runId: "turn-1",
        sinceUnixMs,
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.scopeKind).toBe("task");
    expect(result.artifactScope).toBe("tasks/thread-main/turn-1");
    expect(result.artifacts.map((entry) => entry.relativePath)).toEqual(["xhs_account_security.md"]);
    expect(result.artifacts[0]).toMatchObject({
      artifactScope: "tasks/thread-main/turn-1",
      scopeKind: "task",
      contentType: "text/markdown",
      encoding: "base64",
      content: Buffer.from("# Account security\n").toString("base64"),
    });
    expect(await fs.readFile(path.join(root, "tasks", "thread-main", "turn-1", "xhs_account_security.md"), "utf8")).toBe(
      "# Account security\n",
    );
  });

  it("creates the current task scope when adopting root files after bridge export", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const sinceUnixMs = Date.now() - 1_000;
    await fs.mkdir(path.join(root, "reports"), { recursive: true });
    await fs.writeFile(path.join(root, "reports", "final.md"), "final");

    const result = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "thread-main",
        runId: "turn-1",
        sinceUnixMs,
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.artifactScope).toBe("tasks/thread-main/turn-1");
    expect(result.artifacts.map((entry) => entry.relativePath)).toEqual(["reports/final.md"]);
    expect(result.warnings).toEqual([]);
    expect(await fs.readFile(path.join(root, "tasks", "thread-main", "turn-1", "reports", "final.md"), "utf8")).toBe(
      "final",
    );
  });

  it("adopts root Word documents into only the current task scope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const sinceUnixMs = Date.now() - 1_000;
    await fs.writeFile(path.join(root, "article.docx"), "docx-content");

    const result = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "draft-article",
        runId: "openclaw-run-1",
        sinceUnixMs,
        maxInlineBytes: 0,
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.artifactScope).toBe("tasks/draft-article/openclaw-run-1");
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      relativePath: "article.docx",
      artifactScope: "tasks/draft-article/openclaw-run-1",
      scopeKind: "task",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(result.artifacts[0]?.encoding).toBeUndefined();
    expect(await fs.readFile(path.join(root, "tasks", "draft-article", "openclaw-run-1", "article.docx"), "utf8")).toBe(
      "docx-content",
    );
    await expect(fs.stat(path.join(root, "tasks", "draft-article", "turn-1", "article.docx"))).rejects.toThrow();
  });

  it("does not adopt old workspace root files into a later task scope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-1" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.writeFile(path.join(root, "old-root.md"), "old");
    const stat = await fs.stat(path.join(root, "old-root.md"));

    const result = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "thread-main",
        runId: "turn-1",
        sinceUnixMs: stat.mtimeMs + 10_000,
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.artifacts).toEqual([]);
    await expect(fs.stat(path.join(root, "tasks", "thread-main", "turn-1", "old-root.md"))).rejects.toThrow();
  });

  it("rejects scoped exports that do not match the requested session/run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const first = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-1" },
      pluginConfig: { workspaceDir: root },
    });
    await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-2" },
      pluginConfig: { workspaceDir: root },
    });

    await expect(
      exportXWorkmateArtifacts({
        params: {
          sessionKey: "thread-main",
          runId: "turn-2",
          artifactScope: first.artifactScope,
        },
        pluginConfig: { workspaceDir: root },
      }),
    ).rejects.toThrow("artifactScope does not match sessionKey/runId");
  });

  it("does not adopt old workspace files when the scoped directory is empty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const prepared = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-1" },
      pluginConfig: { workspaceDir: root },
    });
    const otherTask = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-2" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.writeFile(path.join(root, "existing.pdf"), "pdf");
    await fs.writeFile(path.join(otherTask.artifactDirectory, "other-task.txt"), "other");
    await fs.mkdir(path.join(root, ".xworkmate", "metadata"), { recursive: true });
    await fs.writeFile(path.join(root, ".xworkmate", "metadata", "internal.json"), "{}");
    const stat = await fs.stat(path.join(root, "existing.pdf"));

    const result = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "thread-main",
        runId: "turn-1",
        artifactScope: prepared.artifactScope,
        sinceUnixMs: stat.mtimeMs + 10_000,
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.scopeKind).toBe("task");
    expect(result.artifactScope).toBe(prepared.artifactScope);
    expect(result.artifacts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("does not borrow previous session task files when current task scope is empty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const previousTask = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-previous" },
      pluginConfig: { workspaceDir: root },
    });
    await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-follow-up" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.writeFile(path.join(previousTask.artifactDirectory, "k8s-networking.pdf"), "pdf");
    await fs.writeFile(path.join(previousTask.artifactDirectory, "k8s-networking.docx"), "docx");

    const result = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "thread-main",
        runId: "turn-follow-up",
        sinceUnixMs: Date.now() + 10_000,
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.scopeKind).toBe("task");
    expect(result.artifactScope).toBe("tasks/thread-main/turn-follow-up");
    expect(result.artifacts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("exports concurrent task scopes independently", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const prepared = await Promise.all([
      prepareXWorkmateArtifacts({
        params: { sessionKey: "thread-a", runId: "turn-1" },
        pluginConfig: { workspaceDir: root },
      }),
      prepareXWorkmateArtifacts({
        params: { sessionKey: "thread-b", runId: "turn-1" },
        pluginConfig: { workspaceDir: root },
      }),
      prepareXWorkmateArtifacts({
        params: { sessionKey: "thread-a", runId: "turn-2" },
        pluginConfig: { workspaceDir: root },
      }),
    ]);
    await fs.writeFile(path.join(prepared[0].artifactDirectory, "a-1.txt"), "a1");
    await fs.writeFile(path.join(prepared[1].artifactDirectory, "b-1.txt"), "b1");
    await fs.writeFile(path.join(prepared[2].artifactDirectory, "a-2.txt"), "a2");

    const results = await Promise.all([
      exportXWorkmateArtifacts({
        params: { sessionKey: "thread-a", runId: "turn-1" },
        pluginConfig: { workspaceDir: root },
      }),
      exportXWorkmateArtifacts({
        params: { sessionKey: "thread-b", runId: "turn-1" },
        pluginConfig: { workspaceDir: root },
      }),
      exportXWorkmateArtifacts({
        params: { sessionKey: "thread-a", runId: "turn-2" },
        pluginConfig: { workspaceDir: root },
      }),
    ]);

    expect(results.map((result) => result.artifacts.map((entry) => entry.relativePath))).toEqual([
      ["a-1.txt"],
      ["b-1.txt"],
      ["a-2.txt"],
    ]);
    expect(results.map((result) => result.artifactScope)).toEqual(prepared.map((entry) => entry.artifactScope));
  });

  it("leaves oversized artifacts out of inline content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const prepared = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "run-1" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.writeFile(path.join(prepared.artifactDirectory, "large.pdf"), Buffer.from("large-content"));

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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const prepared = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "run-1" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.writeFile(path.join(prepared.artifactDirectory, "small.txt"), "small");

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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const prepared = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "run-1" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.writeFile(path.join(prepared.artifactDirectory, "a.txt"), "a");
    await fs.writeFile(path.join(prepared.artifactDirectory, "b.txt"), "b");

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
    const mainRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-main-"));
    const agentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-agent-"));
    await fs.writeFile(path.join(mainRoot, "main.txt"), "main");
    const prepared = await prepareXWorkmateArtifacts({
      params: { sessionKey: "agent:research:thread-1", runId: "run-1" },
      pluginConfig: { workspaceDir: agentRoot },
    });
    await fs.writeFile(path.join(prepared.artifactDirectory, "agent.txt"), "agent");

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

  it("rejects unscoped artifact reads by relative path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    await fs.mkdir(path.join(root, "reports"), { recursive: true });
    await fs.writeFile(path.join(root, "reports", "final.txt"), "final");

    await expect(
      readXWorkmateArtifact({
        params: {
          sessionKey: "thread-main",
          runId: "run-1",
          relativePath: "reports/final.txt",
        },
        pluginConfig: { workspaceDir: root },
      }),
    ).rejects.toThrow("artifactScope or artifactRef required");
  });

  it("reads one artifact inside a task artifact scope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const prepared = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-1" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.mkdir(path.join(prepared.artifactDirectory, "reports"), { recursive: true });
    await fs.writeFile(path.join(prepared.artifactDirectory, "reports", "final.txt"), "final");

    const result = await readXWorkmateArtifact({
      params: {
        sessionKey: "thread-main",
        runId: "turn-1",
        artifactScope: prepared.artifactScope,
        relativePath: "reports/final.txt",
      },
      pluginConfig: { workspaceDir: root },
    });

    expect(result.artifactScope).toBe(prepared.artifactScope);
    expect(result.scopeKind).toBe("task");
    expect(result.artifacts[0]).toMatchObject({
      artifactScope: prepared.artifactScope,
      relativePath: "reports/final.txt",
      scopeKind: "task",
      encoding: "base64",
      content: Buffer.from("final").toString("base64"),
    });
    expect(result.artifacts[0]?.artifactRef).toContain(".");
  });

  it("rejects direct reads from another run artifact scope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const first = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-1" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.writeFile(path.join(first.artifactDirectory, "first.txt"), "first");

    await expect(
      readXWorkmateArtifact({
        params: {
          sessionKey: "thread-main",
          runId: "turn-2",
          artifactScope: first.artifactScope,
          relativePath: "first.txt",
        },
        pluginConfig: { workspaceDir: root },
      }),
    ).rejects.toThrow("artifactScope does not match sessionKey/runId");
  });

  it("rejects signed task artifact refs from another session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const prepared = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-1" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.writeFile(path.join(prepared.artifactDirectory, "first.txt"), "first");
    const exported = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "thread-main",
        runId: "turn-1",
        artifactScope: prepared.artifactScope,
      },
      pluginConfig: { workspaceDir: root },
    });

    await expect(
      readXWorkmateArtifact({
        params: {
          sessionKey: "thread-other",
          runId: "turn-1",
          artifactRef: exported.artifacts[0]?.artifactRef,
        },
        pluginConfig: { workspaceDir: root },
      }),
    ).rejects.toThrow("artifactRef does not match sessionKey/runId");
  });

  it("rejects signed task artifact refs from another run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const prepared = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-1" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.writeFile(path.join(prepared.artifactDirectory, "existing.txt"), "existing");

    const exported = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "thread-main",
        runId: "turn-1",
        artifactScope: prepared.artifactScope,
      },
      pluginConfig: { workspaceDir: root },
    });

    await expect(
      readXWorkmateArtifact({
        params: {
          sessionKey: "thread-main",
          runId: "turn-2",
          artifactRef: exported.artifacts[0]?.artifactRef,
        },
        pluginConfig: { workspaceDir: root },
      }),
    ).rejects.toThrow("artifactRef does not match sessionKey/runId");
  });

  it("rejects tampered artifact refs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const prepared = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "run-1" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.writeFile(path.join(prepared.artifactDirectory, "existing.txt"), "existing");
    const exported = await exportXWorkmateArtifacts({
      params: {
        sessionKey: "thread-main",
        runId: "run-1",
      },
      pluginConfig: { workspaceDir: root },
    });
    const artifactRef = exported.artifacts[0]?.artifactRef ?? "";
    const tampered = `${artifactRef}x`;

    await expect(
      readXWorkmateArtifact({
        params: {
          sessionKey: "thread-main",
          runId: "run-1",
          artifactRef: tampered,
        },
        pluginConfig: { workspaceDir: root },
      }),
    ).rejects.toThrow("invalid artifactRef");
  });

  it("rejects legacy v1 artifact refs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const secret = "test-secret";
    const legacyPayload = Buffer.from(
      JSON.stringify({
        v: 1,
        workspaceRootHash: createHash("sha256").update(path.resolve(root)).digest("hex"),
        scopeKind: "task",
        relativePath: "existing.txt",
        sizeBytes: 8,
        sha256: createHash("sha256").update("existing").digest("hex"),
      }),
      "utf8",
    ).toString("base64url");
    const signature = createHmac("sha256", secret).update(legacyPayload).digest("base64url");
    const legacyRef = `${legacyPayload}.${signature}`;

    await expect(
      readXWorkmateArtifact({
        params: {
          sessionKey: "thread-main",
          runId: "run-1",
          artifactRef: legacyRef,
        },
        pluginConfig: { workspaceDir: root, artifactRefSigningSecret: secret },
      }),
    ).rejects.toThrow("invalid artifactRef");
  });

  it("reads artifact metadata without inline content when the file exceeds the limit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const prepared = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-1" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.writeFile(path.join(prepared.artifactDirectory, "large.bin"), Buffer.from("large-content"));

    const result = await readXWorkmateArtifact({
      params: {
        sessionKey: "thread-main",
        runId: "turn-1",
        artifactScope: prepared.artifactScope,
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const prepared = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-1" },
      pluginConfig: { workspaceDir: root },
    });

    await expect(
      readXWorkmateArtifact({
        params: {
          sessionKey: "thread-main",
          runId: "turn-1",
          artifactScope: prepared.artifactScope,
          relativePath: "../outside.txt",
        },
        pluginConfig: { workspaceDir: root },
      }),
    ).rejects.toThrow("relativePath must stay inside the workspace");
  });

  it("rejects artifact scope traversal when reading artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));

    await expect(
      readXWorkmateArtifact({
        params: {
          sessionKey: "thread-main",
          runId: "run-1",
          artifactScope: "../outside",
          relativePath: "secret.txt",
        },
        pluginConfig: { workspaceDir: root },
      }),
    ).rejects.toThrow("artifactScope must stay inside the workspace");
  });

  it("rejects symlink escapes when reading artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-plugins-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tmp-openclaw-multi-session-outside-"));
    const outsideFile = path.join(outsideRoot, "secret.txt");
    await fs.writeFile(outsideFile, "secret");
    const prepared = await prepareXWorkmateArtifacts({
      params: { sessionKey: "thread-main", runId: "turn-1" },
      pluginConfig: { workspaceDir: root },
    });
    await fs.symlink(outsideFile, path.join(prepared.artifactDirectory, "linked-secret.txt"));

    await expect(
      readXWorkmateArtifact({
        params: {
          sessionKey: "thread-main",
          runId: "turn-1",
          artifactScope: prepared.artifactScope,
          relativePath: "linked-secret.txt",
        },
        pluginConfig: { workspaceDir: root },
      }),
    ).rejects.toThrow("relativePath must stay inside the workspace");
  });
});
