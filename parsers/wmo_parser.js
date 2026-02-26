// Import VTEC parser
import parseVTEC from './vtec.js';

// Regex patterns (all from ChatGPT of course lol)
const productSizeRegex = /^(\d+)/m;
const productHeaderRegex = /^([A-Z]{2}[0-9]{2}[A-Z]{2})\s+([A-Z]{4})\s+(\d{6}Z)/m;
const awipsIdRegex = /^[A-Z0-9]{6}\s*\n\s*\n\s*([A-Z]{2,}[A-Z0-9]*)/m;
const productNameRegex = /\n\n([A-Z][A-Z\s]+[A-Z])\n/;
const zoneIdsRegex = /[A-Z]{2}Z\d{3}/g;
const productMessageRegex = /\d{1,2}:\d{2} [AP]M [A-Z]{3,4} .+? \d{4}\s+(?:[\s\S]*?\d{1,2}:\d{2} [AP]M [A-Z]{3,4} .+? \d{4}\s+)?([\s\S]+?)\$\$/;
const vtecRegex = /(\/.+?\.\d+\.\d{6}T\d{4}Z-\d{6}T\d{4}Z\/)/;

// Storm tracking parameters
const latLonRegex = /LAT\.{3}LON((?:\s+\d{4})+)/;
const timeMotLocRegex = /TIME\.{3}MOT\.{3}LOC\s+(\d{4}Z)\s+(\d+)DEG\s+(\d+)KT\s+(\d{4})\s+(\d{4})/;
const maxHailRegex = /MAX HAIL SIZE\.{3}([\d.]+)\s*IN/;
const maxWindRegex = /MAX WIND GUST\.{3}(<?.\d+)\s*MPH/;
const tornadoRegex = /TORNADO\.{3}(.*)/ ;


export default class WMOParser {
    constructor(fullMessage) {
        // fullMessage is the XMPP stanza object

        // Extract header information from the message
        this.productMessage = fullMessage.getChildText('x');
        this.ttaaii = fullMessage.getChild('x', 'nwws-oi')?.attrs?.ttaaii || null;
        this.issuedAt = fullMessage.getChild('x', 'nwws-oi')?.attrs?.issue || null;
        this.officeCode = fullMessage.getChild('x', 'nwws-oi')?.attrs?.cccc || null;

        // Run processing
        this._process();
    }

    _process() {
        // Line 1 example: 841
        // Extract the product size
        const sizeMatch = this.productMessage.match(productSizeRegex);
        this.productSize = sizeMatch ? sizeMatch[1] : null;

        // Extract VTEC if present
        const vtecMatch = this.productMessage.match(vtecRegex);
        if (vtecMatch) {
            try {
                this.vtec = parseVTEC(vtecMatch[1]);
            } catch (err) {
                this.vtec = null;
            }
        } else {
            this.vtec = null;
        }

        // Line 2 example: WWAK81 PAFC 261815
        // WMO header, office code, date/time
        const headerMatch = this.productMessage.match(productHeaderRegex);
        const [, wmoHeader, officeCode, dateTime] = headerMatch || [null, null, null, null];
        this.wmoHeader = wmoHeader;
        this.officeCode = officeCode || this.officeCode;
        this.dateTime = dateTime;

        // Line 3 example: SPSAER
        // AWIPS ID
        const awipsMatch = this.productMessage.match(awipsIdRegex);
        this.awipsId = awipsMatch ? awipsMatch[1] : null;

        // Product name
        const productNameMatch = this.productMessage.match(productNameRegex);
        this.productName = productNameMatch ? productNameMatch[1].trim() : null;

        // Zone IDs (these are used to calculate geometry if LAT and LON are not present)
        const zoneIds = this.productMessage.match(zoneIdsRegex);
        this.zoneIds = zoneIds || [];

        // Main product message
        let productMessageMatch = this.productMessage.match(productMessageRegex);
        if (!productMessageMatch) {
            const fallbackRegex = /^[A-Z0-9]{6}\s*\n+([\s\S]+?)\$\$/m;
            productMessageMatch = this.productMessage.match(fallbackRegex);
        }
        
        const rawMessage = productMessageMatch ? productMessageMatch[1].trim() : null;

        // Extract storm tracking parameters before cleaning up the message
        this._extractStormParameters(rawMessage);

        this.productMessage = rawMessage;

        // Clean up the message by removing extra newlines and spaces
        if (this.productMessage) {
            this.productMessage = this.productMessage.replace(/\n\n/g, '\n');
        }
    }

    _extractStormParameters(rawMessage) {
        if (!rawMessage) {
            this.geometry = null;
            this.timeMotLoc = null;
            this.maxHail = null;
            this.maxWind = null;
            this.tornado = null;
            return;
        }

        // Extract LAT...LON
        const latLonMatch = rawMessage.match(latLonRegex);
        if (latLonMatch) {
            const coords = latLonMatch[1].trim().split(/\s+/).map(n => parseInt(n));
            
            // Coords are pairs: lat, lon, lat, lon
            const coordinates = [];
            for (let i = 0; i < coords.length; i += 2) {
                const lat = coords[i] / 100;
                const lon = -(coords[i + 1] / 100); // Negative for western hemisphere
                coordinates.push([lon, lat]);
            }

            // Close the polygon if the last coordinate doesn't match the first
            if (coordinates.length > 0 && coordinates[0] !== coordinates[coordinates.length - 1]) {
                coordinates.push(coordinates[0]);
            }
            
            this.geometry = {
                type: 'Polygon',
                coordinates: [coordinates]
            };
        } else {
            this.geometry = null;
        }

        // Extract TIME...MOT...LOC
        const timeMotLocMatch = rawMessage.match(timeMotLocRegex);
        if (timeMotLocMatch) {
            const [, time, direction, speed, lat, lon] = timeMotLocMatch;
            this.timeMotLoc = {
                time: time,
                direction: parseInt(direction),
                speed: parseInt(speed),
                location: {
                    lat: parseInt(lat) / 100,
                    lon: -(parseInt(lon) / 100)
                }
            };
        } else {
            this.timeMotLoc = null;
        }

        // Extract MAX HAIL SIZE
        const maxHailMatch = rawMessage.match(maxHailRegex);
        this.maxHail = maxHailMatch ? parseFloat(maxHailMatch[1]) : null;

        // Extract MAX WIND GUST
        const maxWindMatch = rawMessage.match(maxWindRegex);
        this.maxWind = maxWindMatch ? maxWindMatch[1] : null;

        // Extract TORNADO
        const tornadoMatch = rawMessage.match(tornadoRegex);
        this.tornado = tornadoMatch ? tornadoMatch[1] : null;
    }

    getProperty(propertyName) {
        // Function to return an alert property
        switch (propertyName) {
            case 'ttaaii':
                return this.ttaaii;
            case 'issuedAt':
                return this.issuedAt;
            case 'productSize':
                return this.productSize;
            case 'wmoHeader':
                return this.wmoHeader;
            case 'officeCode':
                return this.officeCode;
            case 'dateTime':
                return this.dateTime;
            case 'awipsId':
                return this.awipsId;
            case 'productName':
                return this.productName;
            case 'zoneIds':
                return this.zoneIds;
            case 'geometry':
                return this.geometry;
            case 'timeMotLoc':
                return this.timeMotLoc;
            case 'maxHail':
                return this.maxHail;
            case 'maxWind':
                return this.maxWind;
            case 'isPds':
                try {
                    return this.productMessage?.toLowerCase().includes('particularly dangerous situation') || false;
                } catch {
                    return false;
                }
            case 'isConsiderable':
                try {
                    return this.productMessage?.toLowerCase().includes('considerable') || false;
                } catch {
                    return false;
                }
            case 'isDestructive':
                try {
                    return this.productMessage?.toLowerCase().includes('destructive') || false;
                } catch {
                    return false;
                }
            case 'vtec':
                return this.vtec;
            case 'tornado':
                return this.tornado;
            case 'expiration':
                return this._getExpiration();
            case 'id':
                // Unique, constant ID that will not change if updated.
                return `${this.officeCode}-${this.awipsId}`;
            default:
                return null;
        }
    }

    getRawMessage() {
        // Function to return the raw message text
        return this.productMessage || null;
    }

    getMessage() {
        return this.productMessage || null;
    }

    _getExpiration() {
        try {
            // Try VTEC endTime first
            if (this.vtec && this.vtec.endTimeISO) {
                return this.vtec.endTimeISO;
            }

            // Try extracting from "THROUGH/UNTIL HH:MM AM/PM TZ" format
            // Example: "THROUGH 500 PM CST" or "UNTIL 5:00 PM CST"
            const throughMatch = this.productMessage.match(/(?:THROUGH|UNTIL)\s+(\d{1,2}:\d{2}|\d{3,4})\s+([AP]M)\s+([A-Z]{3,4})/i);
            if (throughMatch) {
                const parsed = this._parseTimeString(throughMatch[1]);
                if (parsed) {
                    return this._parseTimeToISO(parsed.hour, parsed.minute, throughMatch[2], throughMatch[3]);
                }
            }

            // Fallback to zone line format: [ZONE]-[ZONE]-DDHHKK-
            // Example: ALZ014-015-262100-
            const zoneExpireMatch = this.productMessage.match(/\n([A-Z]{2}Z[\d->&]*?)(\d{6})-\n/);
            if (!zoneExpireMatch) {
                return null;
            }

            const expireTimeStr = zoneExpireMatch[2]; // DDHHKK string
            const day = expireTimeStr.slice(0, 2);
            const hour = expireTimeStr.slice(2, 4);
            const minute = expireTimeStr.slice(4, 6);

            // Extract timezone from product message (e.g., "210 PM CST")
            const tzMatch = this.productMessage.match(/\d{1,2}:\d{2}\s+[AP]M\s+([A-Z]{3,4})/);
            const tzCode = tzMatch ? tzMatch[1] : null;
            const offset = this._getTimezoneOffset(tzCode);

            // Get year and month from issued time
            const issuedDate = new Date(this.issuedAt);
            const year = issuedDate.getUTCFullYear();
            const monthNum = issuedDate.getUTCMonth() + 1;

            // Create UTC date from the parsed components, then add the offset
            const utcMs = Date.UTC(year, monthNum - 1, parseInt(day), parseInt(hour), parseInt(minute), 0) + (offset * 3600000);
            const utcDate = new Date(utcMs);
            
            return utcDate.toISOString();
        } catch (err) {
            return null;
        }
    }

    _parseTimeToISO(hourStr, minuteStr, ampm, tzCode) {
        try {
            let hour = parseInt(hourStr, 10);
            const minute = minuteStr ? parseInt(minuteStr, 10) : 0;
            
            // Convert 12-hour to 24-hour format
            if (ampm === 'PM' && hour !== 12) {
                hour += 12;
            } else if (ampm === 'AM' && hour === 12) {
                hour = 0;
            }

            const offset = this._getTimezoneOffset(tzCode);
            
            // Get year, month, day from issued time
            const issuedDate = new Date(this.issuedAt);
            const year = issuedDate.getUTCFullYear();
            const monthNum = issuedDate.getUTCMonth() + 1;
            const dayNum = issuedDate.getUTCDate();
            
            // Create UTC date and add offset
            const utcMs = Date.UTC(year, monthNum - 1, dayNum, hour, minute, 0) + (offset * 3600000);
            const utcDate = new Date(utcMs);
            
            return utcDate.toISOString();
        } catch (err) {
            return null;
        }
    }

    _parseTimeString(timeStr) {
        if (!timeStr) {
            return null;
        }

        if (timeStr.includes(':')) {
            const [hourPart, minutePart] = timeStr.split(':');
            return { hour: hourPart, minute: minutePart };
        }

        if (timeStr.length === 3) {
            return { hour: timeStr.slice(0, 1), minute: timeStr.slice(1) };
        }

        if (timeStr.length === 4) {
            return { hour: timeStr.slice(0, 2), minute: timeStr.slice(2) };
        }

        return null;
    }

    _getTimezoneOffset(tzCode) {
        const tzOffsets = {
            'EST': 5, 'EDT': 4,
            'CST': 6, 'CDT': 5,
            'MST': 7, 'MDT': 6,
            'PST': 8, 'PDT': 7,
            'AKST': 9, 'AKDT': 8,
            'HST': 10, 'HDT': 9,
            'ASST': 4, 'ASDT': 3,
            'CHST': -10,
            'AEST': -10, 'AEDT': -11
        };

        return tzOffsets[tzCode] !== undefined ? tzOffsets[tzCode] : 0;
    }
}