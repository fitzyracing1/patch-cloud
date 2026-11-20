'use strict';
// pnpm loads this automatically when pnpm-plugin-patch-cloud is a config dependency.
const { createHooks } = require('./lib.cjs');
const { updateConfig, readPackage, afterAllResolved } = createHooks();
module.exports = { hooks: { updateConfig, readPackage, afterAllResolved } };
