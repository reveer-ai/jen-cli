#!/usr/bin/env node
import { run } from './cli.js';

process.exitCode = run(process.argv.slice(2), {
  out: (message) => console.log(message),
  err: (message) => console.error(message),
});
