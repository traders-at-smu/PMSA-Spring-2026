import fs from "fs";
import path from "path";

export interface CopyTarget {
  address: string;
  name: string;
  setAt: string;
}

const LOCAL_SETTINGS_PATH = path.resolve(process.cwd(), "config", "settings.local.json");

let currentTarget: CopyTarget | null = null;
let loaded = false;

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(LOCAL_SETTINGS_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(LOCAL_SETTINGS_PATH, "utf8"));
    if (raw?.copyTarget?.address) {
      currentTarget = {
        address: raw.copyTarget.address,
        name: raw.copyTarget.name || "",
        setAt: raw.copyTarget.setAt || new Date().toISOString(),
      };
    }
  } catch {
    // ignore parse errors
  }
}

function persistToDisk(): void {
  try {
    let existing: Record<string, any> = {};
    if (fs.existsSync(LOCAL_SETTINGS_PATH)) {
      existing = JSON.parse(fs.readFileSync(LOCAL_SETTINGS_PATH, "utf8"));
    }
    if (currentTarget) {
      existing.copyTarget = currentTarget;
    } else {
      delete existing.copyTarget;
    }
    // Ensure config dir exists
    const dir = path.dirname(LOCAL_SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LOCAL_SETTINGS_PATH, JSON.stringify(existing, null, 2) + "\n");
  } catch {
    // best-effort persistence
  }
}

export function getCopyTarget(): CopyTarget | null {
  loadFromDisk();
  return currentTarget;
}

export function setCopyTarget(address: string, name: string): CopyTarget {
  loadFromDisk();
  currentTarget = {
    address: address.toLowerCase(),
    name,
    setAt: new Date().toISOString(),
  };
  persistToDisk();
  return currentTarget;
}

export function clearCopyTarget(): void {
  loadFromDisk();
  currentTarget = null;
  persistToDisk();
}
