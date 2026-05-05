import { exportXWorkmateArtifacts } from "./src/exportArtifacts.js";
export default function register(api) {
    api.registerGatewayMethod("xworkmate.artifacts.export", async (opts) => {
        try {
            const payload = await exportXWorkmateArtifacts({
                params: opts.params,
                config: api.config,
                pluginConfig: api.pluginConfig,
            });
            opts.respond(true, payload, undefined);
        }
        catch (error) {
            opts.respond(false, undefined, {
                code: "INVALID_REQUEST",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
