#!/usr/bin/env node
import { main } from "../src/cli.ts";

// `follow-me prompt | head` closes stdout early; that is not an error worth a stack trace.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

process.exitCode = await main(process.argv.slice(2), process.cwd());
