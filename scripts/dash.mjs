#!/usr/bin/env node
import { openDb } from "../src/db/db.mjs";
import { startDash } from "../src/dash/server.mjs";

openDb();
startDash();
