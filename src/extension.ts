import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { NCEditorProvider, TemplateInsertRequest } from './NCEditorProvider';
import { WorkbenchPanelWebviewViewProvider } from './BottomViewProvider';

type WorkbenchTab = 'variables' | 'errors' | 'transfer' | 'templates' | 'tools';
type TemplatesPlacement = 'workbench-left' | 'workbench-right' | 'disabled';
type ToolsPlacement = 'workbench-left' | 'workbench-right' | 'disabled';

let backendProcess: cp.ChildProcess | undefined;

export function resolveThemeMode(configThemeMode: string): string {
    if (configThemeMode !== 'vscode') {
        return configThemeMode;
    }
    const kind = vscode.window.activeColorTheme.kind;
    if (kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight) {
        return 'light';
    }
    return 'one-dark';
}

export function resolveBackendBaseUrl(configuredBaseUrl: string | undefined, backendPort: number): string {
    const fallbackBaseUrl = `http://127.0.0.1:${backendPort}`;
    const trimmedBaseUrl = configuredBaseUrl?.trim();
    if (!trimmedBaseUrl) {
        return fallbackBaseUrl;
    }

    try {
        const url = new URL(trimmedBaseUrl);
        const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
        if (isLoopback && url.port === '8000' && backendPort !== 8000) {
            return fallbackBaseUrl;
        }
    } catch {
        return trimmedBaseUrl;
    }

    return trimmedBaseUrl;
}

export interface SimulationConfiguration {
    gpuDefaultEnabled: boolean;
    gpuPitchMm: { min: number; max: number; default: number };
    cpuResolutionMm: { min: number; max: number; default: number };
    stockMemoryMiB: number;
    gpuStockPixelBudget: {
        min: number;
        max: number;
        default: number;
        nativeSharpness: boolean;
    };
}

export function resolveSimulationConfig(): SimulationConfiguration {
    const simConfig = vscode.workspace.getConfiguration('ncedit7lab.simulation');
    return {
        gpuDefaultEnabled: simConfig.get<boolean>('gpuDefaultEnabled') ?? true,
        gpuPitchMm: {
            min: simConfig.get<number>('gpuPitchMm.min') ?? 0.001,
            max: simConfig.get<number>('gpuPitchMm.max') ?? 5,
            default: simConfig.get<number>('gpuPitchMm.default') ?? 0.02,
        },
        cpuResolutionMm: {
            min: simConfig.get<number>('cpuResolutionMm.min') ?? 0.05,
            max: simConfig.get<number>('cpuResolutionMm.max') ?? 5,
            default: simConfig.get<number>('cpuResolutionMm.default') ?? 0.05,
        },
        stockMemoryMiB: simConfig.get<number>('stockMemoryMiB') ?? 256,
        gpuStockPixelBudget: {
            min: simConfig.get<number>('gpuStockPixelBudget.min') ?? 250000,
            max: simConfig.get<number>('gpuStockPixelBudget.max') ?? 1500000,
            default: simConfig.get<number>('gpuStockPixelBudget.default') ?? 800000,
            nativeSharpness: simConfig.get<boolean>('gpuStockPixelBudget.nativeSharpness') ?? false,
        },
    };
}

async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

export async function activate(context: vscode.ExtensionContext) {
	const backendPort = await getFreePort();
	const getBackendBaseUrl = () => {
		const configuredBaseUrl = vscode.workspace.getConfiguration('ncedit7lab').get<string>('backendBaseUrl')?.trim();
        return resolveBackendBaseUrl(configuredBaseUrl, backendPort);
	};

    const getTemplatesPlacement = (): TemplatesPlacement => {
        const placement = vscode.workspace.getConfiguration('ncedit7lab').get<string>('templatesPlacement');
        return placement === 'workbench-right' || placement === 'disabled' ? placement : 'workbench-left';
    };

    const getWorkbenchTemplatesPlacement = (): TemplatesPlacement => {
        return getTemplatesPlacement() === 'workbench-right' ? 'workbench-right' : 'disabled';
    };

    const getTemplatesViewPlacement = (): TemplatesPlacement => {
        return getTemplatesPlacement() === 'workbench-left' ? 'workbench-left' : 'disabled';
    };

    const getToolsPlacement = (): ToolsPlacement => {
        const placement = vscode.workspace.getConfiguration('ncedit7lab').get<string>('toolsPlacement');
        return placement === 'workbench-left' || placement === 'disabled' ? placement : 'workbench-right';
    };

    const getWorkbenchToolsPlacement = (): ToolsPlacement => {
        return getToolsPlacement() === 'workbench-right' ? 'workbench-right' : 'disabled';
    };

    const getToolsViewPlacement = (): ToolsPlacement => {
        return getToolsPlacement() === 'workbench-left' ? 'workbench-left' : 'disabled';
    };

    const getEditorWebviewConfig = () => {
        const ptmConfig = vscode.workspace.getConfiguration('ncedit7lab.ptm');
        const layoutConfig = vscode.workspace.getConfiguration('ncedit7lab.layout');
        const transferConfig = vscode.workspace.getConfiguration('ncedit7lab');
        const themeMode = resolveThemeMode(vscode.workspace.getConfiguration('ncedit7lab').get<string>('theme.mode') || 'vscode');
        const protocol = transferConfig.get<string>('transferProtocol') || 'none';
        const usbDefaultRootPath = vscode.workspace.getConfiguration('ncedit7lab.usb').get<string>('defaultRootPath')?.trim() || '';
        return {
            backendPort,
            backendBaseUrl: getBackendBaseUrl(),
            ptmDefaultIp: ptmConfig.get<string>('defaultIpAddress') || '192.168.1.1',
            transferDefaultIp: protocol === 'usb' ? usbDefaultRootPath : ptmConfig.get<string>('defaultIpAddress') || '192.168.1.1',
            transferProtocol: protocol,
            transferDriverPath: transferConfig.get<string>('transferDriverPath') || '',
            themeMode,
            hostMode: 'vscode-editor',
            ptmPlacement: layoutConfig.get<string>('ptmPlacement') || 'external-panel',
            showTemplatesPanel: transferConfig.get<boolean>('showTemplatesPanel') ?? true,
            templatesPlacement: transferConfig.get<string>('templatesPlacement') || 'disabled',
            toolsPlacement: transferConfig.get<string>('toolsPlacement') || 'workbench-right',
            seedDefaultTemplates: true,
            templateStorageMode: 'local',
            simulation: resolveSimulationConfig(),
        };
    };

    const getPanelWebviewConfig = () => {
        const ptmConfig = vscode.workspace.getConfiguration('ncedit7lab.ptm');
        const transferConfig = vscode.workspace.getConfiguration('ncedit7lab');
        const themeMode = resolveThemeMode(vscode.workspace.getConfiguration('ncedit7lab').get<string>('theme.mode') || 'vscode');
        const protocol = transferConfig.get<string>('transferProtocol') || 'none';
        const usbDefaultRootPath = vscode.workspace.getConfiguration('ncedit7lab.usb').get<string>('defaultRootPath')?.trim() || '';
        return {
            backendPort,
            backendBaseUrl: getBackendBaseUrl(),
            ptmDefaultIp: ptmConfig.get<string>('defaultIpAddress') || 'DEMO',
            transferDefaultIp: protocol === 'usb' ? usbDefaultRootPath : ptmConfig.get<string>('defaultIpAddress') || 'DEMO',
            transferProtocol: protocol,
            transferDriverPath: transferConfig.get<string>('transferDriverPath') || '',
            themeMode,
            hostMode: 'vscode-panel',
            ptmPlacement: 'disabled',
            showTemplatesPanel: transferConfig.get<boolean>('showTemplatesPanel') ?? true,
            templatesPlacement: getWorkbenchTemplatesPlacement(),
            toolsPlacement: getWorkbenchToolsPlacement(),
            seedDefaultTemplates: true,
            templateStorageMode: 'local',
            simulation: resolveSimulationConfig(),
        };
    };

    type WorkbenchRelayMessage =
        | { type: 'OPEN_WORKBENCH_PANEL'; tab?: WorkbenchTab; channel?: string }
        | { type: 'FILES_OPENED'; isSingleFile: boolean; activeChannel: string; channels: Record<string, string> }
        | { type: 'FILE_UPDATED_EXTERNALLY'; channels: Record<string, string> }
        | { type: 'FILE_UPDATED_EXTERNALLY'; channel: string; text: string; activeChannel?: string }
        | { type: 'WORKBENCH_BRIDGE'; eventType: 'EXECUTION_COMPLETED'; payload: { channelId: string; result: { variableSnapshotEntries: Array<[number, number]>; errors: unknown[] } } }
        | { type: 'WORKBENCH_BRIDGE'; eventType: 'EXECUTION_ERROR'; payload: { channelId: string; error: { message: string } } }
        | { type: 'WORKBENCH_BRIDGE'; eventType: 'PLOT_CLEARED'; payload: Record<string, never> }
        | { type: 'WORKBENCH_BRIDGE'; eventType: 'MACHINE_CHANGED'; payload: { machineName: string } }
        | { type: 'PROGRAM_TOOL_UPDATE_RESULT'; payload: unknown }
        | { type: 'PROGRAM_OFFSETS_UPDATE_RESULT'; payload: unknown }
        | { type: 'PROGRAM_SETUP_UPDATE_RESULT'; payload: unknown };

    let editorProvider: NCEditorProvider;
    const handleTemplateInsertRequest = (payload: TemplateInsertRequest) => {
        if (payload.mode === 'newProgram') {
            void editorProvider.openTemplateAsUntitledProgram(payload);
            return;
        }

        if (!editorProvider.insertTemplateIntoActiveEditor(payload)) {
            vscode.window.showWarningMessage('Open an NC editor before inserting a template.');
        }
    };

    const handleProgramToolUpdateRequest = (payload: unknown) => {
        if (!editorProvider.applyProgramToolUpdateRequest(payload)) {
            vscode.window.showWarningMessage('Open an NC editor before applying tool metadata.');
        }
    };
    const handleProgramOffsetsUpdateRequest = (payload: unknown) => {
        if (!editorProvider.applyProgramOffsetsUpdateRequest(payload)) {
            vscode.window.showWarningMessage('Open an NC editor before applying tool offsets.');
        }
    };
    const handleProgramSetupUpdateRequest = (payload: unknown) => {
        if (!editorProvider.applyProgramSetupUpdateRequest(payload)) {
            vscode.window.showWarningMessage('Open an NC editor before applying setup metadata.');
        }
    };

    let lastMachineName: string | undefined;

    const syncActiveEditorToPanel = (panelProvider: WorkbenchPanelWebviewViewProvider) => {
        const channels: Record<string, string> = {};
        for (const ch of ['1', '2', '3']) {
            const req = editorProvider?.getActiveProgramUploadRequest(ch);
            if (req?.content) {
                channels[ch] = req.content;
            }
        }
        if (Object.keys(channels).length > 0) {
            void panelProvider.postMessage({
                type: 'FILES_OPENED',
                isSingleFile: !channels['2'] && !channels['3'],
                activeChannel: '1',
                channels,
            });
        }
        if (lastMachineName) {
            void panelProvider.postMessage({
                type: 'WORKBENCH_BRIDGE',
                eventType: 'MACHINE_CHANGED',
                payload: { machineName: lastMachineName },
            });
        }
    };

    const workbenchPanelProvider = new WorkbenchPanelWebviewViewProvider(context.extensionUri, backendPort, {
        templatesPlacement: getWorkbenchTemplatesPlacement(),
        onTemplateInsertRequest: handleTemplateInsertRequest,
        onActiveProgramUploadRequest: (pathId: string) => editorProvider.getActiveProgramUploadRequest(pathId),
        onReady: () => syncActiveEditorToPanel(workbenchPanelProvider),
    });
    const templatesPanelProvider = new WorkbenchPanelWebviewViewProvider(context.extensionUri, backendPort, {
        viewContainerId: 'ncedit7labTemplates',
        defaultTab: 'templates',
        templatesPlacement: getTemplatesViewPlacement(),
        hostMode: 'vscode-templates',
        onTemplateInsertRequest: handleTemplateInsertRequest,
        onReady: () => syncActiveEditorToPanel(templatesPanelProvider),
    });
    const toolsPanelProvider = new WorkbenchPanelWebviewViewProvider(context.extensionUri, backendPort, {
        viewContainerId: 'ncedit7labTools',
        defaultTab: 'tools',
        toolsPlacement: getToolsViewPlacement(),
        hostMode: 'vscode-tools',
        onProgramToolUpdateRequest: handleProgramToolUpdateRequest,
        onProgramOffsetsUpdateRequest: handleProgramOffsetsUpdateRequest,
        onProgramSetupUpdateRequest: handleProgramSetupUpdateRequest,
        onReady: () => syncActiveEditorToPanel(toolsPanelProvider),
    });
    editorProvider = new NCEditorProvider(context, backendPort, (message: WorkbenchRelayMessage) => {
        if (message.type === 'WORKBENCH_BRIDGE' && message.eventType === 'MACHINE_CHANGED') {
            lastMachineName = message.payload.machineName;
        }

        if (message.type === 'OPEN_WORKBENCH_PANEL') {
            if (message.tab === 'templates') {
                void templatesPanelProvider.reveal(message.tab, message.channel);
                return;
            }

            if (message.tab === 'tools') {
                void toolsPanelProvider.reveal(message.tab, message.channel);
                syncActiveEditorToPanel(toolsPanelProvider);
                return;
            }

            void workbenchPanelProvider.reveal(message.tab, message.channel);
            return;
        }

        void workbenchPanelProvider.postMessage(message);
        void templatesPanelProvider.postMessage(message);
        void toolsPanelProvider.postMessage(message);
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('ncedit7lab.openWorkbenchPanel', async (tab?: WorkbenchTab) => {
            if (tab === 'templates') {
                await templatesPanelProvider.reveal(tab);
                return;
            }

            if (tab === 'tools') {
                await toolsPanelProvider.reveal(tab);
                return;
            }

            await workbenchPanelProvider.reveal(tab);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ncedit7lab.openTemplates', async () => {
            await templatesPanelProvider.reveal('templates');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ncedit7lab.openTools', async () => {
            await toolsPanelProvider.reveal('tools');
            syncActiveEditorToPanel(toolsPanelProvider);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ncedit7lab.find', () => {
            const activePanel = editorProvider.getActiveWebviewPanel();
            if (activePanel) {
                // Post message to Webview asking frontend to handle Search/Find
                activePanel.webview.postMessage({ type: 'TRIGGER_FIND' });
            } else {
                // Fallback to native find if the panel is not active
                vscode.commands.executeCommand('editor.action.startFindReplaceAction');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ncedit7lab.replace', () => {
            const activePanel = editorProvider.getActiveWebviewPanel();
            if (activePanel) {
                activePanel.webview.postMessage({ type: 'TRIGGER_REPLACE' });
            }
        })
    );

    // Register our custom editor provider
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            NCEditorProvider.viewType,
            editorProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );
        
        // Register the composite NC workbench panel provider
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(WorkbenchPanelWebviewViewProvider.viewType, workbenchPanelProvider)
        );

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('ncedit7lab.templatesView', templatesPanelProvider)
        );

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('ncedit7lab.toolsView', toolsPanelProvider)
        );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (
                event.affectsConfiguration('ncedit7lab') ||
                event.affectsConfiguration('ncedit7lab.ptm') ||
                event.affectsConfiguration('ncedit7lab.layout') ||
                event.affectsConfiguration('ncedit7lab.simulation')
            ) {
                workbenchPanelProvider.setTemplatesPlacement(getWorkbenchTemplatesPlacement());
                templatesPanelProvider.setTemplatesPlacement(getTemplatesViewPlacement());
                workbenchPanelProvider.setToolsPlacement(getWorkbenchToolsPlacement());
                toolsPanelProvider.setToolsPlacement(getToolsViewPlacement());
                editorProvider.updateConfig(getEditorWebviewConfig());
                void workbenchPanelProvider.updateConfig(getPanelWebviewConfig());
                void templatesPanelProvider.updateConfig({
                    ...getPanelWebviewConfig(),
                    hostMode: 'vscode-templates',
                    templatesPlacement: getTemplatesViewPlacement(),
                });
                void toolsPanelProvider.updateConfig({
                    ...getPanelWebviewConfig(),
                    hostMode: 'vscode-tools',
                    toolsPlacement: getToolsViewPlacement(),
                });
            }
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveColorTheme(() => {
            editorProvider.updateConfig(getEditorWebviewConfig());
            void workbenchPanelProvider.updateConfig(getPanelWebviewConfig());
            void templatesPanelProvider.updateConfig({
                ...getPanelWebviewConfig(),
                hostMode: 'vscode-templates',
                templatesPlacement: getTemplatesViewPlacement(),
            });
            void toolsPanelProvider.updateConfig({
                ...getPanelWebviewConfig(),
                hostMode: 'vscode-tools',
                toolsPlacement: getToolsViewPlacement(),
            });
        })
    );
	// Explicitly resolve the embedded backend from the pre-bundled dependencies
    const pythonCandidates = [
        path.join(context.extensionPath, 'bundle', 'python_embedded', 'python.exe'),
        path.join(context.extensionPath, 'python_embedded', 'python.exe'),
    ];
    const pythonPath = pythonCandidates.find(candidate => fs.existsSync(candidate));
    const backendCandidates = [
        path.join(context.extensionPath, 'bundle', 'backend'),
        path.join(context.extensionPath, 'node_modules', 'ncedit7lab', 'backend'),
    ];
    const backendDir = backendCandidates.find(candidate => fs.existsSync(candidate));

    if (!pythonPath) {
        console.warn(`Embedded Python not found. Checked: ${pythonCandidates.join(', ')}`);
    } else if (!backendDir) {
        console.warn(`Embedded backend not found. Checked: ${backendCandidates.join(', ')}`);
    } else {
        const outputChannel = vscode.window.createOutputChannel('NC-CODE7Lab Backend');
        outputChannel.appendLine(`Starting embedded backend from: ${pythonPath} on port ${backendPort}`);

        backendProcess = cp.spawn(pythonPath, ['-m', 'uvicorn', 'main_import:app', '--app-dir', backendDir, '--port', backendPort.toString()], {
            cwd: backendDir,
            detached: false,
            env: {
                ...process.env,
                ALLOWED_ORIGINS: '*',
                ALLOW_CREDENTIALS: 'false',
            },
        });

        let hasShownSuccess = false;

        backendProcess.stdout?.on('data', data => {
            const msg = data.toString();
            outputChannel.append(`[INFO] ${msg}`);
            
            if (!hasShownSuccess && (msg.includes('Application startup complete') || msg.includes('Uvicorn running on'))) {
                hasShownSuccess = true;
                vscode.window.showInformationMessage('NC-CODE7Lab PTM Backend started successfully.');
            }

            // Listen for deliberate notifications triggered by Python backend transfers
            if (msg.includes('[VSCODE_NOTIFICATION] SUCCESS:')) {
                const text = msg.split('[VSCODE_NOTIFICATION] SUCCESS:')[1].trim();
                vscode.window.showInformationMessage(text);
            }
            if (msg.includes('[VSCODE_NOTIFICATION] ERROR:')) {
                const text = msg.split('[VSCODE_NOTIFICATION] ERROR:')[1].trim();
                vscode.window.showErrorMessage(text);
            }
        });
		backendProcess.stderr?.on('data', data => {
            const msg = data.toString();
            outputChannel.append(`[ERROR] ${msg}`);
            // Uvicorn sometimes logs startup success to stderr depending on configuration
            if (!hasShownSuccess && (msg.includes('Application startup complete') || msg.includes('Uvicorn running on'))) {
                hasShownSuccess = true;
                vscode.window.showInformationMessage('NC-CODE7Lab PTM Backend started successfully.');
            }
        });
		backendProcess.on('error', error => {
            outputChannel.append(`[PROCESS ERROR] Failed to start: ${error.message}\n`);
            outputChannel.show(true);
            vscode.window.showErrorMessage(`NC-CODE7Lab Backend failed to start: ${error.message}`);
        });
		backendProcess.on('exit', code => {
            outputChannel.append(`[PROCESS EXIT] Exited with code ${code ?? 'null'}\n`);
            if (code !== 0 && code !== null) {
                outputChannel.show(true);
                vscode.window.showErrorMessage(`NC-CODE7Lab Backend unexpectedly crashed (code ${code}). Check Output panel for details.`);
            }
        });
    }
}

export function deactivate() {
	if (backendProcess) {
		backendProcess.kill();
	}
}

