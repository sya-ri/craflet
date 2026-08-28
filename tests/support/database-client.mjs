#!/usr/bin/env node
import { containerClient } from "./database-container.mjs";

await containerClient("client");
