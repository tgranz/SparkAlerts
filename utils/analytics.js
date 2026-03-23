import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANALYTICS_FILE = path.join(__dirname, '..', 'data', 'analytics.json');
const DATA_DIR = path.join(__dirname, '..', 'data');
const MAX_DAYS = 30;

/**
 * Ensure the data directory exists
 */
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

/**
 * Get today's date in ISO 8601 format at midnight UTC
 * @returns {string} Date string in format YYYY-MM-DDTHH:mmZ
 */
function getTodayKey() {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}T00:00Z`;
}

/**
 * Read analytics data from file
 * @returns {Object} Analytics data object
 */
function readAnalytics() {
    ensureDataDir();
    
    if (!fs.existsSync(ANALYTICS_FILE)) {
        return {};
    }

    try {
        const data = fs.readFileSync(ANALYTICS_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (err) {
        console.error('Error reading analytics file:', err.message);
        return {};
    }
}

/**
 * Clean up old analytics data (keep only last 30 days)
 * @param {Object} analytics - Current analytics data
 * @returns {Object} Cleaned analytics data
 */
function cleanupOldData(analytics) {
    const thirtyDaysAgoMs = Date.now() - (MAX_DAYS * 24 * 60 * 60 * 1000);
    const cleaned = {};

    for (const [dateKey, count] of Object.entries(analytics)) {
        try {
            const dateMs = new Date(dateKey).getTime();
            if (dateMs >= thirtyDaysAgoMs) {
                cleaned[dateKey] = count;
            }
        } catch (err) {
            // Skip invalid date keys
            console.warn(`Skipping invalid date key: ${dateKey}`);
        }
    }

    return cleaned;
}

/**
 * Write analytics data to file
 * @param {Object} analytics - Analytics data to write
 */
function writeAnalytics(analytics) {
    ensureDataDir();

    try {
        fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analytics, null, 2), 'utf-8');
    } catch (err) {
        console.error('Error writing analytics file:', err.message);
    }
}

/**
 * Record a successful subscribe event
 */
export function recordSubscribe() {
    const analytics = readAnalytics();
    const todayKey = getTodayKey();

    // Increment count for today
    analytics[todayKey] = (analytics[todayKey] || 0) + 1;

    // Clean up data older than 30 days
    const cleaned = cleanupOldData(analytics);

    // Write back to file
    writeAnalytics(cleaned);
}

/**
 * Get all analytics data
 * @returns {Object} Current analytics data
 */
export function getAnalytics() {
    const analytics = readAnalytics();
    return cleanupOldData(analytics);
}
