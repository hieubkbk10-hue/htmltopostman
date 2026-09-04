#!/usr/bin/env node

import { runCli } from '../src/index.js';

runCli().catch((err) => {
  console.error('\n❌ Fatal error:', err.message || err);
  process.exit(1);
});
