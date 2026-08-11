const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PYTHON_VERSION = '3.14.7';
const BITS = '64'; // AMD64
const ZIP_NAME = `python-${PYTHON_VERSION}-embed-amd64.zip`;
const DOWNLOAD_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/${ZIP_NAME}`;

const DEST_DIR = path.join(__dirname, '..', 'python_embedded');
const ZIP_PATH = path.join(__dirname, '..', ZIP_NAME);

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        console.log(`Downloading ${url} ...`);
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to get '${url}' (${response.statusCode})`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => reject(err));
        });
    });
}

async function main() {
    try {
        const pythonExe = path.join(DEST_DIR, 'python.exe');
        
        // Fast-path: Skip setup if python is already present
        if (fs.existsSync(pythonExe) && fs.existsSync(path.join(DEST_DIR, 'Scripts', 'pip.exe'))) {
            // Check if backend requirements have been installed
            try {
                console.log('Validating existing Python environment requirements...');
                const pipExe = path.join(DEST_DIR, 'Scripts', 'pip.exe');
                execSync(`"${pipExe}" show fastapi uvicorn`, { stdio: 'ignore' });
                console.log('Python environment is already downloaded and fully setup. Skipping download phase.');
                return;
            } catch {
                console.log('Python exists but requirements are missing. Proceeding with setup.');
            }
        }

        if (!fs.existsSync(DEST_DIR)) {
            fs.mkdirSync(DEST_DIR, { recursive: true });
        }

        // Download
        if (!fs.existsSync(ZIP_PATH) && !fs.existsSync(pythonExe)) {
            await downloadFile(DOWNLOAD_URL, ZIP_PATH);
            console.log('Download complete.');
        }

        // Extract using PowerShell
        if (!fs.existsSync(pythonExe)) {
            console.log('Extracting archive...');
            execSync(`powershell -command "Expand-Archive -Force -Path '${ZIP_PATH}' -DestinationPath '${DEST_DIR}'"`, { stdio: 'inherit' });
        }
        
        // Clean up zip
        if (fs.existsSync(ZIP_PATH)) {
            fs.unlinkSync(ZIP_PATH);
        }

        console.log('Python extracted to python_embedded.');

        // Download get-pip.py so we can install packages
        const getPipPath = path.join(DEST_DIR, 'get-pip.py');
        if (!fs.existsSync(path.join(DEST_DIR, 'Scripts', 'pip.exe'))) {
            if (!fs.existsSync(getPipPath)) {
                await downloadFile('https://bootstrap.pypa.io/get-pip.py', getPipPath);
            }

            // Uncomment the python314._pth import site line
            const pthFile = path.join(DEST_DIR, `python314._pth`);
            if (fs.existsSync(pthFile)) {
                let pthContent = fs.readFileSync(pthFile, 'utf8');
                pthContent = pthContent.replace('#import site', 'import site');
                fs.writeFileSync(pthFile, pthContent);
            }

            console.log('Installing pip...');
            execSync(`"${pythonExe}" "${getPipPath}"`, { stdio: 'inherit' });
            
            console.log('Installing base build dependencies...');
            const pipExe = path.join(DEST_DIR, 'Scripts', 'pip.exe');
            execSync(`"${pipExe}" install wheel setuptools hatchling pip-licenses`, { stdio: 'inherit' });
        }

        console.log('Installing requirements...');
        const requirementsPath = path.join(__dirname, 'requirements.txt');
        if (fs.existsSync(requirementsPath)) {
            const pipExe = path.join(DEST_DIR, 'Scripts', 'pip.exe');
            if (fs.existsSync(pipExe)) {
                execSync(`"${pipExe}" install -r "${requirementsPath}"`, { stdio: 'inherit' });
            } else {
                execSync(`"${pythonExe}" -m pip install -r "${requirementsPath}"`, { stdio: 'inherit' });
            }
        }

        console.log(`Python ${PYTHON_VERSION} environment is ready!`);
    } catch (e) {
        console.error('Error:', e);
        process.exit(1);
    }
}

main();