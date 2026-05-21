import fs from 'fs';
import path from 'path';

const SETTINGS_FILE = path.resolve('usersettings/settings.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const TWO_MONTHS = 2;

// Sanitize a passphrase with a conservative allowlist.
// Returns null if the passphrase is invalid.
function sanitizePassphrase(passphrase) {
    if (typeof passphrase !== 'string') return null;
    const normalized = passphrase.trim().replace(/\s+/g, ' ');
    if (normalized.length === 0 || normalized.length > 128) return null;
    if (!/^[a-zA-Z0-9 _-]+$/.test(normalized)) return null;
    return normalized;
}

function _nowIso() {
    return new Date().toISOString();
}

function _isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function _isOlderThanTwoMonths(timestamp, now = new Date()) {
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) {
        return false;
    }

    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - TWO_MONTHS);
    return parsed < cutoff;
}

function _toStoredEntry(existing, settings) {
    const lastSync = _nowIso();
    if (_isPlainObject(settings)) {
        return { ...settings, lastSync };
    }

    const base = _isPlainObject(existing) ? existing : {};
    return { ...base, lastSync };
}

function _getStoreEntry(store, key) {
    const entry = store[key];
    if (!_isPlainObject(entry)) {
        return null;
    }

    return entry;
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
    const entry = _getStoreEntry(store, key);
    if (!entry) return null;

    store[key] = _toStoredEntry(entry);
    _writeStore(store);
    return store[key];
}

// Save (replace) the settings object for a given passphrase.
// Returns true on success, false if the passphrase is invalid.
export function saveSettings(passphrase, settings) {
    const key = sanitizePassphrase(passphrase);
    if (!key) return false;

    if (!_isPlainObject(settings)) {
        throw new TypeError('settings must be a plain object');
    }

    const store = _readStore();
    store[key] = _toStoredEntry(store[key], settings);
    _writeStore(store);
    return true;
}

// Merge partial settings into the existing settings object for a passphrase.
// Creates a new entry if none exists. Returns true on success, false if passphrase is invalid.
export function mergeSettings(passphrase, partial) {
    const key = sanitizePassphrase(passphrase);
    if (!key) return false;

    if (!_isPlainObject(partial)) {
        throw new TypeError('partial must be a plain object');
    }

    const store = _readStore();
    const current = _getStoreEntry(store, key) ?? {};
    store[key] = _toStoredEntry(store[key], { ...current, ...partial });
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

// Remove entries whose lastSync is older than 2 months.
// Returns the number of deleted passphrases.
export function cleanupStaleSettings(now = new Date()) {
    const store = _readStore();
    let deleted = 0;

    Object.keys(store).forEach(key => {
        const entry = _getStoreEntry(store, key);
        if (!entry) {
            delete store[key];
            deleted++;
            return;
        }

        if (_isOlderThanTwoMonths(entry.lastSync, now)) {
            delete store[key];
            deleted++;
        }
    });

    if (deleted > 0) {
        _writeStore(store);
    }

    return deleted;
}

// Start a daily stale-settings cleanup handler.
export function startDailySettingsCleanup() {
    try {
        cleanupStaleSettings();
    } catch (err) {
        console.error('Settings cleanup failed:', err.message);
    }

    return setInterval(() => {
        try {
            cleanupStaleSettings();
        } catch (err) {
            console.error('Settings cleanup failed:', err.message);
        }
    }, DAY_MS);
}
