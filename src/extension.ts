import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { NCEditorProvider } from './NCEditorProvider';
import { WorkbenchPanelWebviewViewProvider } from './BottomViewProvider';

type WorkbenchTab = 'variables' | 'errors' | 'transfer';

let backendProcess: cp.ChildProcess | undefined;

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
		return configuredBaseUrl || `http://127.0.0.1:${backendPort}`;
	};

    const getEditorWebviewConfig = () => {
        const ptmConfig = vscode.workspace.getConfiguration('ncedit7lab.ptm');
        const layoutConfig = vscode.workspace.getConfiguration('ncedit7lab.layout');
        const transferConfig = vscode.workspace.getConfiguration('ncedit7lab');
        const themeMode = vscode.workspace.getConfiguration('ncedit7lab').get<string>('theme.mode') || 'vscode';
        return {
            backendPort,
            backendBaseUrl: getBackendBaseUrl(),
            ptmDefaultIp: ptmConfig.get<string>('defaultIpAddress') || '192.168.1.1',
            transferDefaultIp: ptmConfig.get<string>('defaultIpAddress') || '192.168.1.1',
            transferProtocol: transferConfig.get<string>('transferProtocol') || 'none',
            transferDriverPath: transferConfig.get<string>('transferDriverPath') || '',
            themeMode,
            hostMode: 'vscode-editor',
            ptmPlacement: layoutConfig.get<string>('ptmPlacement') || 'external-panel',
        };
    };

    const getPanelWebviewConfig = () => {
        const ptmConfig = vscode.workspace.getConfiguration('ncedit7lab.ptm');
        const transferConfig = vscode.workspace.getConfiguration('ncedit7lab');
        const themeMode = vscode.workspace.getConfiguration('ncedit7lab').get<string>('theme.mode') || 'vscode';
        return {
            backendPort,
            backendBaseUrl: getBackendBaseUrl(),
            ptmDefaultIp: ptmConfig.get<string>('defaultIpAddress') || 'DEMO',
            transferDefaultIp: ptmConfig.get<string>('defaultIpAddress') || 'DEMO',
            transferProtocol: transferConfig.get<string>('transferProtocol') || 'none',
            transferDriverPath: transferConfig.get<string>('transferDriverPath') || '',
            themeMode,
            hostMode: 'vscode-panel',
            ptmPlacement: 'disabled',
        };
    };

    type WorkbenchRelayMessage =
        | { type: 'OPEN_WORKBENCH_PANEL'; tab?: WorkbenchTab; channel?: string }
        | { type: 'FILES_OPENED'; isSingleFile: boolean; activeChannel: string; channels: Record<string, string> }
        | { type: 'FILE_UPDATED_EXTERNALLY'; channels: Record<string, string> }
        | { type: 'FILE_UPDATED_EXTERNALLY'; channel: string; text: string; activeChannel?: string }
        | { type: 'WORKBENCH_BRIDGE'; eventType: 'EXECUTION_COMPLETED'; payload: { channelId: string; result: { variableSnapshotEntries: Array<[number, number]>; errors: unknown[] } } }
        | { type: 'WORKBENCH_BRIDGE'; eventType: 'EXECUTION_ERROR'; payload: { channelId: string; error: { message: string } } }
        | { type: 'WORKBENCH_BRIDGE'; eventType: 'PLOT_CLEARED'; payload: Record<string, never> };

    const workbenchPanelProvider = new WorkbenchPanelWebviewViewProvider(context.extensionUri, backendPort);
    const editorProvider = new NCEditorProvider(context, backendPort, (message: WorkbenchRelayMessage) => {
        if (message.type === 'OPEN_WORKBENCH_PANEL') {
            void workbenchPanelProvider.reveal(message.tab, message.channel);
            return;
        }

        void workbenchPanelProvider.postMessage(message);
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('ncedit7lab.openWorkbenchPanel', async (tab?: 'variables' | 'errors' | 'transfer') => {
            await workbenchPanelProvider.reveal(tab);
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
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (
                event.affectsConfiguration('ncedit7lab') ||
                event.affectsConfiguration('ncedit7lab.ptm') ||
                event.affectsConfiguration('ncedit7lab.layout')
            ) {
                editorProvider.updateConfig(getEditorWebviewConfig());
                void workbenchPanelProvider.updateConfig(getPanelWebviewConfig());
            }
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

