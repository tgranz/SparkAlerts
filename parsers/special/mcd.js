function _toIsoFromIssuedLine(line) {
    if (!line) {
        return null;
    }

    const parsed = new Date(line);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }

    return parsed.toISOString();
}

function _toIsoFromValidZ(validToken, referenceIso) {
    if (!validToken || !referenceIso) {
        return null;
    }

    const match = validToken.match(/^(\d{2})(\d{2})(\d{2})Z$/);
    if (!match) {
        return null;
    }

    const [, dayStr, hourStr, minuteStr] = match;
    const ref = new Date(referenceIso);
    if (Number.isNaN(ref.getTime())) {
        return null;
    }

    let year = ref.getUTCFullYear();
    let month = ref.getUTCMonth();
    const day = parseInt(dayStr, 10);
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);

    let candidate = new Date(Date.UTC(year, month, day, hour, minute, 0, 0));
    const diffHours = (candidate.getTime() - ref.getTime()) / 3600000;

    if (diffHours > 72) {
        month -= 1;
        if (month < 0) {
            month = 11;
            year -= 1;
        }
        candidate = new Date(Date.UTC(year, month, day, hour, minute, 0, 0));
    } else if (diffHours < -72) {
        month += 1;
        if (month > 11) {
            month = 0;
            year += 1;
        }
        candidate = new Date(Date.UTC(year, month, day, hour, minute, 0, 0));
    }

    return candidate.toISOString();
}

function _extractSection(text, sectionName, stopSectionNames) {
    const stopPattern = stopSectionNames
        .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');

    const pattern = new RegExp(
        `${sectionName}\\.\\.\\.([\\s\\S]+?)(?:\\n\\n(?:${stopPattern})\\.\\.\\.|$)`,
        'i'
    );

    const match = text.match(pattern);
    return match ? match[1].replace(/\n+/g, ' ').trim() : null;
}

function _extractWatches(concerningText) {
    if (!concerningText) {
        return [];
    }

    const matches = concerningText.match(/\b\d{1,4}\b/g);
    if (!matches) {
        return [];
    }

    return [...new Set(matches.map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n)))];
}

function _extractLatLonGeometry(message) {
    const blockMatch = message.match(/LAT\.\.\.LON\s+([\s\S]+?)(?:\n\n|MOST PROBABLE|$)/i);
    if (!blockMatch) {
        return null;
    }

    const digits = (blockMatch[1].match(/\d{8}/g) || []);
    if (digits.length < 3) {
        return null;
    }

    const coordinates = digits.map((pair) => {
        const lat = parseInt(pair.slice(0, 4), 10) / 100;
        const lon = -parseInt(pair.slice(4, 8), 10) / 100;
        return [lon, lat];
    });

    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
        coordinates.push(first);
    }

    return {
        type: 'Polygon',
        coordinates: [coordinates],
    };
}

function _extractPeakValue(message, label, unit) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedUnit = unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`${escapedLabel}\\.\\.\\.([^\\n]+?)\\s+${escapedUnit}`, 'i');
    const match = message.match(regex);
    return match ? match[1].trim() : null;
}

export default function parseMCD(messageText, issuedAtFallback = null, officeFallback = null) {
    const message = String(messageText || '');

    const numberMatch = message.match(/Mesoscale Discussion\s+(\d{1,4})/i);
    const discussionNumber = numberMatch ? numberMatch[1].padStart(4, '0') : null;

    const officeLineMatch = message.match(/\nNWS Storm Prediction Center\s+([^\n]+)\n/i);
    const officeLine = officeLineMatch ? officeLineMatch[1].trim() : null;

    const issuedLineMatch = message.match(/\n(\d{3,4}\s+[AP]M\s+[A-Z]{2,4}\s+\w{3}\s+\w{3}\s+\d{1,2}\s+\d{4})\n/i);
    const issuedLine = issuedLineMatch ? issuedLineMatch[1].trim() : null;
    const issuedAt = _toIsoFromIssuedLine(issuedLine) || issuedAtFallback || new Date().toISOString();

    const validMatch = message.match(/\nValid\s+(\d{6}Z)\s+-\s+(\d{6}Z)\n/i);
    const validStartIso = validMatch ? _toIsoFromValidZ(validMatch[1], issuedAt) : null;
    const validEndIso = validMatch ? _toIsoFromValidZ(validMatch[2], issuedAt) : null;

    const areasAffected = _extractSection(message, 'Areas affected', ['Concerning', 'Valid']);
    const concerning = _extractSection(message, 'Concerning', ['Valid', 'SUMMARY', 'DISCUSSION']);

    const summaryMatch = message.match(/\nSUMMARY\.\.\.([\s\S]+?)(?:\n\nDISCUSSION\.\.\.|\n\n\.\.|$)/i);
    const summary = summaryMatch ? summaryMatch[1].replace(/\n+/g, ' ').trim() : null;

    const discussionMatch = message.match(/\nDISCUSSION\.\.\.([\s\S]+?)(?:\n\n\.\.|\n\n\.\.Please see|\n\nATTN\.\.\.|\n\nLAT\.\.\.LON|$)/i);
    const discussion = discussionMatch ? discussionMatch[1].trim() : null;

    const peakTornado = _extractPeakValue(message, 'MOST PROBABLE PEAK TORNADO INTENSITY', 'MPH');
    const peakWind = _extractPeakValue(message, 'MOST PROBABLE PEAK WIND GUST', 'MPH');
    const peakHail = _extractPeakValue(message, 'MOST PROBABLE PEAK HAIL SIZE', 'IN');

    const geometry = _extractLatLonGeometry(message);

    return {
        id: discussionNumber ? `SPC-MCD-${discussionNumber}` : `SPC-MCD-${Date.now()}`,
        productCode: 'MCD',
        productName: 'Mesoscale Discussion',
        issuedAt,
        expiresAt: validEndIso || new Date(Date.now() + 2 * 3600000).toISOString(),
        geometry,
        properties: {
            discussionNumber,
            office: officeLine || officeFallback || null,
            validStart: validStartIso,
            validEnd: validEndIso,
            areasAffected,
            concerning,
            watches: _extractWatches(concerning),
            summary,
            discussion,
            peakTornadoMph: peakTornado,
            peakWindMph: peakWind,
            peakHailInches: peakHail,
        },
    };
}