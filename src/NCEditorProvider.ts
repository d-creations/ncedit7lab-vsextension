import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { resolveBackendBaseUrl, resolveThemeMode } from './extension';

type WorkbenchTab = 'variables' | 'errors' | 'transfer' | 'templates';

function scriptValue(value: unknown): string {
    return JSON.stringify(value);
}

async function selectUsbDirectory(webview: vscode.Webview): Promise<void> {
    const usbConfig = vscode.workspace.getConfiguration('ncedit7lab.usb');
    const defaultRootPath = usbConfig.get<string>('defaultRootPath')?.trim() || '';
    const defaultUri = defaultRootPath && fs.existsSync(defaultRootPath) ? vscode.Uri.file(defaultRootPath) : undefined;
    const selectedFolders = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri,
        openLabel: 'Select USB Folder',
        title: 'Select USB Transfer Folder',
    });

    const selectedFolder = selectedFolders?.[0];
    if (!selectedFolder) {
        return;
    }

    const selectedPath = selectedFolder.fsPath;
    const configurationTarget = vscode.workspace.workspaceFolders
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await usbConfig.update('defaultRootPath', selectedPath, configurationTarget);
    await webview.postMessage({ type: 'USB_DIRECTORY_SELECTED', path: selectedPath });
}

type EditorRelayMessage =
    | { type: 'FILES_OPENED'; isSingleFile: boolean; activeChannel: string; channels: Record<string, string> }
    | { type: 'FILE_UPDATED_EXTERNALLY'; channels: Record<string, string> }
    | { type: 'FILE_UPDATED_EXTERNALLY'; channel: string; text: string; activeChannel?: string }
    | { type: 'OPEN_WORKBENCH_PANEL'; tab?: WorkbenchTab; channel?: string }
    | { type: 'WORKBENCH_BRIDGE'; eventType: 'EXECUTION_COMPLETED'; payload: { channelId: string; result: { variableSnapshotEntries: Array<[number, number]>; errors: unknown[] } } }
    | { type: 'WORKBENCH_BRIDGE'; eventType: 'EXECUTION_ERROR'; payload: { channelId: string; error: { message: string } } }
    | { type: 'WORKBENCH_BRIDGE'; eventType: 'PLOT_CLEARED'; payload: Record<string, never> };

export interface TemplateInsertRequest {
    channelId: string;
    content: string;
    mode?: 'insertAtCursor' | 'replaceSelection' | 'appendToDocument' | 'newProgram' | 'replaceDocument' | string;
    templateId?: string;
    multiChannelContent?: Record<string, string>;
}

export class NCDocument implements vscode.CustomDocument {
    public readonly uri: vscode.Uri;
    public readonly isSingleFile: boolean;
    public readonly activeChannel: string;
    public channelsContent = new Map<string, string>();
    public paHeaderContent = '';
    public paProgramName = 'O0001';
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
    private readonly panelDocuments = new Map<vscode.WebviewPanel, NCDocument>();
    private activeWebviewPanel?: vscode.WebviewPanel;
    private untitledTemplateCounter = 1;
    private readonly pendingUntitledTemplates = new Map<string, { channels: Map<string, string>; activeChannel: string; programName: string }>();

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
        let programName = 'O0001';
        
        for (let i = 1; i < parts.length; i += 2) {
            const marker = parts[i];
            const text = parts[i+1] || '';
            const chMatch = marker.match(/^<(O[A-Za-z0-9_]+)\.P([1-3])>$/);
            if (chMatch) {
                const body = text.replace(/^\r?\n/, '');
                // Skip outer wrapper/closing tags (e.g. FANUC USB upload format wraps each
                // path assignment section with a bare <OXX.PN> tag that has no code body).
                if (!body.trim()) { continue; }
                programName = chMatch[1];
                const channel = chMatch[2];
                channels.set(channel, `${programName}\n${body}`.trimEnd());
            }
        }

        if (channels.size === 0) {
            const normalizedContent = content.trimEnd();
            const firstLine = normalizedContent.split(/\r?\n/, 1)[0]?.trim();
            if (firstLine && /^O[A-Za-z0-9_]+$/.test(firstLine)) {
                programName = firstLine;
            }
            channels.set('1', normalizedContent);
        }

        return { header, channels, programName };
    }

    private assemblePAFile(header: string, channels: Map<string, string>, fallbackProgramName = 'O0001') {
        let res = header.trimEnd() + (header.trimEnd() ? '\n' : '');

        let progName = fallbackProgramName;
        for (let i = 1; i <= 3; i++) {
            const text = channels.get(i.toString()) || '';
            const firstLine = text.split(/\r?\n/, 1)[0]?.trim();
            if (firstLine && /^O[A-Za-z0-9_]+$/.test(firstLine)) {
                progName = firstLine;
                break;
            }
        }

        for (let i = 1; i <= 3; i++) {
            const ch = i.toString();
            if (channels.has(ch)) {
                let text = channels.get(ch)?.trimEnd() || '';
                const lines = text.split(/\r?\n/);
                const firstLine = lines[0]?.trim();
                const channelProgramName = firstLine && /^O[A-Za-z0-9_]+$/.test(firstLine) ? firstLine : progName;
                const body = (firstLine && /^O[A-Za-z0-9_]+$/.test(firstLine) ? lines.slice(1).join('\n') : text).trimEnd();
                text = `<${channelProgramName}.P${i}>`;
                if (body) {
                    text += `\n${body}`;
                }
                res += text + '\n\n';
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
        const pendingUntitledTemplate = this.pendingUntitledTemplates.get(uri.toString());
        const document = new NCDocument(uri, isSingleFile, pendingUntitledTemplate?.activeChannel ?? activeChannel, baseName);
        if (pendingUntitledTemplate) {
            this.pendingUntitledTemplates.delete(uri.toString());
            document.channelsContent = pendingUntitledTemplate.channels;
            document.paProgramName = pendingUntitledTemplate.programName;
            return document;
        }
        
        if (openContext.untitledDocumentData) {
            const textData = Buffer.from(openContext.untitledDocumentData).toString('utf8');
            if (isSingleFile) {
                const parsed = this.parsePAFile(textData);
                document.channelsContent = parsed.channels;
                document.paHeaderContent = parsed.header;
                document.paProgramName = parsed.programName;
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
                document.paProgramName = parsed.programName;
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
            const assembled = this.assemblePAFile(document.paHeaderContent, document.channelsContent, document.paProgramName);
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
            const assembled = this.assemblePAFile(document.paHeaderContent, document.channelsContent, document.paProgramName);
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
                document.paProgramName = parsed.programName;
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
            backupData = this.assemblePAFile(document.paHeaderContent, document.channelsContent, document.paProgramName);
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
        this.panelDocuments.set(webviewPanel, document);
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
            this.panelDocuments.delete(webviewPanel);
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
                case 'SELECT_USB_DIRECTORY':
                    await selectUsbDirectory(webviewPanel.webview);
                    return;
                case 'REQUEST_ACTIVE_PROGRAM_FOR_UPLOAD': {
                    const uploadRequest = this.getActiveProgramUploadRequest(String(e.pathId || ''));
                    if (!uploadRequest) {
                        vscode.window.showWarningMessage('No active NC program content is available to push.');
                        return;
                    }

                    webviewPanel.webview.postMessage({
                        type: 'DO_TRANSFER_UPLOAD',
                        pathId: uploadRequest.pathId,
                        content: uploadRequest.content,
                    });
                    return;
                }
            }
        });
    }

    public getActiveWebviewPanel(): vscode.WebviewPanel | undefined {
        return this.activeWebviewPanel;
    }

    public insertTemplateIntoActiveEditor(payload: TemplateInsertRequest): boolean {
        const activePanel = this.activeWebviewPanel;
        if (!activePanel) {
            return false;
        }

        void activePanel.webview.postMessage({ type: 'TEMPLATE_INSERT_REQUEST', payload });
        return true;
    }

    public getActiveProgramUploadRequest(pathId: string): { pathId: string; content: string } | undefined {
        const activePanel = this.activeWebviewPanel;
        const document = activePanel ? this.panelDocuments.get(activePanel) : undefined;
        if (!document) {
            return undefined;
        }

        if (pathId === 'PA') {
            return {
                pathId,
                content: this.assemblePAFile(document.paHeaderContent, document.channelsContent, document.paProgramName),
            };
        }

        if (!this.isChannelId(pathId)) {
            return undefined;
        }

        const content = document.channelsContent.get(pathId);
        return content ? { pathId, content } : undefined;
    }

    public async openTemplateAsUntitledProgram(payload: TemplateInsertRequest): Promise<void> {
        const activeChannel = this.isChannelId(payload.channelId) ? payload.channelId : '1';
        const channels = this.getTemplateChannels(payload, activeChannel);
        const programName = this.getProgramName(channels) || 'O0001';
        const untitledUri = vscode.Uri.parse(`untitled:Untitled-Template-${this.untitledTemplateCounter++}.PA`);

        this.pendingUntitledTemplates.set(untitledUri.toString(), { channels, activeChannel, programName });
        await vscode.commands.executeCommand('vscode.openWith', untitledUri, NCEditorProvider.viewType);
    }

    private getTemplateChannels(payload: TemplateInsertRequest, activeChannel: string): Map<string, string> {
        const channels = new Map<string, string>();

        if (payload.multiChannelContent) {
            for (const [channel, content] of Object.entries(payload.multiChannelContent)) {
                if (this.isChannelId(channel) && content) {
                    channels.set(channel, content);
                }
            }
        }

        if (channels.size === 0 && payload.content) {
            channels.set(activeChannel, payload.content);
        }

        return channels;
    }

    private getProgramName(channels: Map<string, string>): string | undefined {
        for (const content of channels.values()) {
            const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
            if (firstLine && /^O[A-Za-z0-9_]+$/.test(firstLine)) {
                return firstLine;
            }
        }

        return undefined;
    }

    private isChannelId(channel: string): channel is '1' | '2' | '3' {
        return channel === '1' || channel === '2' || channel === '3';
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
        const transferProtocol = config.get<string>('transferProtocol') || 'none';
        const defaultIp = ptmConfig.get<string>('defaultIpAddress') || '192.168.1.1';
        const usbDefaultRootPath = vscode.workspace.getConfiguration('ncedit7lab.usb').get<string>('defaultRootPath')?.trim() || '';
        const transferDefaultIp = transferProtocol === 'usb' ? usbDefaultRootPath : defaultIp;

        return {
            backendPort: this.backendPort,
            backendBaseUrl: resolveBackendBaseUrl(config.get<string>('backendBaseUrl'), this.backendPort),
            ptmDefaultIp: defaultIp,
            transferDefaultIp,
            transferProtocol,
            transferDriverPath: config.get<string>('transferDriverPath') || '',
            themeMode: resolveThemeMode(config.get<string>('theme.mode') || 'vscode'),
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
                const asDistResourceUri = (filePath: string) => webview.asWebviewUri(vscode.Uri.joinPath(distPath, ...filePath.split('/'))).toString();
                htmlContent = rawHtml.replace(/(href|src)="\/([^"]*)"/g, (match, attr, filePath) => {
                    return `${attr}="${asDistResourceUri(filePath)}"`;
                });

                const ptmConfig = vscode.workspace.getConfiguration('ncedit7lab.ptm');
                const layoutConfig = vscode.workspace.getConfiguration('ncedit7lab.layout');
                const defaultIp = ptmConfig.get<string>('defaultIpAddress') || '192.168.1.1';
                const transferProtocol = vscode.workspace.getConfiguration('ncedit7lab').get<string>('transferProtocol') || 'none';
                const usbDefaultRootPath = vscode.workspace.getConfiguration('ncedit7lab.usb').get<string>('defaultRootPath')?.trim() || '';
                const transferDefaultIp = transferProtocol === 'usb' ? usbDefaultRootPath : defaultIp;
                const transferDriverPath = vscode.workspace.getConfiguration('ncedit7lab').get<string>('transferDriverPath') || '';
                const themeMode = resolveThemeMode(vscode.workspace.getConfiguration('ncedit7lab').get<string>('theme.mode') || 'vscode');
                const ptmPlacement = layoutConfig.get<string>('ptmPlacement') || 'external-panel';
                const showPtmTransfer = vscode.workspace.getConfiguration('ncedit7lab').get<boolean>('showPtmTransfer') ?? false;
                const showDrawPanel = vscode.workspace.getConfiguration('ncedit7lab').get<boolean>('showDrawPanel') ?? true;
                const showTemplatesPanel = vscode.workspace.getConfiguration('ncedit7lab').get<boolean>('showTemplatesPanel') ?? true;
                const templatesPlacement = vscode.workspace.getConfiguration('ncedit7lab').get<string>('templatesPlacement') || 'workbench-left';
                const backendBaseUrl = resolveBackendBaseUrl(vscode.workspace.getConfiguration('ncedit7lab').get<string>('backendBaseUrl'), this.backendPort);
                const templateSeedUrl = asDistResourceUri('templates.json');

                const scriptInjection = `
                <script>
                    window.backendPort = ${this.backendPort};
                    window.backendBaseUrl = ${scriptValue(backendBaseUrl)};
                    window.ptmDefaultIp = ${scriptValue(defaultIp)};
                    window.ncedit7labHostMode = "vscode-editor";
                    window.vscodeConfig = {
                        backendPort: ${this.backendPort},
                        backendBaseUrl: ${scriptValue(backendBaseUrl)},
                        ptmDefaultIp: ${scriptValue(defaultIp)},
                        transferDefaultIp: ${scriptValue(transferDefaultIp)},
                        transferProtocol: ${scriptValue(transferProtocol)},
                        transferDriverPath: ${scriptValue(transferDriverPath)},
                        themeMode: ${scriptValue(themeMode)},
                        hostMode: "vscode-editor",
                        ptmPlacement: ${scriptValue(ptmPlacement)},
                        showPtmTransfer: ${showPtmTransfer},
                        showTransferPanel: ${showPtmTransfer},
                        showDrawPanel: ${showDrawPanel},
                        showTemplatesPanel: ${showTemplatesPanel},
                        templatesPlacement: ${scriptValue(templatesPlacement)},
                        seedDefaultTemplates: true,
                        templateStorageMode: "local",
                        templateSeedUrl: ${scriptValue(templateSeedUrl)}
                    };
                    window.vscodeApi = window.vscodeApi || acquireVsCodeApi();
                    window.ncedit7labApplyTemplateInsert = (payload, attempt = 0) => {
                        if (!payload || typeof payload.channelId !== 'string') {
                            return;
                        }

                        const selector = 'nc-channel-pane[data-channel="' + payload.channelId + '"] nc-code-pane';
                        const codePane = document.querySelector(selector) || Array.from(document.querySelectorAll('nc-code-pane')).find(pane => pane.channelId === payload.channelId);
                        if (codePane && typeof codePane.applyTemplateInsert === 'function') {
                            codePane.applyTemplateInsert(payload);
                            if (codePane.editor && typeof codePane.editor.focus === 'function') {
                                codePane.editor.focus();
                            }
                            return;
                        }

                        if (attempt < 20) {
                            window.setTimeout(() => window.ncedit7labApplyTemplateInsert(payload, attempt + 1), 50);
                        }
                    };
                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.type === 'FILES_OPENED' || message.type === 'FILE_UPDATED_EXTERNALLY') {
                            window.dispatchEvent(new CustomEvent('vscode:files-opened', { detail: message }));
                        }
                        if (message.type === 'TEMPLATE_INSERT_REQUEST') {
                            window.ncedit7labApplyTemplateInsert(message.payload);
                        }
                    });
                    window.addEventListener('DOMContentLoaded', () => {
                        window.vscodeApi.postMessage({ type: 'ready' });
                    });
                    window.addEventListener('vscode:file-changed', event => {
                        window.vscodeApi.postMessage({ type: 'changed', channel: event.detail.channel, text: event.detail.text });
                    });
                </script>
                <style>
                    html, body { padding: 0 !important; }
                </style>
                `;
                htmlContent = htmlContent.replace('<head>', `<head>\n${scriptInjection}`);
            }
        } catch (error) {
            console.error('Failed to load Vite index.html', error);
        }
        return htmlContent;
    }
}


