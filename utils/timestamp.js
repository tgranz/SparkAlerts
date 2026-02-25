/*
Timestamp Parsing Utilities

Functions for parsing human-readable timestamps from NWS alert messages.
*/

/**
 * Parse a human-readable timestamp from message text and return an ISO UTC string.
 * Matches examples like "1037 PM PST Fri Feb 13 2026" or "9:28 PM MST Fri Feb 13 2026".
 * @param {string} text - Alert message text
 * @returns {string|null} ISO 8601 timestamp or null if no match
 */
function parseHumanTimestampFromText(text) {
    if (!text || typeof text !== 'string') return null;
    const re = /\b(\d{3,4}|\d{1,2}:\d{2})\s*(AM|PM)\s*([A-Za-z]{2,4})\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\b/i;
    const m = text.match(re);
    if (!m) return null;
    
    let timeStr = m[1];
    const ampm = m[2].toUpperCase();
    const tz = m[3].toUpperCase();
    const monthStrRaw = m[4];
    const day = parseInt(m[5], 10);
    const year = parseInt(m[6], 10);

    // parse hour/minute
    let hour = 0, minute = 0;
    if (timeStr.includes(':')) {
        const parts = timeStr.split(':');
        hour = parseInt(parts[0], 10);
        minute = parseInt(parts[1], 10);
    } else {
        if (timeStr.length === 3) {
            hour = parseInt(timeStr.slice(0, 1), 10);
            minute = parseInt(timeStr.slice(1), 10);
        } else {
            hour = parseInt(timeStr.slice(0, 2), 10);
            minute = parseInt(timeStr.slice(2), 10);
        }
    }
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;

    const monthStr = monthStrRaw.charAt(0).toUpperCase() + monthStrRaw.slice(1).toLowerCase();
    const months = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
    const month = months[monthStr];
    if (month === undefined) return null;

    const tzOffsets = { PST:-8, PDT:-7, MST:-7, MDT:-6, CST:-6, CDT:-5, EST:-5, EDT:-4, AKST:-9, AKDT:-8, HST:-10, GMT:0, UTC:0 };
    const tzOffset = tzOffsets[tz] !== undefined ? tzOffsets[tz] : null;
    if (tzOffset === null) return null;

    // local time -> UTC: utc = local - tzOffset
    const localMillis = Date.UTC(year, month, day, hour, minute);
    const utcMillis = localMillis - (tzOffset * 60 * 60 * 1000);
    return new Date(utcMillis).toISOString();
}

module.exports = {
    parseHumanTimestampFromText
};
