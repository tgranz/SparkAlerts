/*
UGC (Universal Geographic Code) Utilities

Functions for parsing UGC codes, converting to FIPS codes, and looking up zone names.
*/

const https = require('https');

// State/Territory -> FIPS code mapping for county UGC conversion
const STATE_FIPS = {
    AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10',
    DC: '11', FL: '12', GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19',
    KS: '20', KY: '21', LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27',
    MS: '28', MO: '29', MT: '30', NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35',
    NY: '36', NC: '37', ND: '38', OH: '39', OK: '40', OR: '41', PA: '42', RI: '44',
    SC: '45', SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53',
    WV: '54', WI: '55', WY: '56', AS: '60', GU: '66', MP: '69', PR: '72', VI: '78'
};

// Zone info cache (shared across all instances)
const __zoneInfoCache = (global.__zoneInfoCache = global.__zoneInfoCache || new Map());

/**
 * Convert UGC code to FIPS code (for counties)
 * @param {string} ugcId - UGC code (e.g., "CAC001")
 * @returns {string|null} FIPS code or null if invalid
 */
function ugcToFips(ugcId) {
    if (!ugcId) return null;
    const m = ugcId.match(/^([A-Z]{2})C(\d{3})$/);
    if (!m) return null;
    const stateFips = STATE_FIPS[m[1]];
    if (!stateFips) return null;
    return `${stateFips}${m[2]}`;
}

/**
 * Expand a UGC group string into individual UGC IDs
 * Ignores timestamps and non-3-digit tokens
 * @param {string} group - UGC group string (e.g., "CAZ001-002>005-")
 * @returns {string[]} Array of individual UGC codes
 */
function expandUgcGroup(group) {
    if (!group) return [];
    // Trim trailing hyphens and capture prefix letters
    group = group.replace(/^-+|-+$/g, '').trim();
    const m = group.match(/^([A-Z]{2,3})([\s\S]*)$/);
    if (!m) return [];
    const prefix = m[1];
    const rest = m[2].replace(/-+$/g, '');
    const parts = rest.split('-').filter(Boolean);
    const out = new Set();

    for (const p of parts) {
        // ignore 6-digit timestamps like 141800
        if (/^\d{6}$/.test(p)) continue;
        // single 3-digit
        let r;
        if ((r = p.match(/^\s*(\d{3})\s*$/))) {
            out.add(prefix + r[1]);
            continue;
        }
        // range like 016>018
        if ((r = p.match(/^(\d{3})>(\d{3})$/))) {
            const start = parseInt(r[1], 10);
            const end = parseInt(r[2], 10);
            if (start <= end && end - start < 1000) {
                for (let n = start; n <= end; n++) out.add(prefix + String(n).padStart(3, '0'));
            }
            continue;
        }
        // if part contains letters or unexpected format, ignore
    }
    return Array.from(out);
}

/**
 * Simple HTTPS GET -> JSON helper
 * @param {string} url - URL to fetch
 * @param {number} timeout - Request timeout in milliseconds
 * @returns {Promise<Object>} Parsed JSON object
 */
function getJson(url, timeout = 5000) {
    return new Promise((resolve, reject) => {
        try {
            const req = https.get(url, { headers: { 'User-Agent': 'SparkAlerts', 'Accept': 'application/geo+json, application/json' } }, (res) => {
                let data = '';
                res.on('data', (c) => data += c);
                res.on('end', () => {
                    try {
                        const obj = JSON.parse(data);
                        resolve(obj);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(timeout, () => { req.destroy(new Error('timeout')); });
        } catch (e) { reject(e); }
    });
}

/**
 * Look up friendly zone/county name from API
 * @param {string} ugcId - UGC code
 * @returns {Promise<string|null>} Zone/county name or null if not found
 */
async function lookupZoneDisplay(ugcId) {
    if (!ugcId) return null;
    if (__zoneInfoCache.has(ugcId)) return __zoneInfoCache.get(ugcId);

    // validate UGC format
    const m = ugcId.match(/^([A-Z]+)(\d{3})$/);
    if (!m) { __zoneInfoCache.set(ugcId, null); return null; }

    const prefix = m[1];
    const lastLetter = prefix[prefix.length - 1];
    const isCounty = (lastLetter === 'C');

    // County zones -> use county endpoint (keep existing behavior)
    if (isCounty) {
        const url = `https://api.weather.gov/zones/county/${ugcId}`;
        try {
            const json = await getJson(url);
            if (json && json.properties) {
                const name = json.properties.name && json.properties.state ? `${json.properties.name}, ${json.properties.state}` : json.properties.name || null;
                __zoneInfoCache.set(ugcId, name);
                return name;
            }
        } catch (e) {
            // treat as not found
        }
        __zoneInfoCache.set(ugcId, null);
        return null;
    }

    // Non-county zones: try `zones/forecast` first, then fall back to `zones/fire` and return `properties.name`.
    const forecastUrl = `https://api.weather.gov/zones/forecast/${ugcId}`;
    try {
        const json = await getJson(forecastUrl);
        if (json && json.properties && json.properties.name) {
            const name = json.properties.name;
            __zoneInfoCache.set(ugcId, name);
            return name;
        }
    } catch (e) {
        // ignore — we'll try fallback
    }

    // Fallback: zones/fire (some UGCs exist only under the fire namespace)
    const fireUrl = `https://api.weather.gov/zones/fire/${ugcId}`;
    try {
        const json = await getJson(fireUrl);
        if (json && json.properties && json.properties.name) {
            const name = json.properties.name;
            __zoneInfoCache.set(ugcId, name);
            return name;
        }
    } catch (e) {
        // treat as not found
    }

    __zoneInfoCache.set(ugcId, null);
    return null;
}

module.exports = {
    STATE_FIPS,
    ugcToFips,
    expandUgcGroup,
    lookupZoneDisplay
};
