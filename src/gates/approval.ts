import { execSync } from 'child_process';
import os from 'os';

/**
 * Prompts the user via an OS-native dialog box for confirmation before running a destructive tool.
 * This completely avoids terminal stdin, which is strictly reserved by the MCP JSON-RPC protocol.
 */
export async function requireUserApproval(toolName: string, args: any): Promise<boolean> {
  const message = `The AI wants to execute a destructive tool:\n\nTool: ${toolName}\nArguments: ${JSON.stringify(args, null, 2)}\n\nAllow execution?`;
  
  console.error(`\n======================================================`);
  console.error(`🛑  HUMAN-IN-THE-LOOP REQUIRED`);
  console.error(`Waiting for user approval via OS dialog box...`);
  
  try {
    const platform = os.platform();
    let approved = false;

    if (platform === 'win32') {
      // Windows PowerShell MessageBox
      const psCommand = `Add-Type -AssemblyName PresentationFramework; $result = [System.Windows.MessageBox]::Show('${message.replace(/'/g, "''").replace(/\n/g, "`n")}', 'JustBetter MCP Gateway', 'YesNo', 'Warning'); Write-Output $result`;
      const output = execSync(`powershell -NoProfile -Command "${psCommand}"`, { encoding: 'utf-8' });
      approved = output.trim() === 'Yes';
    } else if (platform === 'darwin') {
      // macOS AppleScript dialog
      const asCommand = `display dialog "${message.replace(/"/g, '\\"').replace(/\n/g, '\\r')}" with title "JustBetter MCP Gateway" buttons {"No", "Yes"} default button "No" with icon caution`;
      const output = execSync(`osascript -e '${asCommand}'`, { encoding: 'utf-8' });
      approved = output.includes('button returned:Yes');
    } else {
      // Linux zenity
      try {
        execSync(`zenity --question --title="JustBetter MCP Gateway" --text="${message.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
        approved = true; // zenity exits 0 on Yes
      } catch (e) {
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
    console.error(`❌ Failed to show OS dialog: ${err.message}. Defaulting to DENY.`);
    console.error(`======================================================\n`);
    return false;
  }
}
