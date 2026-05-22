# ncedit7lab-vsextension

A VS Code extension for the ncedit7lab CNC Editor.
- Beta Version 

- vor any improvement message to damian.roth@d-creations.org
[https://www.instagram.com/d_creations91](https://www.instagram.com/d_creations91)
## Features
- Fully integrated ncedit7lab CNC editor within VS Code.
- Embedded Python backend for standalone processing (Focas services, NC plotting).
- Seamlessly packaged and ready for offline enterprise environments.
- impement first machines

## Development & Build Instructions

This project requires compiling the TypeScript extension, downloading the portable embedded Python runtime, grabbing frontend UI assets, and aggregating licenses.

To completely build and aggregate all dependencies into the final bundle folder:
```sh
npm install
npm run bundle
```

This command will sequentially:
1. `setup:python`: Download and extract embedded Python (3.11).
2. `generate:licenses`: Extract dependency licenses for Node and Python, generating the `ThirdPartyNotices.txt` file.
3. Pull in required UI assets to the distribution bundle.

### Packaging
To generate the final `.vsix` package for publishing:
```sh
vsce package
```

### Publishing documentation
For packaging and publish-specific guidance, see [PUBLISHING.md](PUBLISHING.md).

## License
Provided under the MIT License. See the `LICENSE` file for details. 

**Third-Party Notices:**
This extension bundles open-source software. All third-party software license information is aggregated during the build process and distributed within the extension package inside `ThirdPartyNotices.txt`.
