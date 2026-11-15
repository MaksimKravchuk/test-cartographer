// electron-builder never copies node_modules from extraResources, so the
// staged engine (with its dependencies) goes in here, before signing.
const { cpSync } = require('node:fs');
const path = require('node:path');

exports.default = async ({ appOutDir, packager }) => {
  const resources = packager.platform.name === 'mac'
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');
  cpSync(path.join(__dirname, '../build/engine'), path.join(resources, 'engine'), { recursive: true });
};
