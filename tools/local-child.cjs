'use strict';
// IPC closes in the kernel if the supervisor exits, including forced termination.
// This prevents an orphan listener escaping future health supervision.
if(!process.connected||!process.argv[2])process.exit(1);
process.once('disconnect',()=>process.exit(1));
require(require('node:path').resolve(process.argv[2]));
