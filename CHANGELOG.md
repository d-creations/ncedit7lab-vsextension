# Changelog

All notable changes to **NCEdit7Lab** will be documented here.

## [1.0.5] - 2026-08-13

### Changed
- Updated the `ncedit7lab` frontend Node module to version `1.0.6`, including the new VS Code branding assets.
- Updated the `ncplot7py` Python package from the `ncedit7plot` project to version `0.1.4`, incorporating the latest NC code plotting changes.

## [1.0.4] - 2026-08-02

### Changed
- Updated the `ncedit7lab` frontend Node module to version `1.0.5`.
- Updated the `ncplot7py` Python package from the `ncedit7plot` project to version `0.1.1`.

### Fixed
- Removed host-injected webview padding from the custom editor, Templates view, and Workbench panel to keep their content flush and consistently aligned in VS Code and Theia.

## [1.0.3] - 2026-07-29

### Fixed
- update node nccode7lab

## [1.0.2] - 2026-07-28

### Fixed
- `ncedit7lab.theme.mode: vscode` now correctly follows VS Code's dark/light color theme. Previously the webview did not apply any palette when set to `vscode`, causing the UI to remain in its default (light) state regardless of the active VS Code theme. The extension now resolves `vscode` to the matching built-in palette (`one-dark` for dark/high-contrast themes, `light` for light themes) using `vscode.window.activeColorTheme.kind`.
- Added `onDidChangeActiveColorTheme` listener so all open editor and workbench-panel webviews receive an `UPDATE_CONFIG` message and re-apply the correct theme whenever the user switches the VS Code color theme at runtime.

## [1.0.1] - 2026-06-24

### Added
- Marketplace keywords (`cnc`, `nc`, `mpf`, `fanuc`, `sinumerik`, `gcode`, `machining`, `manufacturing`, `siemens`) for better discoverability.
- Added `Programming Languages` marketplace category alongside `Other`.
- Support for opening files without an extension via the **Open With…** context menu.

### Changed
- Updated README: added Template Manager, Transfer Manager, and Siemens Sinumerik 840D/840Di feature descriptions.

## [1.0.0] - 2026-06-01

### Added
- Initial release of NCEdit7Lab as a VS Code extension.
- Integrated CNC editor for FANUC and Siemens Sinumerik 840D/840Di NC programs.
- NC program plotting for FANUC turning machines (toolpath, contour, motion sequence visualization).
- Variable State View for system and user variable inspection.
- Template Manager: side-panel NC snippet and program template browser.
- Transfer Manager: USB-based NC file transfer to/from CNC machines.
- Embedded Python backend for offline/standalone operation.
- Support for file extensions: `.nc`, `.mpf`, `.PA`, `.pa`, `.P1`–`.P3`, `.M`, `.S`, and `*p-2*` patterns.
