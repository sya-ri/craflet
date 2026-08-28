import { runServerDaemon } from "@craflet/adapters";

const projectDir = process.argv[2];
if (!projectDir) throw new Error("A project directory is required.");
await runServerDaemon(projectDir);
