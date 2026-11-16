#!/usr/bin/env node
import { runPandaCli } from "./application.js";
process.exitCode = await runPandaCli(process.argv.slice(2), {
  input: process.stdin,
  output: process.stdout,
  error: process.stderr,
});
