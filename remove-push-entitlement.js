const { withEntitlementsPlist } = require('@expo/config-plugins');

module.exports = (config) =>
  withEntitlementsPlist(config, (mod) => {
    delete mod.modResults['aps-environment'];
    return mod;
  });
