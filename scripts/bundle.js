const fs = require('fs');

const path = require('path');

 

const extensionDir = path.resolve(__dirname, '../');

const bundleDir = path.join(extensionDir, 'bundle');

const localPythonDir = path.join(extensionDir, 'python_embedded');

const packagedBackendDir = path.join(extensionDir, 'node_modules', 'ncedit7lab', 'backend');

const localMachinesConfig = path.join(localPythonDir, 'Lib', 'site-packages', 'ncplot7py', 'config', 'machines.json');

 

function hasBundledPythonRuntime(dir) {

    return fs.existsSync(path.join(dir, 'python.exe')) && fs.existsSync(path.join(dir, 'python311.dll'));

}

 

function copyFolderSync(from, to) {

    if (!fs.existsSync(to)) fs.mkdirSync(to, { recursive: true });

    fs.readdirSync(from).forEach(element => {

        const stat = fs.lstatSync(path.join(from, element));

        if (stat.isFile()) {

            try {

                fs.copyFileSync(path.join(from, element), path.join(to, element));

            } catch (error) {

                console.warn(`Warning: Failed to copy file ${path.join(from, element)} -> ${path.join(to, element)}: ${error.message}`);

            }

        } else if (stat.isDirectory()) {

            copyFolderSync(path.join(from, element), path.join(to, element));

        }

    });

}

 

function copyFileIfExists(from, to) {

    if (!fs.existsSync(from)) {

        console.warn(`Warning: Could not find ${from}.`);

        return;

    }

 

    fs.mkdirSync(path.dirname(to), { recursive: true });

    fs.copyFileSync(from, to);

}

 

console.log('Preparing bundle directory...');

const destPython = path.join(bundleDir, 'python_embedded');

const destBackend = path.join(bundleDir, 'backend');

 

if (!fs.existsSync(bundleDir)) {

    fs.mkdirSync(bundleDir, { recursive: true });

}

 

// Copy the locally generated python_embedded to the bundle directory

if (fs.existsSync(localPythonDir)) {

    if (hasBundledPythonRuntime(destPython)) {

        console.log(`Reusing existing bundled python_embedded at ${destPython}.`);

    } else {

        console.log(`Copying local python_embedded to ${destPython}...`);

        copyFolderSync(localPythonDir, destPython);

    }

 

    copyFileIfExists(

        localMachinesConfig,

        path.join(destPython, 'Lib', 'site-packages', 'ncplot7py', 'config', 'machines.json')

    );

} else {

    console.warn(`Warning: Could not find ${localPythonDir}. Make sure download-python.js was run.`);

}

 

if (fs.existsSync(packagedBackendDir)) {

    console.log(`Copying ncedit7lab backend to ${destBackend}...`);

    copyFolderSync(packagedBackendDir, destBackend);

} else {

    console.warn(`Warning: Could not find ${packagedBackendDir}. Make sure ncedit7lab is installed.`);

}

 

console.log('Bundle complete.');

 

 