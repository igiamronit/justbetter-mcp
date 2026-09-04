import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execFileAsync = promisify(execFile);

/** A dialog nobody answers must not pin the gateway open forever. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Prompts the user via an OS-native dialog box for confirmation before running a
 * destructive tool. This completely avoids terminal stdin, which is strictly reserved
 * by the MCP JSON-RPC protocol.
 *
 * The tool name and arguments are model-controlled text, so they are never interpolated
 * into a command string. Every backend receives the message out-of-band (an environment
 * variable or an argv slot) and is spawned without a shell.
 *
 * Async on purpose: the previous execSync blocked the event loop for the entire time the
 * dialog was open, which froze the MCP stdio transport and looked like a hung server.
 */
export async function requireUserApproval(toolName: string, args: any): Promise<boolean> {
  let argsText: string;
  try {
    argsText = JSON.stringify(args, null, 2) ?? String(args);
  } catch {
    argsText = '[unserializable arguments]';
  }

  const message = `The AI wants to execute a destructive tool:\n\nTool: ${toolName}\nArguments: ${argsText}\n\nAllow execution?`;

  console.error(`\n======================================================`);
  console.error(`🛑  HUMAN-IN-THE-LOOP REQUIRED`);
  console.error(`Tool: ${toolName}`);
  console.error(`Waiting for user approval via OS dialog box...`);

  try {
    const platform = os.platform();
    let approved = false;

    if (platform === 'win32') {
      // The script is a fixed literal; the message travels in the environment.
      const script =
        "Add-Type -AssemblyName PresentationFramework; " +
        "$result = [System.Windows.MessageBox]::Show($env:JUSTBETTER_APPROVAL_MESSAGE, " +
        "'JustBetter MCP Gateway', 'YesNo', 'Warning'); " +
        "Write-Output $result";

      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf-8',
          timeout: APPROVAL_TIMEOUT_MS,
          env: { ...process.env, JUSTBETTER_APPROVAL_MESSAGE: message }
        }
      );
      approved = stdout.trim() === 'Yes';

    } else if (platform === 'darwin') {
      // osascript exposes trailing arguments as `argv`, so the message stays data.
      const script = [
        'on run argv',
        'display dialog (item 1 of argv) with title "JustBetter MCP Gateway" ' +
        'buttons {"No", "Yes"} default button "No" with icon caution',
        'end run'
      ].join('\n');

      const { stdout } = await execFileAsync(
        'osascript',
        ['-e', script, message],
        { encoding: 'utf-8', timeout: APPROVAL_TIMEOUT_MS }
      );
      approved = stdout.includes('button returned:Yes');

    } else {
      try {
        await execFileAsync(
          'zenity',
          ['--question', '--title', 'JustBetter MCP Gateway', '--text', message],
          { encoding: 'utf-8', timeout: APPROVAL_TIMEOUT_MS }
        );
        approved = true; // zenity exits 0 on Yes
      } catch (e: any) {
        if (e?.code === 'ENOENT') throw e; // no zenity installed - report it below
        approved = false; // zenity exits 1 on No
      }
    }

    if (!approved) {
      console.error(`❌ Execution denied by user.`);
    } else {
      console.error(`✅ Execution approved by user.`);
    }
    console.error(`======================================================\n`);

    return approved;

  } catch (err: any) {
    const reason = err?.killed ? 'no response within the approval timeout' : err?.message;
    console.error(`❌ Failed to obtain approval (${reason}). Defaulting to DENY.`);
    console.error(`======================================================\n`);
    return false;
  }
}
