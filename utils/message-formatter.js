/*
Message Formatting and Cleanup Utilities

Functions for normalizing and formatting NWS alert message text.
*/

/**
 * Normalize paragraphs while preserving paragraph breaks
 * @param {string} text - Message text to normalize
 * @returns {string} Normalized text
 */
function normalizeParagraphs(text) {
    if (!text) return '';
    text = String(text).replace(/\r\n/g, '\n');
    // preserve up to two leading newlines (some preambles expect a double-blank line)
    text = text.replace(/^\n{3,}/, '\n\n');
    // remove leading/trailing spaces but keep newlines
    text = text.replace(/^[ \t]+|[ \t]+$/g, '');
    // collapse 3+ blank lines into 2
    text = text.replace(/\n{3,}/g, '\n\n');
    // split paragraphs on one-or-more blank lines, join wrapped lines inside each paragraph
    // EXCEPTION: preserve a single newline that precedes a timestamp so the time stays on its own line
    const paras = text.split(/\n{2,}/).map(p => p
        .replace(/\n+(?=(?:At\s+)?(?:\d{3,4}|\d{1,2}(?::\d{2})?)\s*(?:AM|PM))/gi, '\n')
        .replace(/\n+/g, ' ')
        .trim()
    ).filter(Boolean);

    // Re-join paragraphs using a canonical paragraph separator
    let out = paras.join('\n\n');

    // Ensure delimiters '&&' and '$$' are surrounded by double-newlines
    out = out.replace(/\s*&&\s*/g, '\n\n&&\n\n');
    out = out.replace(/\s*\$\$\s*/g, '\n\n$$\n\n');

    // Ensure that a delimiter '&&' is followed by a double-newline before LAT...LON
    out = out.replace(/&&\s*\n+(?=\s*LAT\.\.\.LON)/g, '&&\n\n');
    out = out.replace(/&&(?=\s*LAT\.\.\.LON)/g, '&&\n\n');

    // --------------------------- Targeted fixes ---------------------------
    // 1) Number-only preamble lines
    out = out.replace(/(^|\n)(\d{1,4})\n\n(?=[A-Z0-9])/gm, '$1$2\n');

    // 2) UGC-style line that ends with a hyphen
    out = out.replace(/([A-Z]{2,3}[0-9]{3}(?:[>-][0-9]{3,6})*-)\n\n/g, '$1\n');

    // 3) VTEC or other slash-enclosed blocks
    out = out.replace(/(\/[^\n\/]{1,200}?\/)\n\n/g, '$1\n');

    // 4) Short capitalized-name splits
    out = out.replace(/(\b[A-Z][a-z]{1,20})\n\n([A-Z][a-z]{1,20}\b)/g, '$1\n$2');

    // 5) AWIPS/preamble product headers
    out = out.replace(/(^|\n)([A-Z]{2,6}\s+[A-Z]{2,4}\s+\d{5,8})\n\n(?=[A-Z0-9])/gm, '$1$2\n');
    out = out.replace(/(^|\n)([A-Z]{4,10})\n\n(?=[A-Z0-9])/gm, '$1$2\n');

    // 6) Generic adjacent ALL-CAPS/code lines
    out = out.replace(/(^|\n)([A-Z0-9\/\.\-&' ]{1,60})\n\n([A-Z0-9\/\.\-&' ]{1,60})/gm, '$1$2\n$3');

    // 7) Specific phrase/timestamp fixes
    out = out.replace(/(Flood Advisory)\n\n/gi, '$1\n');
    out = out.replace(/(National Weather Service [^\n,]{1,120},)\n\n/gi, '$1\n');
    out = out.replace(/(National Weather Service [^\n,]{1,120})(?!,)\n\n/gi, '$1\n');
    out = out.replace(/\n{2,}(?=(?:At\s+)?(?:\d{3,4}|\d{1,2}(?::\d{2})?)\s*(?:AM|PM)\s*(?:PST|PDT|MST|MDT|CST|CDT|EST|EDT|HST|HDT|AKDT|AKST)\s*(?:,?\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))?\s*[A-Za-z]{3}\s+\d{1,2}\s+\d{4})/gi, '\n');
    out = out.replace(/\n{2,}(?=(?:At\s+)?\d{3,4}\s*(?:AM|PM))/gi, '\n');
    out = out.replace(/((?:At\s+)?(?:\d{3,4}|\d{1,2}(?::\d{2})?)\s*(?:AM|PM)\s*(?:PST|PDT|MST|MDT|CST|CDT|EST|EDT|HST|HDT|AKDT|AKST)\s*(?:,?\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))?\s*[A-Za-z]{3}\s+\d{1,2}\s+\d{4})\n*/gi, '$1\n\n');

    // 8) Collapse double-newline after common section headings
    (function(){
        const headings = [
            'WIND', 'HAIL', 'HAIL THREAT', 'WIND THREAT', 'TORNADO',
            'TORNADO DAMAGE THREAT', 'THUNDERSTORM DAMAGE THREAT',
            'FLASH FLOOD DAMAGE THREAT', 'FLASH FLOOD', 'WATERSPOUT',
            'EXPECTED RAINFALL RATE'
        ];
        for (const h of headings) {
            const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp('(' + esc + '(?:\.{2,}|\.{0,3})?)\\n\\n', 'gi');
            out = out.replace(re, '$1\n');
        }
    })();

    // 9) Ensure specific headings have TWO newlines BEFORE and ONE AFTER
    (function(){
        const adjust = ['LAT...LON','TIME...MOT...LOC','TIME.MOT.LOC','MAX HAIL SIZE','MAX WIND GUST','WATERSPOUT'];
        for (const h of adjust) {
            const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            out = out.replace(new RegExp('([^\\n])\\n(\\s*' + esc + '(?:\\.{2,}|\\.{0,3})?[^\\n]*)','gi'), '$1\\n\\n$2');
            out = out.replace(new RegExp('\\n{2,}(\\s*' + esc + '(?:\\.{2,}|\\.{0,3})?[^\\n]*)','gi'), '\\n\\n$1');
            out = out.replace(new RegExp('(' + esc + '(?:\\.{2,}|\\.{0,3})?[^\\n]*)\\n{2,}','gi'), '$1\\n');
            out = out.replace(new RegExp('(' + esc + '(?:\\.{2,}|\\.{0,3})?[^\\n]*)$','gi'), '$1\\n');
        }
    })();

    // 10) Hyphen-terminated areaDesc handling
    out = out.replace(/(-)\n+(?=\s*[A-Z][a-z])/g, '$1');
    out = out.replace(/(^|\n)((?:(?!\n).*-){2,}.*?)(?=\n{2,}|$)/gm, function(_, pfx, body){
        return pfx + body.replace(/\n+/g, ' ');
    });
    out = out.replace(/-\s*(Including\b)/gi, '-\n$1');
    out = out.replace(/(Including\b[\s\S]*?)(?=\n{2,}|$)/gi, function(m){ return m.replace(/\n+/g, ' '); });

    // 11) Normalize "locations ... include" blocks
    out = out.replace(/(locations(?:\s+impacted)?\s+includes?\b[^\n]*)\n+([\s\S]*?)(?=\n{2,}|$)/gi, function(_, heading, listBody){
        const flat = listBody.replace(/\n+/g, ' ').trim();
        const parts = flat.split(/\s*(?:,|;|\/|\band\b|\s-\s|\s+—\s+)\s*/i).map(s=>s.trim()).filter(Boolean);
        if (parts.length <= 1) {
            return heading + '\n' + flat;
        }
        return heading + '\n' + parts.join('\n') + '\n\n';
    });

    // 12) Collapse extra blank lines before short all-caps names
    out = out.replace(/\n{2,}(?=\s*(?!PRECAUTIONARY|PREPAREDNESS|ACTIONS|WHAT|WHERE|IMPACTS|LAT\.{3}|TIME|WIND|HAIL|TORNADO)[A-Z0-9 '\&\-.]{1,40}\b(?:\.{3})?(?:\n|$))/gi, '\n');

    // 13) Collapse double-newline between numeric-only lines
    out = out.replace(/(^|\n)(\s*(?:\d{3,5}(?:\s+\d{3,5})*)\s*)\n\n(?=\s*\d{3,5})/gm, '$1$2\n');

    // 14) For starred sections, collapse internal double-newlines
    out = out.replace(/(\*\s+[A-Z][\s\S]*?)(?=\n\*\s+[A-Z]|\n\s*(?:&&|\$\$?|\$)\s*(?:\n|$)|$)/g, function(block) {
        let inner = block.replace(/\n{3,}/g, '\n\n');
        inner = inner.replace(/\n\n(?!\*\s)/g, '\n');
        inner = inner.replace(/\n+$/g, '') + '\n\n';
        return inner;
    });

    // 15) Ensure short all-caps product lines are followed by a blank line
    out = out.replace(/(^|\n)([A-Z]{3,8})\n(?!\n)/gm, '$1$2\n\n');

    // 16) Ensure PRECAUTIONARY/PREPAREDNESS ACTIONS is its own paragraph
    out = out.replace(/\n{0,2}\s*(\*\s*)?(PRECAUTIONARY\s*\/\s*PREPAREDNESS ACTIONS\.{3,})\s*\n{0,2}/gi, '\n\n$1$2\n\n');

    // Final enforcement
    out = out.replace(/\n{0,2}&&\n{0,2}/g, '\n\n&&\n\n');
    out = out.replace(/\n{0,2}\$\$\n{0,2}/g, '\n\n$$\n\n');
    out = out.replace(/\n{2,}(?=(?:At\s+)?\d{3,4}\s*(?:AM|PM))/gi, '\n');
    out = out.replace(/\n{3,}/g, '\n\n');

    return out;
}

/**
 * Format message newlines and enforce heading spacing rules
 * @param {string} msg - Message text to format
 * @returns {string} Formatted text
 */
function formatMessageNewlines(msg) {
    if (!msg) return msg;
    let formatted = String(msg);

    // Remove all XML tags
    formatted = formatted.replace(/<[^>]+>/g, '');

    // Convert escaped sequences to actual newlines
    formatted = formatted.replace(/\\r\\n/g, '\n');
    formatted = formatted.replace(/\\n/g, '\n');

    // Normalize CR/LF
    formatted = formatted.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Remove stray whitespace around newlines
    formatted = formatted.replace(/[ \t]+\n/g, '\n');
    formatted = formatted.replace(/\n[ \t]+/g, '\n');
    formatted = formatted.replace(/^\s+|\s+$/g, '');

    // Defensive cleanup
    formatted = formatted.replace(/\\+n/g, '\n');
    formatted = formatted.replace(/\n{3,}/g, '\n\n');

    // Ensure exact spacing before headings that should have TWO newlines
    const twoNL = ['HAZARD\\.\\.\\.', 'SOURCE\\.\\.\\.', 'IMPACT\\.\\.\\.', 'Locations impacted include'];
    for (const h of twoNL) {
        formatted = formatted.replace(new RegExp('([^\\n\\s])\\s*(' + h + ')', 'g'), '$1\n\n$2');
        formatted = formatted.replace(new RegExp('\\n+\\s*(' + h + ')', 'g'), '\n\n$1');
    }

    // Ensure exact spacing before headings that should have ONE newline
    const oneNL = [
        'TORNADO DAMAGE THREAT\\.\\.\\.',
        'THUNDERSTORM DAMAGE THREAT\\.\\.\\.',
        'FLASH FLOOD DAMAGE THREAT\\.\\.\\.',
        'FLASH FLOOD\\.\\.\\.',
        'TIME\\.\\.\\.MOT\\.\\.\\.LOC',
        'TORNADO\\.\\.\\.',
        'WATERSPOUT\\.\\.\\.',
        'SNOW SQUAL\\.\\.\\.',
        'SNOW SQUALL IMPACT\\.\\.\\.',
        'SNOW SQUALL\\.\\.\\.',
        'MAX WIND GUST\\.\\.\\.',
        'MAX HAIL SIZE\\.\\.\\.',
        'WIND THREAT\\.\\.\\.',
        'HAIL THREAT\\.\\.\\.',
        'WIND, AND HAIL\\.\\.\\.',
        'AND HAIL\\.\\.\\.',
        'EXPECTED RAINFALL RATE\\.\\.\\.'
    ];
    for (const h of oneNL) {
        formatted = formatted.replace(new RegExp('([^\\n\\s])\\s*(' + h + ')', 'g'), '$1\n$2');
        formatted = formatted.replace(new RegExp('\\n+\\s*(' + h + ')', 'g'), '\n$1');
    }

    // Ensure TIME...MOT...LOC is single-lined
    formatted = formatted.replace(/(LAT\.\.\.LON[^\n]*)\n+(\s*TIME\.\.\.MOT\.\.\.LOC)/g, '$1\n$2');

    // Final cleanup
    formatted = formatted.replace(/[ \t]+\n/g, '\n');
    formatted = formatted.replace(/\n{3,}/g, '\n\n');
    formatted = formatted.replace(/^\s+|\s+$/g, '');

    return formatted;
}

/**
 * Clean up and split alert message at delimiter tokens
 * @param {string} msg - Message text to clean and split
 * @returns {string[]} Array of cleaned message blocks
 */
function cleanAndSplitMessage(msg) {
    if (!msg) return [];

    // Remove XML tags
    msg = msg.replace(/<[^>]+>/g, '');

    // Replace 2+ spaces with \n
    msg = msg.replace(/ {2,}/g, '\n');

    // Split at every && or $$, but append the delimiter and its trailing text to the previous part
    let splitRegex = /(\s*(?:&&|\$\$)[^\s]*)/g;
    let parts = [];
    let lastIndex = 0;
    let match;
    while ((match = splitRegex.exec(msg)) !== null) {
        let before = msg.slice(lastIndex, match.index);
        if (parts.length === 0) {
            parts.push(before + match[0]);
        } else {
            parts[parts.length - 1] += before + match[0];
        }
        lastIndex = splitRegex.lastIndex;
    }
    // Any remaining text after the last delimiter
    if (lastIndex < msg.length) {
        let after = msg.slice(lastIndex);
        if (parts.length === 0) {
            parts.push(after);
        } else {
            parts[parts.length - 1] += after;
        }
    }

    // Normalize each part
    let blocks = parts.map(part => normalizeParagraphs(part));
    // Ensure delimiters are surrounded by double newlines
    blocks = blocks.map(b => {
        if (!b) return b;
        b = b.replace(/\s*&&\s*/g, '\n\n&&\n\n');
        b = b.replace(/\s*\$\$\s*/g, '\n\n$$\n\n');
        return b;
    });
    // Remove empty blocks
    return blocks.filter(b => b && b.replace(/\s/g, '').length > 0);
}

module.exports = {
    normalizeParagraphs,
    formatMessageNewlines,
    cleanAndSplitMessage
};
