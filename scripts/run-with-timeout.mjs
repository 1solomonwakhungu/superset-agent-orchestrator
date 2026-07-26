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
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  terminate("SIGTERM");
}, timeoutMs);
const escalation = setTimeout(() => {
  if (timedOut && child.exitCode === null) terminate("SIGKILL");
}, timeoutMs + 1_000);

child.once("error", (error) => {
  clearTimeout(timer);
  clearTimeout(escalation);
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  clearTimeout(timer);
  clearTimeout(escalation);
  if (timedOut) console.error(`race run exceeded ${timeoutMs}ms and was terminated`);
  process.exitCode = timedOut ? 124 : (code ?? (signal === null ? 1 : 128));
});
