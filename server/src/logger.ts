import pino from "pino";
import { logPath } from "./paths.js";

const level = process.env.LOG_LEVEL ?? "info";

const isTTY = process.stdout.isTTY;

// The TTY branch spawns a pino-pretty worker thread with `colorize`; Vitest
// runs headless without a TTY, so the left side is dead in test and adding a
// dedicated test just to import logger under stubbed `process.stdout.isTTY`
// pays the cost of spinning up (and tearing down) that worker per test run.
// Covered by running the server locally against an interactive terminal.
/* v8 ignore next 8 -- TTY-vs-file branch; only the file branch runs in tests */
export const logger = isTTY
  ? pino({
      level,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
      },
    })
  : pino({ level }, pino.destination({ dest: logPath(), sync: false, mkdir: true }));
