import { spawn } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";

const [timeoutText, command, ...args] = process.argv.slice(2);
const timeoutMs = Number(timeoutText);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || command === undefined) process.exit(2);

const useProcessGroup = process.platform !== "win32";
const child = spawn(command, args, { stdio: "inherit", detached: useProcessGroup });
const terminate = (signal) => {
  if (child.pid === undefined) return;
  try {
    process.kill(useProcessGroup ? -child.pid : child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
let stopping = false;
let exitCode;
let escalation;
const stop = (signal, code) => {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  terminate(signal);
  escalation = setTimeout(() => terminate("SIGKILL"), 1_000);
};
const timer = setTimeout(() => {
  console.error(`race run exceeded ${timeoutMs}ms and was terminated`);
  stop("SIGTERM", 124);
}, timeoutMs);
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  process.once(signal, () => stop(signal, code));
}

child.once("error", (error) => {
  clearTimeout(timer);
  if (escalation !== undefined) clearTimeout(escalation);
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  clearTimeout(timer);
  if (!stopping && escalation !== undefined) clearTimeout(escalation);
  process.exitCode = exitCode ?? code ?? (signal === null ? 1 : 128);
});
