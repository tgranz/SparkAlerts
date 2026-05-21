import fs from 'fs';
import path from 'path';

const SETTINGS_FILE = path.resolve('usersettings/settings.json');

// Sanitize a passphrase: only allow alphanumeric characters, hyphens, and underscores.
// Returns null if the passphrase is invalid.
function sanitizePassphrase(passphrase) {
    if (typeof passphrase !== 'string') return null;
    const trimmed = passphrase.trim();
    if (trimmed.length === 0 || trimmed.length > 128) return null;
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;
    return trimmed;
}

function _readStore() {
    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return {};
        }
        throw err;
    }
}

function _writeStore(store) {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(store, null, 2), 'utf8');
}

// Load the settings object for a given passphrase.
// Returns the settings object, or null if the passphrase is invalid or not found.
export function loadSettings(passphrase) {
    const key = sanitizePassphrase(passphrase);
    if (!key) return null;

    const store = _readStore();
    return store[key] ?? null;
}

// Save (replace) the settings object for a given passphrase.
// Returns true on success, false if the passphrase is invalid.
export function saveSettings(passphrase, settings) {
    const key = sanitizePassphrase(passphrase);
    if (!key) return false;

    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
        throw new TypeError('settings must be a plain object');
    }

    const store = _readStore();
    store[key] = settings;
    _writeStore(store);
    return true;
}

// Merge partial settings into the existing settings object for a passphrase.
// Creates a new entry if none exists. Returns true on success, false if passphrase is invalid.
export function mergeSettings(passphrase, partial) {
    const key = sanitizePassphrase(passphrase);
    if (!key) return false;

    if (typeof partial !== 'object' || partial === null || Array.isArray(partial)) {
        throw new TypeError('partial must be a plain object');
    }

    const store = _readStore();
    store[key] = { ...(store[key] ?? {}), ...partial };
    _writeStore(store);
    return true;
}

// Delete the settings entry for a given passphrase.
// Returns true if deleted, false if passphrase is invalid or entry did not exist.
export function deleteSettings(passphrase) {
    const key = sanitizePassphrase(passphrase);
    if (!key) return false;

    const store = _readStore();
    if (!(key in store)) return false;

    delete store[key];
    _writeStore(store);
    return true;
}
