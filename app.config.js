const appJson = require('./app.json');
const pkg = require('./package.json');

module.exports = {
  ...appJson.expo,
  version: pkg.version,
};
