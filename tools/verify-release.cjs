#!/usr/bin/env node
'use strict';
require('./verify-staging.cjs').verifyStaging({ production: true })
  .then(result => console.log(JSON.stringify(result)))
  .catch(e => { console.error('Production GET check failed: ' + e.message); process.exitCode = 1; });
