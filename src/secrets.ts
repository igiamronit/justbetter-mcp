import fs from 'fs';
import os from 'os';
import path from 'path';

const SECRETS_DIR = path.join(os.homedir(), '.justbetter-mcp');
const SECRETS_FILE = path.join(SECRETS_DIR, 'secrets.json');

/**
 * Ensures the global secrets directory and file exist with correct permissions.
 */
function initSecrets() {
  if (!fs.existsSync(SECRETS_DIR)) {
    fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(SECRETS_FILE)) {
    fs.writeFileSync(SECRETS_FILE, JSON.stringify({}), { mode: 0o600 });
  } else {
    // Enforce permissions just in case
    fs.chmodSync(SECRETS_FILE, 0o600);
  }
}

/**
 * Retrieves a global secret by key.
 */
export function getGlobalSecret(key: string): string | undefined {
  initSecrets();
  try {
    const data = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8'));
    return data[key];
  } catch (err) {
    return undefined;
  }
}

/**
 * Sets a global secret securely.
 */
export function setGlobalSecret(key: string, value: string): void {
  initSecrets();
  const data = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8'));
  data[key] = value;
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}
