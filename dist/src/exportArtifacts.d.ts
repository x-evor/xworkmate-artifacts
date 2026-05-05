export type XWorkmateArtifact = {
    relativePath: string;
    label: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    encoding?: "base64";
    content?: string;
};
export type XWorkmateArtifactExport = {
    runId: string;
    sessionKey: string;
    remoteWorkingDirectory: string;
    remoteWorkspaceRefKind: "remotePath";
    artifacts: XWorkmateArtifact[];
    warnings: string[];
};
type ExportInput = {
    params: Record<string, unknown>;
    config?: unknown;
    pluginConfig?: Record<string, unknown>;
};
export declare function exportXWorkmateArtifacts(input: ExportInput): Promise<XWorkmateArtifactExport>;
export {};
