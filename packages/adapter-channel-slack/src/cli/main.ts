#!/usr/bin/env node
import { runSlackCli } from './cli.js';

runSlackCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
