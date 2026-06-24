# Changelog

All notable changes to **NCEdit7Lab** will be documented here.

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
