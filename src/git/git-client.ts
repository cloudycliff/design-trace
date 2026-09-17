import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(
  cwd: string,
  args: readonly string[],
  options: { gitDir?: string } = {},
): Promise<string> {
  const gitArgs = options.gitDir ? [`--git-dir=${options.gitDir}`, ...args] : [...args];
  const { stdout } = await execFileAsync("git", gitArgs, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}
