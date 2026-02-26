function _convertVtecTimeToISO(vtecTime) {
    // VTEC time format: yymmddThhnnZ
    const year = parseInt(vtecTime.slice(0, 2)) + 2000; // Convert to 4-digit year
    const month = parseInt(vtecTime.slice(2, 4)) - 1; // Months are 0-indexed in JS Date
    const day = parseInt(vtecTime.slice(4, 6));
    const hour = parseInt(vtecTime.slice(7, 9));
    const minute = parseInt(vtecTime.slice(9, 11));

    // Create a Date object in UTC
    const date = new Date(Date.UTC(year, month, day, hour, minute));
    
    // Return ISO string
    return date.toISOString();
}


export default function parseVTEC(vtecString) {
    var vtecString = vtecString;

    // VTECs look like this:
    // /k.aaa.cccc.pp.s.####.yymmddThhnnZB-yymmddThhnnZE/
    // See https://www.weather.gov/bmx/vtec for details

    const sampleVtec = '/O.NEW.KBMX.SV.A.0002.051013T1424Z-051013T1700Z/';

    // Split VTEC at "." and remove slashes
    const vtecParts = vtecString.split('.').map(part => part.replace(/\//g, ''));

    // k: Product class (O, T, E, or X)
    // O = Operational
    // T = Test
    // E = Experimental
    // X = Exercise
    var productClass = vtecParts[0];

    // aaa: Action code (NEW, CON, EXT, EXA, EXB, UPG, CAN, EXP, COR, ROU)
    // NEW = New event
    // CON = Continuation (same event, updated information)
    // EXT = Extension (extended expiration time)
    // EXA = Extension (extended area)
    // EXB = Extension (extended time and area)
    // UPG = Upgrade (uncommon)
    // CAN = Cancellation
    // EXP = Expiration
    // COR = Correction
    // ROU = Routine message (uncommon)
    var actionCode = vtecParts[1];

    // cccc: Four-letter NWS office ID that issued the product
    var officeId = vtecParts[2];

    // pp: Phenomena
    // Valid phenomena codes chart can be found here: https://www.weather.gov/bmx/vtec
    var phenomena = vtecParts[3];

    // s: Significance (W, A, Y, or S)
    // W = Warning
    // A = Watch
    // Y = Advisory
    // S = Statement
    var significance = vtecParts[4];

    // ####: Event tracking number
    var eventTrackingNumber = vtecParts[5];

    // yymmddThhnnZB-yymmddThhnnZE: Timing information
    var startTime = vtecParts[6].split('-')[0]; // Start time in yymmddThhnnZ format
    var endTime = vtecParts[6].split('-')[1]; // End time in yymmddThhnnZ format

    // Convert start and end times to ISO format for easier handling
    var startTimeISO = _convertVtecTimeToISO(startTime);
    var endTimeISO = _convertVtecTimeToISO(endTime);

    return {
        vtecString,
        productClass,
        actionCode,
        officeId,
        phenomena,
        significance,
        eventTrackingNumber,
        startTimeISO,
        endTimeISO
    };
}
