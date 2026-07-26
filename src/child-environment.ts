const CHILD_ENVIRONMENT_ALLOWLIST = [
  "PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "SystemRoot",
  "ComSpec", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR",
  "FORCE_COLOR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy",
  "https_proxy", "no_proxy",
] as const;

export function childEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(CHILD_ENVIRONMENT_ALLOWLIST.flatMap((name) =>
    source[name] === undefined ? [] : [[name, source[name]]]));
}
