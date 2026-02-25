/*
VTEC (Valid Time Event Code) Utilities

Functions for parsing and converting VTEC codes from NWS alerts.
https://www.weather.gov/bmx/vtec
*/

/**
 * Convert VTEC timestamp format to ISO string
 * @param {string} ts - VTEC timestamp in format YYMMDDTHHMMZ
 * @returns {string|null} ISO 8601 timestamp or null if invalid
 */
function vtecToIso(ts) {
    if (!ts || typeof ts !== 'string') return null;
    const m = ts.match(/(\d{2})(\d{2})(\d{2})T(\d{2})(\d{2})Z/);
    if (!m) return null;
    const yy = parseInt(m[1], 10);
    const year = 2000 + yy;
    const month = parseInt(m[2], 10) - 1;
    const day = parseInt(m[3], 10);
    const hour = parseInt(m[4], 10);
    const minute = parseInt(m[5], 10);
    return new Date(Date.UTC(year, month, day, hour, minute)).toISOString();
}

/**
 * Parse VTEC string from alert message text
 * @param {string} rawText - Alert message text
 * @param {Function} parseHumanTimestamp - Function to parse human-readable timestamps
 * @returns {Object|null} Parsed VTEC object or null if no VTEC found
 */
function parseVTEC(rawText, parseHumanTimestamp) {
    if (!rawText || typeof rawText !== 'string') return null;
    
    try {
        let vtec = rawText.match(/\/O\..*?\/\n?/);
        if (!vtec) {
            vtec = rawText.match(/<parameter>\s*<valueName>VTEC<\/valueName>\s*<value>(.*?)<\/value>\s*<\/parameter>/);
            if (vtec && vtec[1]) vtec = vtec[1];
        }
        if (!vtec) throw new Error('No VTEC found');
        
        const vtecObjects = (typeof vtec === 'string' ? vtec : vtec[0]).split('.');
        
        return {
            product: vtecObjects[0],
            actions: vtecObjects[1],
            office: vtecObjects[2],
            phenomena: vtecObjects[3],
            significance: vtecObjects[4],
            eventTrackingNumber: vtecObjects[5],
            startTime: (parseHumanTimestamp && parseHumanTimestamp(rawText)) || vtecToIso(vtecObjects[6].split('-')[0]),
            endTime: vtecToIso(vtecObjects[6].split('-')[1])
        };
    } catch (err) {
        return null;
    }
}

/**
 * Parse VTEC from a message part (used during per-part processing)
 * @param {string} msgPart - Message part text
 * @returns {Object|null} Parsed VTEC object or null if no VTEC found
 */
function parseVTECFromPart(msgPart) {
    if (!msgPart || typeof msgPart !== 'string') return null;
    
    try {
        let vtec = msgPart.match(/\/O\..*?\/\n?/);
        if (!vtec) {
            vtec = msgPart.match(/<parameter>\s*<valueName>VTEC<\/valueName>\s*<value>(.*?)<\/value>\s*<\/parameter>/);
            if (vtec && vtec[1]) vtec = vtec[1];
        }
        if (!vtec) return null;
        
        const vtecObjects = (typeof vtec === 'string' ? vtec : vtec[0]).split('.');
        if (vtecObjects.length < 7) return null;
        
        return {
            product: vtecObjects[0],
            actions: vtecObjects[1],
            office: vtecObjects[2],
            phenomena: vtecObjects[3],
            significance: vtecObjects[4],
            eventTrackingNumber: vtecObjects[5],
            startTime: vtecToIso(vtecObjects[6].split('-')[0]),
            endTime: vtecToIso(vtecObjects[6].split('-')[1])
        };
    } catch (err) {
        return null;
    }
}

module.exports = {
    vtecToIso,
    parseVTEC,
    parseVTECFromPart
};
