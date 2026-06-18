import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

type WorkbenchTab = 'variables' | 'errors' | 'transfer' | 'templates';

export interface TemplateInsertRequest {
    channelId: string;
    content: string;
    mode?: 'insertAtCursor' | 'replaceSelection' | 'appendToDocument' | 'newProgram' | 'replaceDocument' | string;
    templateId?: string;
    multiChannelContent?: Record<string, string>;
}

interface WorkbenchPanelOptions {
    viewContainerId?: string;
    defaultTab?: WorkbenchTab;
    templatesPlacement?: 'workbench-right' | 'workbench-left' | 'disabled';
    hostMode?: 'vscode-panel' | 'vscode-templates';
    onTemplateInsertRequest?: (payload: TemplateInsertRequest) => void;
}

export class WorkbenchPanelWebviewViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ncedit7lab.workbenchPanelView';
    private currentWebviewView?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _backendPort: number,
        private readonly options: WorkbenchPanelOptions = {}
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this.currentWebviewView = webviewView;
        const distPath = vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'ncedit7lab', 'dist');
        
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri, distPath]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, distPath);

        // Listen for messages from the webview
        webviewView.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'ready':
                        this.updateConfig(this.getCurrentWebviewConfig());
                        if (this.options.defaultTab) {
                            await this.postMessage({ type: 'OPEN_WORKBENCH_PANEL', tab: this.options.defaultTab });
                        }
                        break;
                    case 'TEMPLATE_INSERT_REQUEST':
                        this.options.onTemplateInsertRequest?.(message.payload as TemplateInsertRequest);
                        break;
                    case 'SAVE_TRANSFER_FILE':
                        try {
                            if (!vscode.workspace.workspaceFolders) {
                                vscode.window.showErrorMessage("Open a workspace folder first to pull files.");
                                return;
                            }
                            const wsPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
                            let targetFileName = message.fileName;
                            let filePath = path.join(wsPath, targetFileName);
                            
                            // Check if file already exists
                            if (fs.existsSync(filePath)) {
                                const choice = await vscode.window.showWarningMessage(
                                    `File ${targetFileName} already exists in the workspace. Overwrite it?`,
                                    { modal: true },
                                    "Overwrite", "Save as Copy"
                                );
                                
                                if (!choice) return; // User cancelled
                                
                                if (choice === "Save as Copy") {
                                    const ext = path.extname(targetFileName);
                                    const base = path.basename(targetFileName, ext);
                                    let counter = 1;
                                    targetFileName = `${base}_Copy${ext}`;
                                    filePath = path.join(wsPath, targetFileName);
                                    
                                    while (fs.existsSync(filePath)) {
                                        counter++;
                                        targetFileName = `${base}_Copy_${counter}${ext}`;
                                        filePath = path.join(wsPath, targetFileName);
                                    }
                                }
                            }

                            // Save file physically to workspace root
                            fs.writeFileSync(filePath, message.content, 'utf8');
                            
                            // Open it explicitly with our custom editor!
                            await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(filePath), 'ncedit7lab.editor');
                            vscode.window.showInformationMessage(`Pulled ${targetFileName} to workspace.`);
                        } catch (err) {
                            vscode.window.showErrorMessage(`Failed to pull PTM file: ${err}`);
                        }
                        break;
                    case 'COMPARE_TRANSFER_FILE':
                        try {
                            if (!vscode.workspace.workspaceFolders) {
                                vscode.window.showErrorMessage("Open a workspace folder first to compare files.");
                                return;
                            }
                            const wsRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
                            const localFileUri = vscode.Uri.file(path.join(wsRoot, message.fileName));
                            
                            // Check if local file exists
                            if (!fs.existsSync(localFileUri.fsPath)) {
                                vscode.window.showErrorMessage(`File ${message.fileName} does not exist in workspace. Pull it first to compare.`);
                                return;
                            }

                            const localData = await vscode.workspace.fs.readFile(localFileUri);
                            const localContent = Buffer.from(localData).toString('utf8');

                            // Create virtual .txt documents so VS Code uses the native text diff instead of the custom editor
                            const tempLocalUri = vscode.Uri.parse(`untitled:Local_${message.fileName}.txt`);
                            const tempRemoteUri = vscode.Uri.parse(`untitled:Machine_${message.fileName}.txt`);

                            const editLocal = new vscode.WorkspaceEdit();
                            editLocal.insert(tempLocalUri, new vscode.Position(0, 0), localContent);
                            await vscode.workspace.applyEdit(editLocal);

                            const editRemote = new vscode.WorkspaceEdit();
                            editRemote.insert(tempRemoteUri, new vscode.Position(0, 0), message.content);
                            await vscode.workspace.applyEdit(editRemote);

                            vscode.commands.executeCommand(
                                'vscode.diff',
                                tempLocalUri,
                                tempRemoteUri,
                                `Local vs Machine: ${message.fileName}`
                            );
                        } catch (err) {
                            vscode.window.showErrorMessage(`Failed to compare PTM file: ${err}`);
                        }
                        break;
                    case 'UPLOAD_DROPPED_VSCODE_FILE':
                        try {
                            let targetFsPath = '';
                            if (message.codeResources && message.codeResources.length > 5) {
                                targetFsPath = vscode.Uri.parse(JSON.parse(message.codeResources)[0]).fsPath;
                            } else if (message.uriList && message.uriList.length > 5) {
                                targetFsPath = vscode.Uri.parse(message.uriList.split('\n')[0].trim()).fsPath;
                            } else if (message.plainText && message.plainText.length > 3) {
                                // Sometimes vscode just gives the absolute path or file:// uri in plain text
                                targetFsPath = message.plainText.startsWith('file://') ? vscode.Uri.parse(message.plainText).fsPath : message.plainText;
                            }

                            // Trim any accidental quotes on windows paths
                            if (targetFsPath.startsWith('"') && targetFsPath.endsWith('"')) {
                                targetFsPath = targetFsPath.slice(1, -1);
                            }

                            if (!targetFsPath || !fs.existsSync(targetFsPath)) {
                                vscode.window.showErrorMessage(`Drop failed. VS Code did not provide a valid file path. Path extracted: "${targetFsPath}" from Data: ${message.types}`);
                                return;
                            }

                            // Read the file and send back to WebView to perform the upload
                            const fileContent = fs.readFileSync(targetFsPath, 'utf8');
                            webviewView.webview.postMessage({
                                type: 'DO_FOCfAS_UPLOAD',
                                pathId: message.pathId,
                                content: fileContent
                            });

                        } catch(err) {
                            vscode.window.showErrorMessage(`Failed to read dropped file: ${err}`);
                        }
                        break;
                }
            },
            undefined
        );
    }

    public postMessage(message: unknown): Thenable<boolean> | undefined {
        return this.currentWebviewView?.webview.postMessage(message);
    }

    public updateConfig(config: Record<string, unknown>): Thenable<boolean> | undefined {
        return this.postMessage({ type: 'UPDATE_CONFIG', config });
    }

    public setTemplatesPlacement(templatesPlacement: 'workbench-right' | 'workbench-left' | 'disabled'): void {
        this.options.templatesPlacement = templatesPlacement;
    }

    private getCurrentWebviewConfig(): Record<string, unknown> {
        const ptmConfig = vscode.workspace.getConfiguration('ncedit7lab.ptm');
        const layoutConfig = vscode.workspace.getConfiguration('ncedit7lab.layout');
        const config = vscode.workspace.getConfiguration('ncedit7lab');

        return {
            backendPort: this._backendPort,
            backendBaseUrl: config.get<string>('backendBaseUrl')?.trim() || `http://127.0.0.1:${this._backendPort}`,
            ptmDefaultIp: ptmConfig.get<string>('defaultIpAddress') || 'DEMO',
            transferDefaultIp: ptmConfig.get<string>('defaultIpAddress') || 'DEMO',
            transferProtocol: config.get<string>('transferProtocol') || 'none',
            transferDriverPath: config.get<string>('transferDriverPath') || '',
            themeMode: config.get<string>('theme.mode') || 'vscode',
            hostMode: this.options.hostMode || 'vscode-panel',
            ptmPlacement: layoutConfig.get<string>('ptmPlacement') || 'external-panel',
            showPtmTransfer: config.get<boolean>('showPtmTransfer') ?? false,
            showTransferPanel: config.get<boolean>('showPtmTransfer') ?? false,
            showDrawPanel: config.get<boolean>('showDrawPanel') ?? true,
            showTemplatesPanel: config.get<boolean>('showTemplatesPanel') ?? true,
            templatesPlacement: this.options.templatesPlacement || 'workbench-right',
            seedDefaultTemplates: true,
            templateStorageMode: 'local',
            templateSeedUrl: '/templates.json',
        };
    }

    public async reveal(tab?: WorkbenchTab, channel?: string): Promise<void> {
        const containerId = this.options.viewContainerId || 'ncedit7labBottomPanel';

        if (!this.options.viewContainerId) {
            await vscode.commands.executeCommand('workbench.action.focusPanel');
        }

        await vscode.commands.executeCommand(`workbench.view.extension.${containerId}`);

        const view = this.currentWebviewView as vscode.WebviewView & { show?: (preserveFocus?: boolean) => void };
        view.show?.(true);

        if (tab || channel) {
            await this.postMessage({ type: 'OPEN_WORKBENCH_PANEL', tab, channel });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview, distPath: vscode.Uri): string {
        const indexHtmlPath = vscode.Uri.joinPath(distPath, 'index.html');
        
        let htmlContent = '<!DOCTYPE html><html lang="en"><body><h1>UI Not Found</h1><p>Ensure the frontend has been built to /dist/.</p></body></html>';
        try {
            if (fs.existsSync(indexHtmlPath.fsPath)) {
                let rawHtml = fs.readFileSync(indexHtmlPath.fsPath, 'utf8');
                const basePathUri = webview.asWebviewUri(distPath);
                
                // Replace Vite asset references
                htmlContent = rawHtml.replace(/(href|src)="\/([^"]*)"/g, (match, attr, filePath) => {
                    return `${attr}="${basePathUri.toString()}/${filePath}"`;
                });

                const ptmConfig = vscode.workspace.getConfiguration('ncedit7lab.ptm');
                const layoutConfig = vscode.workspace.getConfiguration('ncedit7lab.layout');
                const transferProtocol = vscode.workspace.getConfiguration('ncedit7lab').get<string>('transferProtocol') || 'none';
                const transferDriverPath = vscode.workspace.getConfiguration('ncedit7lab').get<string>('transferDriverPath') || '';
                const themeMode = vscode.workspace.getConfiguration('ncedit7lab').get<string>('theme.mode') || 'vscode';
                const defaultIp = ptmConfig.get<string>('defaultIpAddress') || 'DEMO';
                const ptmPlacement = layoutConfig.get<string>('ptmPlacement') || 'external-panel';
                const showPtmTransfer = vscode.workspace.getConfiguration('ncedit7lab').get<boolean>('showPtmTransfer') ?? false;
                const showDrawPanel = vscode.workspace.getConfiguration('ncedit7lab').get<boolean>('showDrawPanel') ?? true;
                const showTemplatesPanel = vscode.workspace.getConfiguration('ncedit7lab').get<boolean>('showTemplatesPanel') ?? true;
                const templatesPlacement = this.options.templatesPlacement || 'workbench-right';
                const backendBaseUrl = vscode.workspace.getConfiguration('ncedit7lab').get<string>('backendBaseUrl')?.trim() || `http://127.0.0.1:${this._backendPort}`;
                const templateSeedUrl = `${basePathUri.toString()}/templates.json`;

                // Inject our configuration
                const scriptInjection = `
                <script>
                    window.backendPort = ${this._backendPort};
                    window.backendBaseUrl = "${backendBaseUrl}";
                    window.ptmDefaultIp = "${defaultIp}";
                    window.ncedit7labSupportedTransferPaths = [1, 2,3];
                    window.vscodeConfig = {
                        backendPort: ${this._backendPort},
                        backendBaseUrl: "${backendBaseUrl}",
                        ptmDefaultIp: "${defaultIp}",
                        transferDefaultIp: "${defaultIp}",
                        transferProtocol: "${transferProtocol}",
                        transferDriverPath: "${transferDriverPath.replace(/\\/g, '\\\\')}",
                        themeMode: "${themeMode}",
                        hostMode: "${this.options.hostMode || 'vscode-panel'}",
                        ptmPlacement: "${ptmPlacement}",
                        showPtmTransfer: ${showPtmTransfer},
                        showTransferPanel: ${showPtmTransfer},
                        showDrawPanel: ${showDrawPanel},
                        showTemplatesPanel: ${showTemplatesPanel},
                        templatesPlacement: "${templatesPlacement}",
                        seedDefaultTemplates: true,
                        templateStorageMode: "local",
                        templateSeedUrl: "${templateSeedUrl}"
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

                    window.ncedit7labTemplateBridge = () => {
                        if (window.vscodeConfig?.hostMode !== 'vscode-templates' && window.vscodeConfig?.hostMode !== 'vscode-panel') {
                            return;
                        }

                        const postTemplateInsert = payload => {
                            if (!payload || typeof payload.channelId !== 'string' || typeof payload.content !== 'string') {
                                return;
                            }
                            window.vscodeApi.postMessage({ type: 'TEMPLATE_INSERT_REQUEST', payload });
                        };

                        const patchPanel = panel => {
                            const service = panel?.insertionService;
                            if (!service || service.__ncedit7labTemplateBridgePatched) {
                                return Boolean(service?.__ncedit7labTemplateBridgePatched);
                            }

                            Object.defineProperty(service, '__ncedit7labTemplateBridgePatched', {
                                value: true,
                                configurable: false,
                                enumerable: false,
                                writable: false,
                            });

                            const originalInsertTemplate = service.insertTemplate?.bind(service);
                            if (originalInsertTemplate) {
                                service.insertTemplate = async (templateId, channelId, mode) => {
                                    const inserted = await originalInsertTemplate(templateId, channelId, mode);
                                    if (inserted) {
                                        const template = await service.catalogService?.getTemplate?.(templateId);
                                        if (template) {
                                            postTemplateInsert({
                                                channelId,
                                                content: template.content,
                                                mode: mode ?? template.insertMode,
                                                templateId: template.id,
                                                multiChannelContent: template.multiChannelContent,
                                            });
                                        }
                                    }
                                    return inserted;
                                };
                            }

                            const originalInsertMultiChannelTemplate = service.insertMultiChannelTemplate?.bind(service);
                            if (originalInsertMultiChannelTemplate) {
                                service.insertMultiChannelTemplate = async (templateId, mode) => {
                                    const inserted = await originalInsertMultiChannelTemplate(templateId, mode);
                                    if (inserted) {
                                        const template = await service.catalogService?.getTemplate?.(templateId);
                                        if (template?.multiChannelContent) {
                                            Object.entries(template.multiChannelContent).forEach(([channelId, content]) => {
                                                if ((channelId === '1' || channelId === '2' || channelId === '3') && content) {
                                                    postTemplateInsert({
                                                        channelId,
                                                        content,
                                                        mode: mode ?? template.insertMode,
                                                        templateId: template.id,
                                                    });
                                                }
                                            });
                                        }
                                    }
                                    return inserted;
                                };
                            }

                            return true;
                        };

                        const patchPanels = () => document.querySelectorAll('nc-templates-panel').forEach(patchPanel);
                        customElements.whenDefined('nc-templates-panel').then(() => {
                            patchPanels();
                            new MutationObserver(patchPanels).observe(document.body, { childList: true, subtree: true });
                        });
                    };

                    window.vscodeApi = window.vscodeApi || acquireVsCodeApi();
                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.type === 'FILES_OPENED' || message.type === 'FILE_UPDATED_EXTERNALLY') {
                            window.dispatchEvent(new CustomEvent('vscode:files-opened', { detail: message }));
                        }
                        if (message.type === 'WORKBENCH_BRIDGE') {
                            window.dispatchEvent(new CustomEvent('vscode:workbench-bridge', { detail: message }));
                        }
                        if (message.type === 'OPEN_WORKBENCH_PANEL') {
                            if (message.channel) {
                                window.dispatchEvent(new CustomEvent('vscode:files-opened', { detail: { activeChannel: message.channel } }));
                            }
                            window.dispatchEvent(new CustomEvent('vscode:workbench-panel-command', { detail: { tab: message.tab, channel: message.channel } }));
                        }
                    });
                    window.addEventListener('DOMContentLoaded', () => {
                        window.applyncedit7labTransferPatch();
                        window.ncedit7labTemplateBridge();
                        window.vscodeApi.postMessage({ type: 'ready' });
                    });
                </script>
                <style>
                    /* Force the app container to host the workbench panel content tightly */
                    html, body { height: 100%; overflow: hidden; }
                    #app { height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
                    #app-root { height: 100%; width: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
                    nc-workbench-panel-app { flex: 1; min-height: 0; height: 100%; width: 100%; }
                </style>
                `;
                htmlContent = htmlContent.replace('<head>', '<head>' + scriptInjection);
            }
        } catch (e) {
            return `<!DOCTYPE html><html><body>Error loading UI: ${e}</body></html>`;
        }

        return htmlContent;
    }
}
