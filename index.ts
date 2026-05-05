import type {
  AnyAgentTool,
  GatewayRequestHandlerOptions,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import {
  exportXWorkmateArtifacts,
  readXWorkmateArtifact,
} from "./src/exportArtifacts.js";

type XWorkmateToolContext = {
  config?: unknown;
  workspaceDir?: string;
  sessionKey?: string;
};

const plugin = {
  id: "xworkmate-artifacts",
  name: "XWorkmate Artifacts",
  description: "Exports structured artifact manifests from the OpenClaw workspace for XWorkmate.",
  register,
};

export default plugin;

function register(api: OpenClawPluginApi) {
  api.registerGatewayMethod("xworkmate.artifacts.export", async (opts: GatewayRequestHandlerOptions) => {
    try {
      const payload = await exportXWorkmateArtifacts({
        params: opts.params,
        config: api.config,
        pluginConfig: api.pluginConfig,
      });
      opts.respond(true, payload, undefined);
    } catch (error) {
      opts.respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  api.registerGatewayMethod("xworkmate.artifacts.list", async (opts: GatewayRequestHandlerOptions) => {
    try {
      const payload = await exportXWorkmateArtifacts({
        params: { ...opts.params, includeContent: false },
        config: api.config,
        pluginConfig: api.pluginConfig,
      });
      opts.respond(true, payload, undefined);
    } catch (error) {
      opts.respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  api.registerGatewayMethod("xworkmate.artifacts.read", async (opts: GatewayRequestHandlerOptions) => {
    try {
      const payload = await readXWorkmateArtifact({
        params: opts.params,
        config: api.config,
        pluginConfig: api.pluginConfig,
      });
      opts.respond(true, payload, undefined);
    } catch (error) {
      opts.respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  api.registerTool((ctx) => createXWorkmateArtifactsTool(api, ctx), {
    names: ["xworkmate_artifacts"],
    optional: true,
  });
}

function createXWorkmateArtifactsTool(
  api: OpenClawPluginApi,
  ctx: XWorkmateToolContext,
): AnyAgentTool {
  return {
    name: "xworkmate_artifacts",
    label: "XWorkmate Artifacts",
    description:
      "List generated artifacts in the current OpenClaw workspace or read one small artifact as base64 for XWorkmate.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["list", "read"],
          description: "Use list to show workspace artifacts, or read to return one small file.",
        },
        relativePath: {
          type: "string",
          description: "Artifact path relative to the workspace. Required for action=read.",
        },
        sinceUnixMs: {
          type: "number",
          description: "Only list files changed at or after this Unix timestamp in milliseconds.",
        },
        maxFiles: {
          type: "number",
          description: "Maximum number of files to list.",
        },
        maxInlineBytes: {
          type: "number",
          description: "Maximum bytes to inline when reading an artifact.",
        },
      },
      required: ["action"],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const action = typeof params.action === "string" ? params.action : "";
      const baseParams = {
        ...params,
        sessionKey: ctx.sessionKey || "agent:main:main",
        runId: typeof params.runId === "string" ? params.runId : "tool",
        workspaceDir: ctx.workspaceDir,
      };
      if (action === "list") {
        const payload = await exportXWorkmateArtifacts({
          params: { ...baseParams, includeContent: false },
          config: ctx.config ?? api.config,
          pluginConfig: api.pluginConfig,
        });
        return { content: [{ type: "text", text: payload.manifestMarkdown }], details: {} };
      }
      if (action === "read") {
        const payload = await readXWorkmateArtifact({
          params: baseParams,
          config: ctx.config ?? api.config,
          pluginConfig: api.pluginConfig,
        });
        const artifact = payload.artifacts[0];
        const text = artifact
          ? [
              payload.manifestMarkdown,
              "",
              artifact.content
                ? `Base64 content for \`${artifact.relativePath}\`:\n\n\`\`\`base64\n${artifact.content}\n\`\`\``
                : `\`${artifact.relativePath}\` is larger than maxInlineBytes; use the workspace path to download it directly.`,
            ].join("\n")
          : payload.manifestMarkdown;
        return { content: [{ type: "text", text }], details: {} };
      }
      throw new Error("action must be list or read");
    },
  } as unknown as AnyAgentTool;
}
