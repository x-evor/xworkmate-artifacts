import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { exportXWorkmateArtifacts } from "./src/exportArtifacts.js";

export default function register(api: OpenClawPluginApi) {
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
}
