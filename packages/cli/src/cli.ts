#!/usr/bin/env node
import { runCli } from "./application.js";

await runCli(process.argv.slice(2), import.meta.url);
