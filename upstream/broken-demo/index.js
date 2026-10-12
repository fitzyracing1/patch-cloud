// UPSTREAM: intentionally broken — simulates a package whose CI light is dark
throw new Error('broken-demo UPSTREAM: this package is broken (CI dark). Patch-cloud should have rewritten you to the fork.');
module.exports = { ok: false, source: 'upstream' };
