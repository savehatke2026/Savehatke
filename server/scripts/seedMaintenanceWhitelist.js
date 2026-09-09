// Maintenance whitelist seeding has been removed. The previous
// implementation gave certain user emails a maintenance bypass, but the
// new requirements explicitly forbid that — admins are the only role
// that bypasses maintenance mode, decided server-side from the JWT.
//
// This file is kept as a no-op so anyone with an old `node server/scripts/
// seedMaintenanceWhitelist.js` command in their tooling still gets a
// clean exit instead of a "Cannot find module" error.
'use strict';

console.log('Maintenance whitelist seeding is no longer supported.');
console.log('Admin role is the only maintenance bypass; no user emails are special-cased.');
process.exit(0);
