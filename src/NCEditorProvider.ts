import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

type WorkbenchTab = 'variables' | 'errors' | 'transfer';

type EditorRelayMessage =
    | { type: 'FILES_OPENED'; isSingleFile: boolean; activeChannel: string; channels: Record<string, string> }
    | { type: 'FILE_UPDATED_EXTERNALLY'; channels: Record<string, string> }
    | { type: 'FILE_UPDATED_EXTERNALLY'; channel: string; text: string; activeChannel?: string }
    | { type: 'OPEN_WORKBENCH_PANEL'; tab?: WorkbenchTab; channel?: string }
    | { type: 'WORKBENCH_BRIDGE'; eventType: 'EXECUTION_COMPLETED'; payload: { channelId: string; result: { variableSnapshotEntries: Array<[number, number]>; errors: unknown[] } } }
    | { type: 'WORKBENCH_BRIDGE'; eventType: 'EXECUTION_ERROR'; payload: { channelId: string; error: { message: string } } }
    | { type: 'WORKBENCH_BRIDGE'; eventType: 'PLOT_CLEARED'; payload: Record<string, never> };

export class NCDocument implements vscode.CustomDocument {
    public readonly uri: vscode.Uri;
    public readonly isSingleFile: boolean;
    public readonly activeChannel: string;
    public channelsContent = new Map<string, string>();
    public paHeaderContent = '';
    public channelUris = new Map<string, vscode.Uri>();
    public baseName: string;

    constructor(
        uri: vscode.Uri,
        isSingleFile: boolean,
        activeChannel: string,
        baseName: string
    ) {
        this.uri = uri;
        this.isSingleFile = isSingleFile;
        this.activeChannel = activeChannel;
        this.baseName = baseName;
    }

    dispose(): void {
        // Cleanup if needed
    }
}

export class NCEditorProvider implements vscode.CustomEditorProvider<NCDocument> {
    public static readonly viewType = 'ncedit7lab.editor';

    public static register(context: vscode.ExtensionContext, backendPort: number): vscode.Disposable {
        const provider = new NCEditorProvider(context, backendPort);
        const providerRegistration = vscode.window.registerCustomEditorProvider(
            NCEditorProvider.viewType,
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                },
                supportsMultipleEditorsPerDocument: false
            }
        );
        return providerRegistration;
    }

    private readonly webviewPanels = new Set<vscode.WebviewPanel>();
    private activeWebviewPanel?: vscode.WebviewPanel;

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<NCDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly backendPort: number,
        private readonly relayToWorkbenchPanel?: (message: EditorRelayMessage) => void,
    ) { }

    private analyzeUri(uri: vscode.Uri) {
        const ext = path.extname(uri.fsPath).toLowerCase();
        let isSingleFile = false;
        let activeChannel = '1';
        
        if (ext === '.pa') {
            isSingleFile = true;
        } else if (['.p1', '.m'].includes(ext)) {
            activeChannel = '1';
        } else if (['.p2', '.s', '.p-2'].includes(ext)) {
            activeChannel = '2';
        } else if (ext === '.p3') {
            activeChannel = '3';
        }
        
        const baseName = path.basename(uri.fsPath, path.extname(uri.fsPath));
        return { isSingleFile, activeChannel, baseName, ext };
    }

    private parsePAFile(content: string) {
        const channels = new Map<string, string>();
        const regex = /(<O[A-Za-z0-9_]+\.P[1-3]>)/g;
        const parts = content.split(regex);
        
        const header = parts[0] || '';
        
        for (let i = 1; i < parts.length; i += 2) {
            const marker = parts[i];
            const text = parts[i+1] || '';
            const chMatch = marker.match(/\.P([1-3])>/);
            if (chMatch) {
                channels.set(chMatch[1], marker + text);
            }
        }
        
        if (channels.size === 0) channels.set('1', content);
        return { header, channels };
    }

    private assemblePAFile(header: string, channels: Map<string, string>) {
        let res = header.trimEnd() + '\n';
        for (let i = 1; i <= 3; i++) {
            const ch = i.toString();
            if (channels.has(ch)) {
                res += channels.get(ch)?.trimEnd() + '\n\n';
            }
        }
        return res.trim() + '\n';
    }

    private async discoverSiblings(baseUri: vscode.Uri, baseName: string, activeChannel: string, channelUris: Map<string, vscode.Uri>, channelsContent: Map<string, string>) {
        const dir = vscode.Uri.joinPath(baseUri, '..');
        const extMap: Record<string, string[]> = {
            '1': ['.p1', '.m', '.P1', '.M'],
            '2': ['.p2', '.s', '.p-2', '.P2', '.S', '.P-2'],
            '3': ['.p3', '.P3']
        };
        
        for (const ch of ['1', '2', '3']) {
            if (ch === activeChannel) continue;
            
            for (const ext of extMap[ch]) {
                try {
                    const targetUri = vscode.Uri.joinPath(dir, baseName + ext);
                    const stat = await vscode.workspace.fs.stat(targetUri);
                    if (stat) {
                        const data = await vscode.workspace.fs.readFile(targetUri);
                        channelsContent.set(ch, Buffer.from(data).toString('utf8'));
                        channelUris.set(ch, targetUri);
                        break;
                    }
                } catch (e) {
                    // Ignore missing files
                }
            }
        }
    }

    public async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<NCDocument> {
        const { isSingleFile, activeChannel, baseName } = this.analyzeUri(uri);
        const document = new NCDocument(uri, isSingleFile, activeChannel, baseName);
        
        if (openContext.untitledDocumentData) {
            const textData = Buffer.from(openContext.untitledDocumentData).toString('utf8');
            if (isSingleFile) {
                const parsed = this.parsePAFile(textData);
                document.channelsContent = parsed.channels;
                document.paHeaderContent = parsed.header;
            } else {
                document.channelsContent.set(activeChannel, textData);
                document.channelUris.set(activeChannel, uri);
            }
            return document;
        }

        try {
            const data = await vscode.workspace.fs.readFile(uri);
            const textData = Buffer.from(data).toString('utf8');

            if (isSingleFile) {
                const parsed = this.parsePAFile(textData);
                document.channelsContent = parsed.channels;
                document.paHeaderContent = parsed.header;
            } else {
                document.channelsContent.set(activeChannel, textData);
                document.channelUris.set(activeChannel, uri);
                await this.discoverSiblings(uri, baseName, activeChannel, document.channelUris, document.channelsContent);
            }
        } catch (e) {
            // File doesn't exist yet but being created or inaccessible
        }

        return document;
    }

    public async saveCustomDocument(document: NCDocument, cancellation: vscode.CancellationToken): Promise<void> {
        if (document.isSingleFile) {
            const assembled = this.assemblePAFile(document.paHeaderContent, document.channelsContent);
            await vscode.workspace.fs.writeFile(document.uri, Buffer.from(assembled, 'utf8'));
        } else {
            for (const [ch, uri] of document.channelUris.entries()) {
                const text = document.channelsContent.get(ch) || '';
                await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
            }
        }
    }

    public async saveCustomDocumentAs(document: NCDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
        // Implement as-needed, for simplicity we treat it as saving the current document instance's layout but to a new path.
        if (document.isSingleFile) {
            const assembled = this.assemblePAFile(document.paHeaderContent, document.channelsContent);
            await vscode.workspace.fs.writeFile(destination, Buffer.from(assembled, 'utf8'));
        } else {
            const dir = vscode.Uri.joinPath(destination, '..');
            const destBaseName = path.basename(destination.fsPath, path.extname(destination.fsPath));
            const destExtMap: Record<string, string> = {
                '1': '.p1',
                '2': '.p2',
                '3': '.p3'
            }; // simple mappings for save as
            
            for (const [ch, uri] of document.channelUris.entries()) {
                const text = document.channelsContent.get(ch) || '';
                const activeExt = document.activeChannel === ch ? path.extname(destination.fsPath) : destExtMap[ch];
                const targetUri = vscode.Uri.joinPath(dir, destBaseName + activeExt);
                await vscode.workspace.fs.writeFile(targetUri, Buffer.from(text, 'utf8'));
            }
        }
    }

    public async revertCustomDocument(document: NCDocument, cancellation: vscode.CancellationToken): Promise<void> {
        const { isSingleFile, activeChannel, baseName } = this.analyzeUri(document.uri);
        document.channelsContent.clear();
        document.channelUris.clear();
        
        try {
            const data = await vscode.workspace.fs.readFile(document.uri);
            const textData = Buffer.from(data).toString('utf8');

            if (isSingleFile) {
                const parsed = this.parsePAFile(textData);
                document.channelsContent = parsed.channels;
                document.paHeaderContent = parsed.header;
            } else {
                document.channelsContent.set(activeChannel, textData);
                document.channelUris.set(activeChannel, document.uri);
                await this.discoverSiblings(document.uri, baseName, activeChannel, document.channelUris, document.channelsContent);
            }
        } catch (e) {
            // Reverting to empty/deleted state
        }
        
        // Notify the webview panels that the document reverted
        const channelsObj: Record<string, string> = Object.fromEntries(document.channelsContent);
        this.webviewPanels.forEach(p => {
            p.webview.postMessage({ type: 'FILE_UPDATED_EXTERNALLY', channels: channelsObj });
        });
    }

    public async backupCustomDocument(document: NCDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        const dest = context.destination;
        let backupData = '';
        if (document.isSingleFile) {
            backupData = this.assemblePAFile(document.paHeaderContent, document.channelsContent);
        } else {
            const backupObj: Record<string, string> = Object.fromEntries(document.channelsContent);
            backupData = JSON.stringify(backupObj);
        }
        await vscode.workspace.fs.writeFile(dest, Buffer.from(backupData, 'utf8'));

        return {
            id: dest.toString(),
            delete: async () => {
                try {
                    await vscode.workspace.fs.delete(dest);
                } catch {}
            }
        };
    }

    public async resolveCustomEditor(
        document: NCDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        this.webviewPanels.add(webviewPanel);
        this.activeWebviewPanel = webviewPanel;

        const distPath = vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'ncedit7lab', 'dist');

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                distPath
            ]
        };

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

        webviewPanel.onDidChangeViewState(({ webviewPanel: panel }) => {
            if (panel.active) {
                this.activeWebviewPanel = panel;
            }
        });

        webviewPanel.onDidDispose(() => {
            this.webviewPanels.delete(webviewPanel);
            if (this.activeWebviewPanel === webviewPanel) {
                this.activeWebviewPanel = Array.from(this.webviewPanels.values())[0];
            }
        });

        webviewPanel.webview.onDidReceiveMessage(async e => {
            switch (e.type) {
                case 'ready':
                    const channelsObj: Record<string, string> = Object.fromEntries(document.channelsContent);
                    const readyMessage: EditorRelayMessage = {
                        type: 'FILES_OPENED',
                        isSingleFile: document.isSingleFile,
                        activeChannel: document.activeChannel,
                        channels: channelsObj
                    };
                    webviewPanel.webview.postMessage(readyMessage);
                    webviewPanel.webview.postMessage({ type: 'UPDATE_CONFIG', config: this.getCurrentWebviewConfig() });
                    this.relayMessageToWorkbench(webviewPanel, readyMessage);
                    return;
                case 'changed':
                    // e.channel and e.text
                    const channel = e.channel as string;
                    const newText = e.text as string;
                    const oldText = document.channelsContent.get(channel) || '';

                    if (oldText === newText) {
                        return;
                    }

                    document.channelsContent.set(channel, newText);

                    // Fire the CustomDocumentEditEvent with undo/redo
                    this._onDidChangeCustomDocument.fire({
                        document,
                        undo: () => {
                            document.channelsContent.set(channel, oldText);
                            webviewPanel.webview.postMessage({
                                type: 'FILE_UPDATED_EXTERNALLY',
                                channel: channel,
                                text: oldText,
                                activeChannel: channel
                            });
                        },
                        redo: () => {
                            document.channelsContent.set(channel, newText);
                            webviewPanel.webview.postMessage({
                                type: 'FILE_UPDATED_EXTERNALLY',
                                channel: channel,
                                text: newText,
                                activeChannel: channel
                            });
                        },
                        label: `Edit Channel ${channel}`
                    });

                    this.relayMessageToWorkbench(webviewPanel, {
                        type: 'FILE_UPDATED_EXTERNALLY',
                        channel: channel,
                        text: newText,
                        activeChannel: channel,
                    });
                    return;
                case 'workbench:relay':
                    this.relayMessageToWorkbench(webviewPanel, e.message as EditorRelayMessage);
                    return;
                case 'workbench:open-panel':
                    this.relayMessageToWorkbench(webviewPanel, {
                        type: 'OPEN_WORKBENCH_PANEL',
                        tab: e.tab as WorkbenchTab | undefined,
                        channel: typeof e.channel === 'string' ? e.channel : document.activeChannel,
                    });
                    return;
            }
        });
    }

    public getActiveWebviewPanel(): vscode.WebviewPanel | undefined {
        return this.activeWebviewPanel;
    }

    public updateConfig(config: Record<string, unknown>): void {
        this.webviewPanels.forEach((panel) => {
            panel.webview.postMessage({ type: 'UPDATE_CONFIG', config });
        });
    }

    private getCurrentWebviewConfig(): Record<string, unknown> {
        const ptmConfig = vscode.workspace.getConfiguration('ncedit7lab.ptm');
        const layoutConfig = vscode.workspace.getConfiguration('ncedit7lab.layout');
        const config = vscode.workspace.getConfiguration('ncedit7lab');

        return {
            backendPort: this.backendPort,
            backendBaseUrl: config.get<string>('backendBaseUrl')?.trim() || `http://127.0.0.1:${this.backendPort}`,
            ptmDefaultIp: ptmConfig.get<string>('defaultIpAddress') || '192.168.1.1',
            transferDefaultIp: ptmConfig.get<string>('defaultIpAddress') || '192.168.1.1',
            transferProtocol: config.get<string>('transferProtocol') || 'none',
            transferDriverPath: config.get<string>('transferDriverPath') || '',
            themeMode: config.get<string>('theme.mode') || 'vscode',
            hostMode: 'vscode-editor',
            ptmPlacement: layoutConfig.get<string>('ptmPlacement') || 'external-panel',
            showPtmTransfer: config.get<boolean>('showPtmTransfer') ?? false,
            showDrawPanel: config.get<boolean>('showDrawPanel') ?? true,
        };
    }

    private relayMessageToWorkbench(sourcePanel: vscode.WebviewPanel, message: EditorRelayMessage): void {
        if (this.activeWebviewPanel && this.activeWebviewPanel !== sourcePanel && !sourcePanel.active) {
            return;
        }

        this.activeWebviewPanel = sourcePanel;
        this.relayToWorkbenchPanel?.(message);
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const distPath = vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'ncedit7lab', 'dist');

        let htmlContent = '<!DOCTYPE html><html lang="en"><body><h1>UI Not Found</h1><p>Ensure the frontend has been bundled successfully.</p></body></html>';
        const indexHtmlPath = path.join(distPath.fsPath, 'index.html');
        try {
            if (fs.existsSync(indexHtmlPath)) {
                let rawHtml = fs.readFileSync(indexHtmlPath, 'utf8');
                const basePathUri = webview.asWebviewUri(distPath);
                htmlContent = rawHtml.replace(/(href|src)="\/([^"]*)"/g, (match, attr, filePath) => {
                    return `${attr}="${basePathUri.toString()}/${filePath}"`;
                });

                const ptmConfig = vscode.workspace.getConfiguration('ncedit7lab.ptm');
                const layoutConfig = vscode.workspace.getConfiguration('ncedit7lab.layout');
                const defaultIp = ptmConfig.get<string>('defaultIpAddress') || '192.168.1.1';
                const transferProtocol = vscode.workspace.getConfiguration('ncedit7lab').get<string>('transferProtocol') || 'none';
                const transferDriverPath = vscode.workspace.getConfiguration('ncedit7lab').get<string>('transferDriverPath') || '';
                const themeMode = vscode.workspace.getConfiguration('ncedit7lab').get<string>('theme.mode') || 'vscode';
                const ptmPlacement = layoutConfig.get<string>('ptmPlacement') || 'external-panel';
                const showPtmTransfer = vscode.workspace.getConfiguration('ncedit7lab').get<boolean>('showPtmTransfer') ?? false;
                const showDrawPanel = vscode.workspace.getConfiguration('ncedit7lab').get<boolean>('showDrawPanel') ?? true;
                const backendBaseUrl = vscode.workspace.getConfiguration('ncedit7lab').get<string>('backendBaseUrl')?.trim() || `http://127.0.0.1:${this.backendPort}`;

                const scriptInjection = `
                <script>
                    window.backendPort = ${this.backendPort};
                    window.backendBaseUrl = "${backendBaseUrl}";
                    window.ptmDefaultIp = "${defaultIp}";
                    window.ncedit7labSupportedTransferPaths = [1, 2, 3];
                    window.vscodeConfig = {
                        backendPort: ${this.backendPort},
                        backendBaseUrl: "${backendBaseUrl}",
                        ptmDefaultIp: "${defaultIp}",
                        transferDefaultIp: "${defaultIp}",
                        transferProtocol: "${transferProtocol}",
                        transferDriverPath: "${transferDriverPath.replace(/\\/g, '\\\\')}",
                        themeMode: "${themeMode}",
                        hostMode: "vscode-editor",
                        ptmPlacement: "${ptmPlacement}",
                        showPtmTransfer: ${showPtmTransfer},
                        showDrawPanel: ${showDrawPanel}
                    };
                    window.applyncedit7labTransferPatch = () => {
                        const supportedPaths = Array.isArray(window.ncedit7labSupportedTransferPaths)
                            ? window.ncedit7labSupportedTransferPaths
                            : [1, 2];

                        customElements.whenDefined('nc-transfer-panel').then(() => {
                            const TransferPanel = customElements.get('nc-transfer-panel');
                            if (!TransferPanel) {
                                return;
                            }

                            const proto = TransferPanel.prototype;
                            if (proto.__ncedit7labSupportedPathsPatched) {
                                return;
                            }

                            Object.defineProperty(proto, '__ncedit7labSupportedPathsPatched', {
                                value: true,
                                configurable: false,
                                enumerable: false,
                                writable: false,
                            });

                            proto.fetchPrograms = async function() {
                                this.cncPrograms.clear();

                                for (const path of supportedPaths) {
                                    try {
                                        const response = await this.transferClient.listPrograms(this.ipAddress, path);
                                        for (const prog of response) {
                                            if (!this.cncPrograms.has(prog.number)) {
                                                this.cncPrograms.set(prog.number, {
                                                    number: prog.number,
                                                    comment: prog.comment,
                                                    paths: {},
                                                    isPA: false,
                                                });
                                            }

                                            const programEntry = this.cncPrograms.get(prog.number);
                                            programEntry.paths[path] = prog;
                                            programEntry.isPA = !!(programEntry.paths[1] && programEntry.paths[2]);
                                            if (!programEntry.comment && prog.comment) {
                                                programEntry.comment = prog.comment;
                                            }
                                        }
                                    } catch (error) {
                                        console.warn('Failed to list programs on path', path, error);
                                    }
                                }
                            };

                            const originalRender = proto.render;
                            proto.render = function(...args) {
                                const result = originalRender.apply(this, args);

                                if (this.shadowRoot) {
                                    this.shadowRoot.querySelectorAll('[data-path="3"]').forEach((element) => element.remove());
                                }

                                return result;
                            };

                            proto.uploadDroppedFile = async function(content, targetPath) {
                                if (!targetPath) {
                                    return;
                                }

                                try {
                                    this.loading = true;
                                    this.render();

                                    if (targetPath === 'PA') {
                                        const taggedPrograms = {};
                                        const tagRegex = /<[^>]*P(\d+)>/g;
                                        let match;
                                        let contentStart = 0;
                                        let currentPath = -1;

                                        while ((match = tagRegex.exec(content)) !== null) {
                                            if (currentPath !== -1) {
                                                taggedPrograms[currentPath] = content.substring(contentStart, match.index).trim();
                                            }
                                            currentPath = parseInt(match[1], 10);
                                            contentStart = tagRegex.lastIndex;
                                        }

                                        if (currentPath !== -1) {
                                            taggedPrograms[currentPath] = content.substring(contentStart).trim();
                                        }

                                        const uploadedPaths = [];
                                        const skippedPaths = [];
                                        const errors = [];

                                        for (const [pathKey, partContent] of Object.entries(taggedPrograms)) {
                                            const pathNumber = parseInt(pathKey, 10);
                                            if (!supportedPaths.includes(pathNumber)) {
                                                skippedPaths.push(pathNumber);
                                                continue;
                                            }

                                            let cleanContent = partContent.trim();
                                            if (cleanContent.startsWith('%')) cleanContent = cleanContent.slice(1).trimStart();
                                            if (cleanContent.endsWith('%')) cleanContent = cleanContent.slice(0, -1).trimEnd();

                                            const finalContent = '\\n' + cleanContent + '\\n%';
                                            try {
                                                await this.transferClient.downloadProgram(this.ipAddress, pathNumber, finalContent);
                                                uploadedPaths.push(pathNumber);
                                            } catch (error) {
                                                errors.push('P' + pathNumber + ': ' + error);
                                            }
                                        }

                                        if (!uploadedPaths.length && skippedPaths.length) {
                                            alert('No supported paths found in PA file. Supported paths: ' + supportedPaths.join(', '));
                                        } else if (errors.length) {
                                            alert('File pushed to Paths ' + uploadedPaths.join(', ') + '.\\nErrors:\\n' + errors.join('\\n'));
                                        } else if (skippedPaths.length) {
                                            alert('PA file pushed to Paths ' + uploadedPaths.join(', ') + '. Skipped unsupported paths: ' + skippedPaths.join(', '));
                                        } else {
                                            alert('PA file pushed to Paths ' + uploadedPaths.join(', ') + ' successfully!');
                                        }
                                    } else {
                                        const pathNumber = parseInt(targetPath, 10);
                                        if (!supportedPaths.includes(pathNumber)) {
                                            alert('Path ' + pathNumber + ' is not enabled. Supported paths: ' + supportedPaths.join(', '));
                                            return;
                                        }

                                        let cleanContent = content.trim();
                                        if (cleanContent.startsWith('%')) cleanContent = cleanContent.slice(1).trimStart();
                                        if (cleanContent.endsWith('%')) cleanContent = cleanContent.slice(0, -1).trimEnd();

                                        const finalContent = '\\n' + cleanContent + '\\n%';
                                        await this.transferClient.downloadProgram(this.ipAddress, pathNumber, finalContent);
                                        alert('File pushed to Path ' + pathNumber + ' successfully!');
                                    }
                                } catch (error) {
                                    alert('Push failed: ' + error);
                                } finally {
                                    await this.fetchPrograms();
                                    this.loading = false;
                                    this.render();
                                    this.attachEventListeners();
                                }
                            };
                        });
                    };

                    window.vscodeApi = window.vscodeApi || acquireVsCodeApi();
                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.type === 'FILES_OPENED' || message.type === 'FILE_UPDATED_EXTERNALLY') {
                            window.dispatchEvent(new CustomEvent('vscode:files-opened', { detail: message }));
                        }
                    });
                    window.addEventListener('DOMContentLoaded', () => {
                        window.applyncedit7labTransferPatch();
                        window.vscodeApi.postMessage({ type: 'ready' });
                    });
                    window.addEventListener('vscode:file-changed', event => {
                        window.vscodeApi.postMessage({ type: 'changed', channel: event.detail.channel, text: event.detail.text });
                    });
                </script>
                `;
                htmlContent = htmlContent.replace('</head>', `${scriptInjection}</head>`);
            }
        } catch (error) {
            console.error('Failed to load Vite index.html', error);
        }
        return htmlContent;
    }
}


