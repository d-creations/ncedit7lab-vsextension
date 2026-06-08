# NCEdit7Lab CNC Editor (Beta)

A fully integrated CNC Editor for VS Code, powered by ncedit7lab.

<!-- TODO: Add a screenshot or GIF here showcasing the editor in action -->
<!-- ![Screenshot of the extension](link-to-screenshot.png) -->

## Features
- **Integrated Editor:** Fully integrated ncedit7lab CNC editor directly within VS Code.
- **Offline Ready:** Embedded Python backend for standalone processing (Focas services, NC plotting)—perfect for offline enterprise environments.
- **Machine Support:** Initial implementation for select CNC machines.

## How to use
*(TODO: Add instructions here: e.g., Open a `.nc` file, click on the NCEdit7Lab icon in the side panel, or run the command NCEdit7Lab: Start)*

## Contact & Links
- **Feedback:** For any improvement, NC Code or file extention that is not supported yet, please email damian.roth@d-creations.org or reach out on [Instagram @d_creations91](https://www.instagram.com/d_creations91).
- **Web Version:** Try the [web version of ncedit7lab](https://ncedit7lab.d-creations.org/).

---

<details>
<summary>Development & Build Instructions</summary>

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
</details>
