export type XWorkmateArtifact = {
    relativePath: string;
    label: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    artifactScope?: string;
    scopeKind?: XWorkmateArtifactScopeKind;
    encoding?: "base64";
    content?: string;
};
export type XWorkmateArtifactScopeKind = "task" | "workspace" | "workspace-latest";
export type XWorkmateArtifactExport = {
    runId: string;
    sessionKey: string;
    remoteWorkingDirectory: string;
    remoteWorkspaceRefKind: "remotePath";
    artifactScope?: string;
    scopeKind: XWorkmateArtifactScopeKind;
    artifacts: XWorkmateArtifact[];
    warnings: string[];
    manifestMarkdown: string;
};
export type XWorkmateArtifactPrepare = {
    runId: string;
    sessionKey: string;
    remoteWorkingDirectory: string;
    remoteWorkspaceRefKind: "remotePath";
    artifactScope: string;
    scopeKind: "task";
    artifactDirectory: string;
    relativeArtifactDirectory: string;
    warnings: string[];
};
type ExportInput = {
    params: Record<string, unknown>;
    config?: unknown;
    pluginConfig?: Record<string, unknown>;
};
type ReadInput = {
    params: Record<string, unknown>;
    config?: unknown;
    pluginConfig?: Record<string, unknown>;
};
export declare function prepareXWorkmateArtifacts(input: ExportInput): Promise<XWorkmateArtifactPrepare>;
export declare function exportXWorkmateArtifacts(input: ExportInput): Promise<XWorkmateArtifactExport>;
export declare function readXWorkmateArtifact(input: ReadInput): Promise<XWorkmateArtifactExport>;
export declare function formatArtifactManifestMarkdown(input: {
    remoteWorkingDirectory: string;
    artifactScope?: string;
    scopeKind?: XWorkmateArtifactScopeKind;
    artifacts: XWorkmateArtifact[];
    warnings: string[];
}): string;
export {};
