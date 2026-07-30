#!/usr/bin/env node
import { main, CliError } from './cli.js';

main(process.argv.slice(2)).catch((err: unknown) => {
  // A usage mistake should read as guidance, not a stack trace.
  if (err instanceof CliError) {
    console.error(err.message);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
