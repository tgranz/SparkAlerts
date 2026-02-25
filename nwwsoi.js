/*
(c) 2026 Tyler G - see LICENSE

This file hosts an asynchronous function to listen to the NWWS-OI
XMPP feed, parses incoming alert messages, and stores them in alerts.json
such that the server can be restarted without losing data.

It also performs periodic cleanup of expired alerts from the database.

*/


// Imports
const fs = require('fs');
const { nosyncLog } = require('./logging.js').nosyncLog;
const xml2js = require('xml2js');
const path = require('path');
const { log } = require('./logging.js');
const { sign } = require('crypto');
const https = require('https');

// Utility imports
const { parseVTEC, parseVTECFromPart, vtecToIso } = require('./utils/vtec.js');
const { parseHumanTimestampFromText } = require('./utils/timestamp.js');
const { ugcToFips, expandUgcGroup, lookupZoneDisplay } = require('./utils/ugc.js');
const { normalizeParagraphs, formatMessageNewlines, cleanAndSplitMessage } = require('./utils/message-formatter.js');
const { extractCoordinates, createPolygonGeometry } = require('./utils/coordinates.js');
const { loadAlerts, saveAlerts, deleteExpiredAlerts, applyStartupFilter, upsertAlerts, deleteAlertById } = require('./utils/alert-database.js');

// For storing credentials
var username = null;
var password = null;
var resource = null;
var MAX_RECONNECT_ATTEMPTS = 10;
var INITIAL_RECONNECT_DELAY = 2000;

// Load configuration
const configPath = path.join(__dirname, 'config.json');
let config = {};
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.error('Could not load config.json:', e);
    config = {};
}

// Startup alert filtering
try {
    applyStartupFilter();
} catch (err) {
    console.error('Error during startup alert filter:', err);
}

(async () => {
    // Polyfill WebSocket for @xmpp/client
    const { client, xml } = await import('@xmpp/client');
    const wsModule = await import('ws');
    global.WebSocket = wsModule.default || wsModule.WebSocket || wsModule;

    // Variable to store the interval ID so we can stop it if needed
    let deleteExpiredAlertsInterval = null;

    // Run the deleteExpiredAlerts task every minute
    if (!deleteExpiredAlertsInterval) {
        deleteExpiredAlerts();
        deleteExpiredAlertsInterval = setInterval(deleteExpiredAlerts, 60 * 1000);
    }

    // Connection management
    let reconnectAttempt = 0;
    const MAX_RECONNECT_ATTEMPTS = 10;
    const RECONNECT_DELAY = 2000; // 2 seconds

    // Function to create XMPP client object
    function createXMPPClient() {
        console.log('Creating XMPP client...');
        // Read XMPP configuration from environment variables to avoid hard-coding credentials.
        const xmppConfig = {
            service: 'xmpp://nwws-oi.weather.gov',
            domain: 'nwws-oi.weather.gov',
            username: username,
            password: password,
            resource: resource
        };

        if (!xmppConfig.username || !xmppConfig.password) {
            console.warn('No credentials found in .env file! Did you set XMPP_USERNAME and XMPP_PASSWORD variables?');
            process.exit(1);
        }
        
        console.log(`Connecting as ${xmppConfig.username} with resource: ${xmppConfig.resource}`);

        const xmpp = client(xmppConfig);

        // Handle disconnections
        xmpp.on('disconnect', () => {
            log('XMPP client disconnected. Reconnecting...');
            handleReconnect();
        });

        // Handle connection closed
        xmpp.on('close', () => {
            log('XMPP connection closed. Reconnecting...');
            handleReconnect();
        });

        return xmpp;
    }

    async function handleReconnect() {
        console.log('Handling reconnection...');
        // Clear any existing intervals
        if (deleteExpiredAlertsInterval) {
            clearInterval(deleteExpiredAlertsInterval);
            deleteExpiredAlertsInterval = null;
            console.log('Cleared existing cleanup interval');
        }

        if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
            log('Max reconnection attempts reached. Check network connection and credentials, or increase MAX_RECONNECT_ATTEMPTS.');
            console.error('FATAL: Max reconnection attempts reached!');
            process.exit(1);
        }

        // Exponential backoff with jitter
        const delay = RECONNECT_DELAY * Math.pow(2, reconnectAttempt) + Math.random() * 1000;
        log(`Attempting reconnection in ${Math.round(delay / 1000)} seconds (attempt ${reconnectAttempt + 1}/${MAX_RECONNECT_ATTEMPTS})...`);
        await new Promise(resolve => setTimeout(resolve, delay));

        // Increment attempt counter
        reconnectAttempt++;

        try {
            // Attempt to create and start a new XMPP client
            xmpp = createXMPPClient();
            await xmpp.start();
            console.log('Reconnection successful!');
        } catch (err) {
            // If restart fails, log and try again
            log(`Reconnection attempt failed: ${err.message}`);
            console.error(`Reconnection attempt ${reconnectAttempt} failed:`, err.message);
            handleReconnect();
        }
    }



    // Create initial XMPP client
    var xmpp = createXMPPClient();

    // Event listener for online event
    xmpp.on('online', (address) => {
        // Reset reconnection counter on successful connection
        reconnectAttempt = 0;

        // Log connection
        log(`Connected to XMPP server as ${address}`);
        console.log('Connected to XMPP server successfully.');

        // Join the NWWS chat room
        try {
            xmpp.send(
                xml('presence', { to: 'nwws@conference.nwws-oi.weather.gov/SparkRadar' })
            );
        } catch (err) {
            // If there is an error joining, log and try again
            log(`Error joining NWWS room: ${err.message}`);
            handleReconnect();
        }
    });

    // Load allowed alerts from config
    let allowedAlerts = (config.allowedAlerts && Array.isArray(config.allowedAlerts)) ? config.allowedAlerts : [];
    let allowNoGeometry = (config.allowNoGeometry === true);

    // Load FIPS county geometry database at startup
    const fipsGeometryPath = path.join(__dirname, 'fips_county_geometry.json');
    let fipsGeometry = {};
    try {
        const raw = fs.readFileSync(fipsGeometryPath, 'utf8').trim();
        fipsGeometry = raw ? JSON.parse(raw) : {};
    } catch (e) {
        console.error('Could not load fips_county_geometry.json:', e);
        fipsGeometry = {};
    }

    // Event listener for incoming stanzas (messages)
    xmpp.on('stanza', (stanza) => {


        // Ignore non-message stanzas (specifically presence notifications)
        if (!stanza.is('message')) { console.log("Ignoring non-message stanza."); return; }

        // The chat room sends this warning when a user joins, safely ignore it
        if (stanza.toString().includes("**WARNING**WARNING**WARNING**WARNING")) { console.log("Ignoring non-message stanza."); return; }

        // Turn the XML to JSON because I hate XML
        var xml = stanza.toString();
        var parser = new xml2js.Parser();

        // Message processing
        parser.parseString(xml, async (err, result) => {
            // capture coordinates extracted from CAP XML (if any)
            let capCoordinates = null;
            // values extracted from non-VTEC CAP XML (used only for the minimal cleanup path)
            let capSent = null;
            let capExpires = null;
            let capIdentifier = null;
            let capNwsHeadline = null;

            // If there is any error parsing, log and ignore
            if (err) {
                log('Error parsing XML message:', err);
                console.error('Error parsing XML, message will not be processed:', err);
                return;
            } else if (!result || !result.message || !result.message.body || !Array.isArray(result.message.body)) {
                console.error('Invalid XML message structure:', result);
                log('Invalid XML message structure, message will not be processed. See console output for details.');
                return;
            }

            // Extract the message body
            var body = result.message.body[0];
            if (body === undefined || body === null) {
                console.error('Message body is empty, ignoring.');
                log('XML message body is empty, ignoring.');
                return;
            }

            // Extract raw text content
            var rawText = result.message.x[0]._;
            // Only do basic escaping cleanup early — preserve preamble structure
            rawText = rawText.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');


            // If the message contains any of the keywords, skip CAP XML cleanup.
            // Keywords: URGENT, STATEMENT, MESSAGE, REQUEST, BULLETIN (case-insensitive)
            const fullMsgKeywords = /\b(URGENT|STATEMENT|MESSAGE|REQUEST|BULLETIN)\b/i;
            const isFullMessage = fullMsgKeywords.test(rawText);

            let cleanedCAPXML = false;
            // set when we perform the non‑VTEC "minimal cleanup" from a CAP payload —
            // used to prevent splitting and other full-message behaviors
            let capMinimalCleanup = false;
            if (!isFullMessage) {
                // If the message contains a CAP XML payload, clean it up as requested
                const capMatch = rawText.match(/<\?xml[\s\S]*?<alert[\s\S]*?<\/alert>/);
                if (capMatch) {
                    cleanedCAPXML = true;
                    const capXml = capMatch[0];
                    const capParser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
                    capParser.parseString(capXml, (capErr, capObj) => {
                        if (capErr || !capObj || !capObj.alert) {
                            // If parsing fails, fallback to original message
                            return;
                        }
                        const alert = capObj.alert;
                        const info = Array.isArray(alert.info) ? alert.info[0] : alert.info;

                        // Helper to get parameter by valueName
                        function getParam(name) {
                            if (!info.parameter) return '';
                            const params = Array.isArray(info.parameter) ? info.parameter : [info.parameter];
                            const found = params.find(p => p.valueName && p.valueName.toUpperCase() === name.toUpperCase());
                            return found ? found.value : '';
                        }

                        // Format sent time
                        function formatSentTime(sent) {
                            if (!sent) return '';
                            try {
                                const d = new Date(sent);
                                // Example: 144 PM CST Sat Jan 31 2026
                                const options = { weekday: 'short', year: 'numeric', month: 'short', day: '2-digit' };
                                let hours = d.getHours();
                                let mins = d.getMinutes();
                                let ampm = hours >= 12 ? 'PM' : 'AM';
                                let hour12 = hours % 12 || 12;
                                let tz = sent.includes('-06:00') ? 'CST' : sent.includes('-05:00') ? 'EST' : 'UTC';
                                return `${hour12}${mins.toString().padStart(2, '0')} ${ampm} ${tz} ${d.toLocaleDateString('en-US', options).replace(/,/g, '')}`;
                            } catch {
                                return sent;
                            }
                        }

                        // Clean senderName
                        let sender = info.senderName || '';
                        sender = sender.replace(/^NWS\s*/i, 'National Weather Service ');

                        // Compose output
                        let cleanedMsg = '';
                        cleanedMsg += sender ? sender + '\n' : '';
                        cleanedMsg += getParam('VTEC') ? getParam('VTEC') + '\n' : '';
                        cleanedMsg += alert.sent ? formatSentTime(alert.sent) + '\n' : '';
                        // prefer to preserve NWSheadline in `headline` (do NOT duplicate into the message)
                        const _nwsHeadline = getParam('NWSheadline') || '';
                        if (_nwsHeadline) {
                            // Strip the literal "NWSheadline" prefix if present
                            capNwsHeadline = _nwsHeadline.replace(/^NWSheadline\s+/i, '').trim();
                        }
                        cleanedMsg += info.description ? info.description + '\n' : '';
                        cleanedMsg += info.instruction ? info.instruction + '\n' : '';

                        // Try to preserve LAT...LON / coordinates from CAP for non-VTEC minimal cleanup
                        try {
                            function decToUgcpair(lat, lon) {
                                const la = Math.round(Math.abs(Number(lat)) * 100);
                                const lo = Math.round(Math.abs(Number(lon)) * 100);
                                return `${String(la).padStart(4, '0')} ${String(lo)}`;
                            }
                            function ugcPairToCoord(pair) {
                                const parts = pair.trim().split(/\s+/);
                                const lat = parseFloat(parts[0].slice(0,2) + '.' + parts[0].slice(2));
                                // Longitude can be 4 digits (lon < 100) or 5 digits (lon >= 100)
                                const lonStr = parts[1];
                                const lonInt = lonStr.length === 5 ? lonStr.slice(0,3) : lonStr.slice(0,2);
                                const lonDec = lonStr.length === 5 ? lonStr.slice(3) : lonStr.slice(2);
                                const lon = -parseFloat(lonInt + '.' + lonDec);
                                return [lat, lon];
                            }

                            let earlyPairs = [];

                            // 1) polygon points in info.area.polygon
                            if (info.area) {
                                const areas = Array.isArray(info.area) ? info.area : [info.area];
                                for (const a of areas) {
                                    const poly = a && (a.polygon || a.Polygon);
                                    if (!poly) continue;
                                    const pts = String(poly).trim().split(/\s+/);
                                    for (const pt of pts) {
                                        const m = pt.match(/^(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)$/);
                                        if (m) earlyPairs.push(decToUgcpair(m[1], m[2]));
                                    }
                                }
                            }

                            // 2) decimal lat,lon anywhere in capXml
                            const decPairRe = /(-?\d{1,2}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/g;
                            let _m;
                            while ((_m = decPairRe.exec(capXml)) !== null) {
                                earlyPairs.push(decToUgcpair(_m[1], _m[2]));
                            }

                            // 3) explicit LAT...LON line in CAP XML
                            const latLonRegex = /LAT\.\.\.LON\s+([0-9\s\-]+)/i;
                            const latLonMatch = capXml.match(latLonRegex);
                            if (latLonMatch && latLonMatch[1]) {
                                const groups = latLonMatch[1].replace(/[^0-9\s]/g, ' ').trim().split(/\s+/).filter(g => /^\d{4}$/.test(g));
                                for (const g of groups) earlyPairs.push(g);
                            }

                            earlyPairs = Array.from(new Set(earlyPairs)).filter(g => /^\d{4}\s+\d{4,5}$/.test(g));
                            if (earlyPairs.length > 0) {
                                // append LAT...LON to the cleaned minimal message
                                cleanedMsg += 'LAT...LON ' + earlyPairs.join(' ') + '\n';
                                // populate capCoordinates so later logic can attach `coordinates`
                                capCoordinates = earlyPairs.map(ugcPairToCoord).filter(Boolean);
                            }
                        } catch (e) {
                            // ignore errors extracting coordinates here
                        }

                        // Prepend any original preamble (e.g., 194\n\nXOUS54 KWBC 311944\n\nCAPLIX\n\n)
                        const preambleMatch = rawText.match(/^[\s\S]*?(?=<\?xml)/);
                        let finalMsg = (preambleMatch ? preambleMatch[0] : '') + cleanedMsg;

                        // Normalize paragraphs (preserve paragraph breaks; join wrapped lines)
                        finalMsg = normalizeParagraphs(finalMsg);
                        if (capNwsHeadline) {
                            // remove leading occurrence of the headline from the message body
                            const re = new RegExp('^' + capNwsHeadline.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\s*\\n?', 'i');
                            if (/\/O\..*?\/\n?/.test(rawText) || /<parameter>\s*<valueName>VTEC<\/valueName>/i.test(rawText)) finalMsg = finalMsg.replace(re, '').trim();
                        }

                        // Replace message in parsedAlert/message
                        rawText = finalMsg;
                    });
                    // Normalize the full rawText after CAP cleanup to convert escape sequences and clean structure
                    rawText = formatMessageNewlines(rawText);
                }
            }

            // VTEC parser
            // https://www.weather.gov/bmx/vtec

            let thisObject = parseVTEC(rawText, parseHumanTimestampFromText) || {};
            let vtec = null;
            let vtecObjects = [];

            if (
                cleanedCAPXML &&
                thisObject.phenomena &&
                thisObject.significance
            ) {
                // Do not add this alert
                console.log('Alert has both VTEC and cleaned CAP XML, skipping.');
                return;
            }

            // If the message is just a CAP XML block, skip it
            const isRawXMLOnly = (
                rawText.trim().startsWith('<?xml') &&
                rawText.trim().endsWith('</alert>')
            );
            if (isRawXMLOnly) {
                console.log('Alert message is raw XML only, skipping.');
                return;
            }

            // Reject messages that look like embedded/serialized JSON or a full CAP object
            const jsonLikePairs = (rawText.match(/"\w+"\s*:\s*"/g) || []).length;
            const looksLikeEmbeddedJson = /urn:oid:|"properties"\s*:|"event_tracking_number"|"product_type"|\bvtec\b\s*:|\bstartTime\b/i.test(rawText) || jsonLikePairs >= 3;
            
            const capXmlPresent = /<\?xml[\s\S]*?<alert[\s\S]*?<\/alert>/.test(rawText);
            if (looksLikeEmbeddedJson && !capXmlPresent) {
                console.log('Alert message appears to be embedded/serialized CAP/JSON — skipping.');
                log('Skipped message that appears to be embedded/serialized CAP/JSON.');
                return;
            }

            // Allow alerts with missing VTEC/phenomena/significance if event is allowed
            let allowByEvent = false;
            let eventName = null;
            if (!thisObject.phenomena || !thisObject.significance) {
                // Try to extract <event>...</event> from XML
                let eventMatch = rawText.match(/<event>(.*?)<\/event>/i);
                if (eventMatch && eventMatch[1]) {
                    eventName = eventMatch[1].trim();
                } else {
                    // Try to extract from CAP XML if present
                    const capMatch = rawText.match(/<\?xml[\s\S]*?<alert[\s\S]*?<\/alert>/);
                    if (capMatch) {
                        const capXml = capMatch[0];
                        try {
                            const capParser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
                            let capObj = await capParser.parseStringPromise(capXml);
                            if (capObj && capObj.alert && capObj.alert.info && capObj.alert.info.event) {
                                eventName = capObj.alert.info.event;
                            }
                        } catch (e) { /* ignore */ }
                    }
                }
                if (eventName && allowedAlerts.includes(eventName)) {
                    allowByEvent = true;
                }
            }

            // If the alert does NOT have VTEC (no phenomena/significance) but contains CAP XML,
            // perform a minimal cleanup: keep only event, sender, ugc, areaDesc, sent, description,
            // and instruction (only if present). This prevents raw CAP XML from showing up.
            if ((!thisObject.phenomena || !thisObject.significance)) {
                const capMatch2 = rawText.match(/<\?xml[\s\S]*?<alert[\s\S]*?<\/alert>/);
                if (capMatch2) {
                    try {
                        const capXml = capMatch2[0];
                        const capParser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
                        const capObj = await capParser.parseStringPromise(capXml);
                        // Only proceed if this is a non-VTEC alert (no phenomena/significance) and valid CAP XML
                        if (capObj && capObj.alert && capObj.alert.info && (!thisObject.phenomena || !thisObject.significance)) {
                            const info = Array.isArray(capObj.alert.info) ? capObj.alert.info[0] : capObj.alert.info;

                            function extractText(node) {
                                if (!node) return '';
                                if (typeof node === 'string') return node.trim();
                                if (Array.isArray(node)) return node.map(extractText).join('\n').trim();
                                if (typeof node === 'object') {
                                    if (node._) return String(node._).trim();
                                    if (node['#text']) return String(node['#text']).trim();
                                    return Object.values(node).filter(v => typeof v === 'string' && v.trim()).join(' ').trim();
                                }
                                return '';
                            }

                            // Find preamble before CAP XML (e.g., "552\nWWUS83 KLMK 061958\nSPSLMK.")
                            const preambleMatch = rawText.match(/^([\s\S]*?)(?=<\?xml)/);
                            let preamble = preambleMatch ? preambleMatch[1].trim() : '';



                            const event = extractText(info.event);

                            // If the preamble (text before the CAP XML) begins with the same text as the
                            // CAP `NWSheadline` or the `<event>` string, drop that first line so we do
                            // not duplicate the headline inside the `message` for non‑VTEC cleanup.
                            if (preamble) {
                                const lines = preamble.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                                if (lines.length) {
                                    const first = lines[0];
                                    if ((capNwsHeadline && first.toUpperCase() === capNwsHeadline.toUpperCase()) ||
                                        (event && first.toUpperCase() === event.toUpperCase())) {
                                        lines.shift();
                                        preamble = lines.join('\n').trim();
                                    }
                                }
                            }

                            const senderRaw = extractText(info.senderName || capObj.alert.sender || capObj.alert.senderName);
                            const sender = senderRaw ? senderRaw.replace(/^NWS\s*/i, 'National Weather Service ') : '';

                            // --- Collect and normalize UGCs from any likely source ---
                            function collectUgcTokens(...sources) {
                                const rePair = /([A-Z]{2,3})(\d{3})/g;
                                const map = Object.create(null); // prefix -> Set(numbers)
                                let timestampSuffix = '';

                                for (const src of sources) {
                                    if (!src) continue;
                                    // Preserve possible timestamp like 121900-
                                    const tsMatch = String(src).match(/(\b\d{6}-)\b/);
                                    if (tsMatch) timestampSuffix = tsMatch[1];

                                    let m;
                                    while ((m = rePair.exec(String(src))) !== null) {
                                        const prefix = m[1];
                                        const num = parseInt(m[2], 10);
                                        map[prefix] = map[prefix] || new Set();
                                        map[prefix].add(num);
                                    }
                                }

                                // Build canonical UGC string
                                const prefixes = Object.keys(map).sort();
                                if (prefixes.length === 0) return '';

                                function compressNums(numsArr) {
                                    numsArr.sort((a,b)=>a-b);
                                    const parts = [];
                                    let i = 0;
                                    while (i < numsArr.length) {
                                        let start = numsArr[i];
                                        let j = i;
                                        while (j+1 < numsArr.length && numsArr[j+1] === numsArr[j] + 1) j++;
                                        const len = j - i + 1;
                                        const end = numsArr[j];
                                        if (len === 1) parts.push(String(start).padStart(3,'0'));
                                        else if (len === 2) parts.push(String(start).padStart(3,'0') + '-' + String(end).padStart(3,'0'));
                                        else parts.push(String(start).padStart(3,'0') + '>' + String(end).padStart(3,'0'));
                                        i = j + 1;
                                    }
                                    return parts.join('-');
                                }

                                const out = [];
                                for (const p of prefixes) {
                                    const nums = Array.from(map[p]);
                                    const compressed = compressNums(nums);
                                    if (compressed) out.push(p + compressed);
                                }

                                let result = out.join('-');
                                if (timestampSuffix && !result.endsWith('-')) result += '-';
                                if (timestampSuffix) result += timestampSuffix;
                                // Ensure trailing hyphen
                                if (!result.endsWith('-')) result += '-';
                                return result;
                            }

                            // Gather candidate sources for UGC tokens
                            const ugcCandidates = [];
                            if (info.parameter) {
                                const params = Array.isArray(info.parameter) ? info.parameter : [info.parameter];
                                const found = params.find(p => p.valueName && p.valueName.toUpperCase() === 'UGC');
                                if (found) ugcCandidates.push(extractText(found.value));
                            }
                            if (info.ugc) ugcCandidates.push(extractText(info.ugc));
                            if (info.area) {
                                const areas = Array.isArray(info.area) ? info.area : [info.area];
                                for (const a of areas) {
                                    if (!a) continue;
                                    if (a.geocode) {
                                        const geos = Array.isArray(a.geocode) ? a.geocode : [a.geocode];
                                        for (const g of geos) {
                                            if (g && g.value) ugcCandidates.push(extractText(g.value));
                                        }
                                    }
                                    if (a.areaDesc) ugcCandidates.push(extractText(a.areaDesc));
                                }
                            }
                            if (preamble) ugcCandidates.push(preamble);
                            if (rawText) ugcCandidates.push(rawText);

                            const ugcLine = collectUgcTokens(...ugcCandidates);

                            // Clean areaDesc: replace semicolons/commas/newlines with hyphens and ensure trailing '-'
                            let areaDesc = extractText(info.area && info.area.areaDesc);
                            if (areaDesc) {
                                areaDesc = areaDesc.replace(/[;,]/g, '-').replace(/\s*\n\s*/g, '-').replace(/\s+/g, ' ').trim();
                                areaDesc = areaDesc.replace(/-+/g, '-').replace(/^[-\s]+|[-\s]+$/g, '');
                                if (areaDesc.length) areaDesc = areaDesc + '-';
                            }

                            const sent = extractText(capObj.alert.sent);
                            let description = extractText(info.description);
                            const instruction = extractText(info.instruction);

                            try {
                                if (capObj && capObj.alert) {
                                    // identifier -> use as fallback id / eventTrackingNumber
                                    if (capObj.alert.identifier) capIdentifier = String(capObj.alert.identifier).trim();

                                    // sent -> canonical ISO used for issued / startTime
                                    if (capObj.alert.sent) {
                                        try { capSent = new Date(String(capObj.alert.sent)).toISOString(); } catch (e) { capSent = null; }
                                        if (!thisObject.startTime) thisObject.startTime = capSent;
                                    }

                                    // expires -> canonical ISO used for expiry / endTime
                                    let _capExpiresSrc = null;
                                    if (capObj.alert.expires) {
                                        _capExpiresSrc = capObj.alert.expires;
                                    } else if (capObj.alert.info) {
                                        const _info = Array.isArray(capObj.alert.info) ? capObj.alert.info[0] : capObj.alert.info;
                                        if (_info && _info.expires) _capExpiresSrc = _info.expires;
                                    }
                                    if (_capExpiresSrc) {
                                        try { capExpires = new Date(String(_capExpiresSrc)).toISOString(); } catch (e) { capExpires = null; }
                                        if (!thisObject.endTime) thisObject.endTime = capExpires;
                                    }

                                    // prefer NWSheadline parameter for headline when present
                                    if (info.parameter) {
                                        const params = Array.isArray(info.parameter) ? info.parameter : [info.parameter];
                                        const nh = params.find(p => p.valueName && String(p.valueName).toUpperCase() === 'NWSHEADLINE');
                                        if (nh) capNwsHeadline = extractText(nh.value);
                                    }

                                    // populate eventTrackingNumber fallback from CAP identifier or info/eventTrackingNumber param
                                    let capEventTrack = null;
                                    if (info.eventTrackingNumber) capEventTrack = extractText(info.eventTrackingNumber);
                                    if (!capEventTrack && info.parameter) {
                                        const params2 = Array.isArray(info.parameter) ? info.parameter : [info.parameter];
                                        const et = params2.find(p => p.valueName && /EVENTTRACKINGNUMBER/i.test(p.valueName));
                                        if (et) capEventTrack = extractText(et.value);
                                    }
                                    if (!thisObject.eventTrackingNumber) thisObject.eventTrackingNumber = capEventTrack || capIdentifier || '';
                                }
                            } catch {}

                            // For non-VTEC minimal-cleanup prefer the CAP <event> as the alert `name`
                            if (event && event.length) {
                                alertName = event;
                            }

                            if (areaDesc) areaDesc = normalizeParagraphs(areaDesc);
                            if (capNwsHeadline) capNwsHeadline = normalizeParagraphs(capNwsHeadline);
                            if (description) description = normalizeParagraphs(description);
                            if (instruction) instruction = normalizeParagraphs(instruction);

                            // Only include specific fields in fixed order, plus extracted coordinates and parameters
                            let minimalParts = [];
                            if (areaDesc) minimalParts.push(areaDesc);
                            if (event) minimalParts.push(event);
                            if (capNwsHeadline) minimalParts.push(capNwsHeadline);
                            if (description) minimalParts.push(description);
                            if (instruction) minimalParts.push(instruction);

                            // Add coordinates (LAT...LON)
                            if (latLonPairs && latLonPairs.length > 0) {
                                minimalParts.push('LAT...LON ' + latLonPairs.join(' '));
                            }

                            // Add TIME...MOT...LOC
                            if (typeof eventMotion !== 'undefined') {
                                // Compose cleaned TIME...MOT...LOC string
                                const txt = String(eventMotion);
                                let time = null;
                                const isoMatch = txt.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+\-]\d{2}:\d{2})?/);
                                if (isoMatch) {
                                    function isoToZuluHhmm(iso) {
                                        try {
                                            const d = new Date(iso);
                                            if (isNaN(d.getTime())) return null;
                                            const hh = String(d.getUTCHours()).padStart(2, '0');
                                            const mm = String(d.getUTCMinutes()).padStart(2, '0');
                                            return `${hh}${mm}Z`;
                                        } catch {
                                            return null;
                                        }
                                    }
                                    time = isoToZuluHhmm(isoMatch[0]);
                                }
                                if (!time) {
                                    const zMatch = txt.match(/\b(\d{3,4}Z)\b/);
                                    if (zMatch) time = zMatch[1];
                                }
                                const degMatch = txt.match(/(\d{1,3})\s*DEG/i);
                                const ktMatch = txt.match(/(\d{1,3})\s*KT/i);
                                let motion = null;
                                if (degMatch || ktMatch) {
                                    motion = `${degMatch ? degMatch[1] + 'DEG' : ''}${degMatch && ktMatch ? ' ' : ''}${ktMatch ? ktMatch[1] + 'KT' : ''}`.trim();
                                }
                                function extractCoords(txt) {
                                    const coords = [];
                                    const decPairRe = /(-?\d{1,2}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/g;
                                    let m;
                                    while ((m = decPairRe.exec(txt)) !== null) {
                                        coords.push(decToUgcpair(m[1], m[2]));
                                    }
                                    const ugcRe = /\b(\d{4})\s+(\d{4,5})\b/g;
                                    while ((m = ugcRe.exec(txt)) !== null) {
                                        coords.push(`${m[1]} ${m[2]}`);
                                    }
                                    return coords;
                                }
                                const coords = extractCoords(txt);
                                const parts = [];
                                if (time) parts.push(time);
                                if (motion) parts.push(motion);
                                if (coords.length) parts.push(...coords);
                                const cleaned = parts.join(' ');
                                if (cleaned.length || time || motion || coords.length) {
                                    minimalParts.push('TIME...MOT...LOC ' + cleaned);
                                }
                            }

                            // Add waterspout, max hail, max wind
                            if (typeof waterspoutLine !== 'undefined' && waterspoutLine) minimalParts.push(waterspoutLine);
                            if (typeof maxHailLine !== 'undefined' && maxHailLine) minimalParts.push(maxHailLine);
                            if (typeof maxWindLine !== 'undefined' && maxWindLine) minimalParts.push(maxWindLine);

                            // --- START: Extract coordinates (LAT...LON) and Event Motion for message ---
                            function decToUgcpair(lat, lon) {
                                const la = Math.round(Math.abs(Number(lat)) * 100);
                                const lo = Math.round(Math.abs(Number(lon)) * 100);
                                return `${String(la).padStart(4, '0')} ${String(lo).padStart(4, '0')}`;
                            }
                            let latLonPairs = [];
                            try {
                                let groups = [];
                                // 1) Try CAP <area><polygon>
                                if (info && info.area) {
                                    const areas = Array.isArray(info.area) ? info.area : [info.area];
                                    for (const a of areas) {
                                        const poly = a && (a.polygon || a.Polygon);
                                        if (!poly) continue;
                                        const pts = String(poly).trim().split(/\s+/);
                                        for (const pt of pts) {
                                            const m = pt.match(/^(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)$/);
                                            if (m) groups.push(decToUgcpair(m[1], m[2]));
                                        }
                                    }
                                }
                                // 2) Fallback: scan CAP XML for decimal lat,lon pairs anywhere
                                if (groups.length < 1 && capXml) {
                                    const decPairRe = /(-?\d{1,2}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/g;
                                    let m;
                                    while ((m = decPairRe.exec(capXml)) !== null) {
                                        groups.push(decToUgcpair(m[1], m[2]));
                                    }
                                }
                                // 3) Fallback: scan rawText for decimal lat,lon pairs
                                if (groups.length < 1 && rawText) {
                                    const decPairRe = /(-?\d{1,2}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/g;
                                    let m;
                                    while ((m = decPairRe.exec(rawText)) !== null) {
                                        groups.push(decToUgcpair(m[1], m[2]));
                                    }
                                }
                                // 4) Fallback: look for explicit LAT...LON line in CAP or raw text
                                if (groups.length < 1) {
                                    const latLonRegex = /LAT\.\.\.LON\s+([0-9\s\-]+)/i;
                                    const latLonSource = (capXml && capXml.match(latLonRegex)) ? capXml : rawText;
                                    const latLonMatch = latLonSource.match(latLonRegex);
                                    if (latLonMatch && latLonMatch[1]) {
                                        groups = latLonMatch[1].replace(/[^0-9\s]/g, ' ').trim().split(/\s+/).filter(g => /^\d{4}$/.test(g));
                                    }
                                }
                                // Deduplicate and validate coordinate pairs (4 or 5 digit longitude)
                                latLonPairs = Array.from(new Set(groups)).filter(g => /^\d{4}\s+\d{4,5}$/.test(g));
                                // Convert UGC-style pairs back to numeric [lat, lon] and store for later use
                                if (latLonPairs.length > 0) {
                                    function ugcPairToCoord(pair) {
                                        const parts = pair.trim().split(/\s+/);
                                        // lat 4-digit -> insert decimal after 2 digits
                                        const lat = parseFloat(parts[0].slice(0,2) + '.' + parts[0].slice(2));
                                        // Longitude can be 4 digits (lon < 100) or 5 digits (lon >= 100)
                                        const lonStr = parts[1];
                                        const lonInt = lonStr.length === 5 ? lonStr.slice(0,3) : lonStr.slice(0,2);
                                        const lonDec = lonStr.length === 5 ? lonStr.slice(3) : lonStr.slice(2);
                                        const lon = -parseFloat(lonInt + '.' + lonDec);
                                        return [lat, lon];
                                    }
                                    capCoordinates = latLonPairs.map(ugcPairToCoord).filter(Boolean);
                                }
                            } catch (e) {
                                 // ignore extraction errors
                             }
                            if (latLonPairs.length > 0) {
                                minimalParts.push('LAT...LON ' + latLonPairs.join(' '));
                            } else {
                                // Fallback: try to extract from event motion or rawText if not found
                                if (info && info.parameter) {
                                    const params = Array.isArray(info.parameter) ? info.parameter : [info.parameter];
                                    const foundMotion = params.find(p => p.valueName && /event\s?motion|eventmotion|eventmotiondescription/i.test(p.valueName));
                                    if (foundMotion && typeof foundMotion.value === 'string') {
                                        const motionCoords = [];
                                        const ugcRe = /\b(\d{4})\s+(\d{4,5})\b/g;
                                        let m;
                                        while ((m = ugcRe.exec(foundMotion.value)) !== null) {
                                            motionCoords.push(`${m[1]} ${m[2]}`);
                                        }
                                        if (motionCoords.length > 0) {
                                            minimalParts.push('LAT...LON ' + motionCoords.join(' '));
                                            latLonPairs = motionCoords.slice();
                                            function ugcPairToCoord(pair) {
                                                const parts = pair.trim().split(/\s+/);
                                                const lat = parseFloat(parts[0].slice(0,2) + '.' + parts[0].slice(2));
                                                const lonStr = parts[1];
                                                const lonInt = lonStr.length === 5 ? lonStr.slice(0,3) : lonStr.slice(0,2);
                                                const lonDec = lonStr.length === 5 ? lonStr.slice(3) : lonStr.slice(2);
                                                const lon = -parseFloat(lonInt + '.' + lonDec);
                                                return [lat, lon];
                                            }
                                            capCoordinates = latLonPairs.map(ugcPairToCoord).filter(Boolean);
                                        }
                                    }
                                }
                            }
                            // Extract Event Motion Description from parameters or known fields
                            try {
                                let eventMotion = '';
                                if (info.parameter) {
                                    const params = Array.isArray(info.parameter) ? info.parameter : [info.parameter];
                                    const found = params.find(p => p.valueName && /event\s?motion|eventmotion|eventmotiondescription/i.test(p.valueName));
                                    if (found) eventMotion = (typeof found.value === 'string') ? found.value : (found.value && found.value._) || '';
                                }
                                if (!eventMotion && info.eventMotionDescription) {
                                    eventMotion = info.eventMotionDescription;
                                }

                                function getCapParam(name) {
                                    if (!info.parameter) return undefined;
                                    const params = Array.isArray(info.parameter) ? info.parameter : [info.parameter];
                                    const found = params.find(p => p.valueName && p.valueName.toUpperCase() === name.toUpperCase());
                                    return found ? found.value : undefined;
                                }

                                let waterspoutDetection = getCapParam('waterspoutDetection');
                                let waterspoutLine = '';
                                if (waterspoutDetection && String(waterspoutDetection).toLowerCase().includes('possible')) {
                                    waterspoutLine = 'WATERSPOUT...POSSIBLE';
                                }

                                let maxHailSize = getCapParam('maxHailSize');
                                let maxHailLine = '';
                                if (maxHailSize !== undefined) {
                                    let hailVal = parseFloat(maxHailSize);
                                    if (!isNaN(hailVal)) {
                                        if (hailVal === 0.75) {
                                            maxHailLine = 'MAX HAIL SIZE...<.75';
                                        } else {
                                            maxHailLine = `MAX HAIL SIZE...${hailVal.toFixed(2)}`;
                                        }
                                    }
                                }

                                let maxWindGust = getCapParam('maxWindGust');
                                let maxWindLine = '';
                                if (maxWindGust !== undefined) {
                                    let windVal = parseFloat(maxWindGust);
                                    if (!isNaN(windVal)) {
                                        maxWindLine = `MAX WIND GUST...${windVal}`;
                                    }
                                }

                                function isoToZuluHhmm(iso) {
                                    try {
                                        const d = new Date(iso);
                                        if (isNaN(d.getTime())) return null;
                                        const hh = String(d.getUTCHours()).padStart(2, '0');
                                        const mm = String(d.getUTCMinutes()).padStart(2, '0');
                                        return `${hh}${mm}Z`;
                                    } catch {
                                        return null;
                                    }
                                }

                                function extractCoords(txt) {
                                    const coords = [];
                                    const decPairRe = /(-?\d{1,2}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/g;
                                    let m;
                                    while ((m = decPairRe.exec(txt)) !== null) {
                                        coords.push(decToUgcpair(m[1], m[2]));
                                    }
                                    const ugcRe = /\b(\d{4})\s+(\d{4,5})\b/g;
                                    while ((m = ugcRe.exec(txt)) !== null) {
                                        coords.push(`${m[1]} ${m[2]}`);
                                    }
                                    return coords;
                                }

                                const txt = String(eventMotion);
                                let time = null;
                                const isoMatch = txt.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+\-]\d{2}:\d{2})?/);
                                if (isoMatch) time = isoToZuluHhmm(isoMatch[0]);
                                if (!time) {
                                    const zMatch = txt.match(/\b(\d{3,4}Z)\b/);
                                    if (zMatch) time = zMatch[1];
                                }

                                const degMatch = txt.match(/(\d{1,3})\s*DEG/i);
                                const ktMatch = txt.match(/(\d{1,3})\s*KT/i);
                                let motion = null;
                                if (degMatch || ktMatch) {
                                    motion = `${degMatch ? degMatch[1] + 'DEG' : ''}${degMatch && ktMatch ? ' ' : ''}${ktMatch ? ktMatch[1] + 'KT' : ''}`.trim();
                                }

                                const coords = extractCoords(txt);

                                // Compose cleaned TIME...MOT...LOC string
                                const parts = [];
                                if (time) parts.push(time);
                                if (motion) parts.push(motion);
                                if (coords.length) parts.push(...coords);
                                const cleaned = parts.join(' ');

                                if (coords.length && latLonPairs.length === 0) {
                                    minimalParts.push('LAT...LON ' + coords.join(' '));
                                    latLonPairs = coords.slice();
                                    function ugcPairToCoord(pair) {
                                        const parts2 = String(pair).trim().split(/\s+/);
                                        const lat = parseFloat(parts2[0].slice(0,2) + '.' + parts2[0].slice(2));
                                        const lonStr = parts2[1];
                                        const lonInt = lonStr.length === 5 ? lonStr.slice(0,3) : lonStr.slice(0,2);
                                        const lonDec = lonStr.length === 5 ? lonStr.slice(3) : lonStr.slice(2);
                                        const lon = -parseFloat(lonInt + '.' + lonDec);
                                        return [lat, lon];
                                    }
                                    capCoordinates = latLonPairs.map(ugcPairToCoord).filter(Boolean);
                                }

                                // Always include TIME...MOT...LOC if any part is present
                                if (cleaned.length || time || motion || coords.length) {
                                    minimalParts.push('TIME...MOT...LOC ' + cleaned);
                                }
                                // Insert waterspout, hail, wind lines in order if present
                                if (waterspoutLine) minimalParts.push(waterspoutLine);
                                if (maxHailLine) minimalParts.push(maxHailLine);
                                if (maxWindLine) minimalParts.push(maxWindLine);
                            } catch (e) {
                                // ignore extraction errors
                            }

                            if (minimalParts.length) {
                                // join using DOUBLE newlines so each `minimalParts` item becomes its own paragraph
                                let cleaned = minimalParts.join('\n\n') + '\n\n';
                                // Remove lines that are just urn:oid, email, ISO timestamps, or SAME/UGC codes
                                cleaned = cleaned.split(/\n+/).filter(line => {
                                    const t = line.trim();
                                    // Remove urn:oid lines
                                    if (/^urn:oid:/i.test(t)) return false;
                                    // Remove email lines
                                    if (/^[\w.-]+@[\w.-]+$/.test(t)) return false;
                                    // Remove ISO timestamps
                                    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(t)) return false;
                                    // Remove lines that are just SAME/UGC codes
                                    if (/^(SAME|UGC)$/i.test(t)) return false;
                                    // Remove lines that are just 6-digit or 7-digit numbers (SAME codes)
                                    if (/^\d{6,7}$/.test(t)) return false;
                                    // Remove lines that are just state+zone codes (e.g., KYZ058)
                                    if (/^[A-Z]{3}\d{3}$/.test(t)) return false;
                                    // Remove lines that are just XML tags
                                    if (/^<[^>]+>$/.test(t)) return false;
                                    // Remove lines that are just XML blocks
                                    if (/^<\?xml|<alert|<info|<area|<polygon|<parameter|<description|<instruction|<sender|<event|<expires|<sent|<identifier|<headline|<responseType|<severity|<certainty|<urgency|<category|<eventCode|<effective|<onset|<ends|<status|<msgType|<source|<scope|<restriction|<addresses|<code|<note|<references|<incidents|<cap|<same|<ugc|<geocode|<valueName|<value/i.test(t)) return false;
                                    // Remove technical fields and codes
                                    if (/^(AWIPSidentifier|WMOidentifier|BLOCKCHANNEL|EAS-ORG|NWEM|CMAS|WXR|EAS|SPS|NWSheadline|eventMotionDescription|maxWindGust|maxHailSize|Foothills|Including|Patchy|dense|fog|reducing|visibility|of|a|quarter|mile|or|less|will|persist|along|I-84|between|Cabbage|Hill|and|Deadman|Pass|Conditions|are|expected|to|improve|later|this|morning)$/i.test(t)) return false;
                                    // Remove lines that are just county/city lists
                                    if (/^(Bedford|Pittsylvania|Campbell|Appomattox|Buckingham|Charlotte|Athena|Pendleton|Pilot Rock)$/i.test(t)) return false;
                                    // Remove lines that are just block channel or technical keywords
                                    if (/^(BLOCKCHANNEL|EAS-ORG|NWEM|CMAS|WXR)$/i.test(t)) return false;
                                    return true;
                                }).join('\n');
                                // Strip any remaining XML tags from the message
                                cleaned = cleaned.replace(/<[^>]+>/g, '');
                                // normalize paragraphs (preserve paragraph breaks; join wrapped lines)
                                cleaned = normalizeParagraphs(cleaned);
                                // Apply full message formatting (XML removal, heading spacing, etc.) for non-VTEC cleanup
                                rawText = formatMessageNewlines(cleaned);
                                // mark that this message originated from the non‑VTEC minimal CAP cleanup
                                // so it will NOT be split into multiple message parts later.
                                capMinimalCleanup = true;
                                if (capNwsHeadline) {
                                    const re2 = new RegExp('^' + capNwsHeadline.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\s*\\n?', 'i');
                                    // keep NWSheadline in rawText for non-VTEC minimal-cleanup (do not strip)
                                }
                            }
                        }
                    } catch (e) {
                        // If parsing fails, leave rawText as-is (other logic will handle it)
                    }
                }
            }
            
            // If no VTEC and not allowed by event, skip
            if (
                (!thisObject.phenomena || !thisObject.significance) &&
                !allowByEvent
            ) {
                return;
            }

            // If no VTEC but allowed by event, set some defaults for thisObject
            if ((!thisObject.phenomena || !thisObject.significance) && allowByEvent) {
                thisObject = {
                    product: '',
                    actions: '',
                    office: '',
                    phenomena: '',
                    significance: '',
                    eventTrackingNumber: '',
                    startTime: null,
                    endTime: null
                };
            }

            if (thisObject.actions === 'CAN' || thisObject.actions === 'EXP') {
                // This is a cancellation, delete the alert from the database
                if (thisObject.actions === 'CAN') {
                    try {
                        const alerts = loadAlerts();
                        
                        // Find and remove matching alert
                        const alertIndex = alerts.findIndex(alert => 
                            alert.properties &&
                            alert.properties.vtec &&
                            alert.properties.vtec.office === thisObject.office &&
                            alert.properties.vtec.phenomena === thisObject.phenomena &&
                            alert.properties.vtec.significance === thisObject.significance &&
                            alert.properties.vtec.eventTrackingNumber === thisObject.eventTrackingNumber
                        );

                        if (alertIndex !== -1) {
                            const alertId = alerts[alertIndex].id;
                            if (deleteAlertById(alertId)) {
                                console.log('Alert cancelled and removed:', alerts[alertIndex].name);
                                log('Alert cancelled and removed: ' + alerts[alertIndex].name);
                            }
                        } else {
                            console.log('No matching alert found to cancel.');
                            log('No matching alert found to cancel.');
                        }
                    } catch (err) {
                        console.error('Error during alert cancellation:', err);
                        log('Error during alert cancellation: ' + err);
                    }
                    return;
                }
            } else if (thisObject.actions !== 'UPG' && thisObject.actions !== 'COR' && thisObject.actions !== 'CON') {
                // Not update, correction, or continuation
                console.log(`Alert action type '${thisObject.actions}' - processing as new alert`);
                // Continue to process as new alert
            } else {
                // Update, correction, or continuation
                console.log(`Alert action '${thisObject.actions}' detected - update/correction/continuation`);
                // TODO: Implement update/correction logic
                // Preserve coordinates and other data not included with update.
            }

            // Extract alert name
            var alertNameMatch = rawText.match(/<event>(.*?)<\/event>/i);
            var alertName = alertNameMatch ? alertNameMatch[1].trim() : null;

            // Fallback to BULLETIN preamble if no CAP <event> found
            if (!alertName) {
                alertNameMatch = rawText.match(/BULLETIN.*?\s+(.*?)\s+National Weather Service/i);
                alertName = alertNameMatch ? alertNameMatch[1].trim() : null;
            }

            // Final fallback
            if (!alertName) alertName = 'Unknown Alert';

            // If name is generic/unknown, try to infer a better name from the message using allowedalerts.json
            if ((!alertName || alertName === 'Unknown Alert') && Array.isArray(allowedAlerts)) {
                const txt = String(rawText || '').toUpperCase();
                const excluded = new Set(['SEVERE WEATHER STATEMENT', 'FLASH FLOOD STATEMENT']);
                const matches = allowedAlerts.filter(a => {
                    const au = String(a || '').toUpperCase();
                    return au && !excluded.has(au) && txt.includes(au);
                });
                if (matches.length) {
                    // Prefer Warning/Watch/Advisory over Statement; otherwise pick longest match
                    function rankName(n) {
                        const u = n.toUpperCase();
                        if (u.includes('WARNING')) return 1;
                        if (u.includes('WATCH')) return 2;
                        if (u.includes('ADVISORY')) return 3;
                        if (u.includes('STATEMENT')) return 4;
                        return 5;
                    }
                    matches.sort((a,b) => {
                        const ra = rankName(a), rb = rankName(b);
                        if (ra !== rb) return ra - rb;
                        return b.length - a.length;
                    });
                    alertName = matches[0];
                }
            }

            console.log(`Processing alert: ${alertName}`);

            // Extract recieved time
            var recievedTime = null;
            try {
                // Try to extract from the result object
                if (result.message.x && result.message.x[0] && result.message.x[0].$ && result.message.x[0].$.issued) {
                    recievedTime = result.message.x[0].$.issued;
                    console.log(`Received time: ${recievedTime}`);
                }
            } catch (err) {
                console.log('Could not extract received time');
            }

            // Extract coordinates using utility function
            const coordinates = extractCoordinates(rawText, capCoordinates);

            // Check if geometry is required and not available
            if (!allowNoGeometry && (!coordinates || coordinates.length === 0)) {
                // If allowNoGeometry is false and no coordinates found, skip unless this is an update/correction/continuation
                if (thisObject.actions !== 'UPG' && thisObject.actions !== 'COR' && thisObject.actions !== 'CON') {
                    console.log('Alert has no geometry and allowNoGeometry is false - skipping');
                    return;
                }
            }

            // Use the new cleanup/split function
            // For non‑VTEC CAP minimal-cleanup messages we must NOT split the text — keep a single part.
            let messageParts;
            if (capMinimalCleanup) {
                // keep the entire minimal-cleanup payload as a single message part (preserve formatting)
                messageParts = [rawText];
            } else {
                messageParts = cleanAndSplitMessage(rawText);
            }

            // --- END: Message cleanup and splitting logic ---

            // Prefer CAP identifier for non-VTEC minimal-cleanup messages when available
            var idString = (capIdentifier && capIdentifier.length) ? capIdentifier : (thisObject.product_type + thisObject.office + (Math.random() * 1000000).toFixed(0));

            // If a full VTEC is present on the main object, prefer a canonical VTEC-based id:
            // office.phenomena.significance.eventTrackingNumber (example: KSGX.HW.A.0002)
            var vtecId = (thisObject && thisObject.office && thisObject.phenomena && thisObject.significance && thisObject.eventTrackingNumber)
              ? `${thisObject.office}.${thisObject.phenomena}.${thisObject.significance}.${thisObject.eventTrackingNumber}`
              : null;

            var headline = null;
            try {
                // Helper: escape for RegExp
                function _escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
                function looksLikeHeadlineContinuation(nextLine, firstLine) {
                    if (!nextLine || !nextLine.trim()) return false;
                    const t = nextLine.trim();
                    if (t.length > 60) return false; // too long to be a continuation
                    if (/[A-Z]{2,3}\d{3}/.test(t)) return false; // looks like UGC
                    if (/\d{3,6}-/.test(t)) return false; // timestamp-like
                    if (!/^[A-Z0-9 \-\.\'\,]+$/.test(t)) return false; // expect uppercase/punctuation
                    // If first line ends with a short connector word or the second line is very short,
                    // treat as continuation (covers "THIS\n\nEVENING").
                    if (/\b(THIS|UNTIL|TONIGHT|EVENING|MORNING|AFTERNOON|TODAY)\b$/i.test(firstLine)) return true;
                    if (t.split(/\s+/).length <= 3) return true;
                    return false;
                }

                function normalizeHeadlineCandidate(s) {
                    return String(s || '')
                        .replace(/\s+/g, ' ')
                        .replace(/^BULLETIN - /i, '')
                        .replace(/^NWSheadline\s+/i, '')
                        .trim();
                }

                if (capNwsHeadline && capNwsHeadline.length) {
                    // sanitize internal newlines into spaces
                    headline = normalizeHeadlineCandidate(capNwsHeadline);
                } else {
                    const lines = rawText.split(/\r?\n/);
                    const firstLine = (lines.length ? (lines[0] || '') : '').trim();
                    let candidate = firstLine.replace(/^BULLETIN - /i, '').trim();

                    // find next non-empty line after the first
                    let nextLine = null;
                    for (let i = 1; i < lines.length; i++) {
                        if ((lines[i] || '').trim().length) { nextLine = lines[i].trim(); break; }
                    }

                    if (nextLine && looksLikeHeadlineContinuation(nextLine, candidate)) {
                        // merge into headline and remove the wrapped line from rawText so it
                        // does not appear later in the message body.
                        headline = normalizeHeadlineCandidate(candidate + ' ' + nextLine);

                        // remove the first occurrence of the wrapped nextLine that follows the firstLine
                        const pattern = new RegExp('^' + _escRe(firstLine) + '(?:\r?\n)+\s*' + _escRe(nextLine));
                        rawText = rawText.replace(pattern, firstLine);
                    } else {
                        headline = normalizeHeadlineCandidate(candidate);
                    }

                    const isJunkHeadline = !headline || /^[\d\W_]+$/.test(headline) || /^[0-9]{1,4}$/.test(headline) || /^[A-Z0-9]{1,4}$/.test(headline) || headline.length < 4;
                    if (isJunkHeadline) {
                        // Prefer explicit "IN EFFECT" phrases first (allow a one-line continuation after the IN EFFECT phrase)
                        const ieRe = /(?:^|\n)\s*\.{0,3}\s*([A-Z][^\n]{3,200}?\bIN EFFECT\b[^\n]*(?:\r?\n\s*[A-Z][^\n]{0,80})?)/i;
                        // Fallback: any line containing ADVISORY/WARNING/WATCH/EMERGENCY/STATEMENT/ALERT
                        const generalRe = /(?:^|\n)\s*\.{0,3}\s*([A-Z][^\n]{3,200}?\b(?:ADVISORY|WARNING|WATCH|EMERGENCY|STATEMENT|ALERT)\b[^\n]*)/i;
                        let m = rawText.match(ieRe) || rawText.match(generalRe);
                        if (m && m[1]) {
                            headline = normalizeHeadlineCandidate(m[1].replace(/^\.*\s*/, '').trim());
                        } else {
                            // as a last resort, pick the first long-ish uppercase-ish line
                            const lineRe = /(?:^|\n)\s*([A-Z][A-Z0-9 \-]{3,120}[A-Z0-9])/;
                            const mm = rawText.match(lineRe);
                            if (mm && mm[1]) headline = normalizeHeadlineCandidate(mm[1].trim());
                        }
                    }
                }
            } catch {}

            // Build parsedAlert objects for each message part
            // Build parsedAlerts asynchronously so we can fetch zone/county names
            let parsedAlerts = [];
            for (let idx = 0; idx < messageParts.length; idx++) {
                const msgPart = messageParts[idx];

                const isPartRawXMLOnly = (
                    msgPart.trim().startsWith('<?xml') &&
                    msgPart.trim().endsWith('</alert>')
                );
                if (isPartRawXMLOnly) continue;

                // Extract VTEC from each message part using utility
                let vtecObj = parseVTECFromPart(msgPart);

                if (!vtecObj) {
                    // fallback: if the main `thisObject` contains a genuine VTEC (has phenomena+significance), use it
                    if (thisObject && thisObject.phenomena && thisObject.significance) {
                        vtecObj = thisObject;
                    } else {
                        // non-VTEC: construct a minimal vtec object only if we have values to add
                        const minimal = {};
                        const etn = (thisObject && thisObject.eventTrackingNumber) || capIdentifier || null;
                        const st = (thisObject && thisObject.startTime) || capSent || null;
                        const en = (thisObject && thisObject.endTime) || capExpires || null;
                        if (etn) minimal.eventTrackingNumber = etn;
                        if (st) minimal.startTime = st;
                        if (en) minimal.endTime = en;
                        vtecObj = Object.keys(minimal).length ? minimal : null;
                    }
                }

                // Build properties dynamically to avoid emitting empty keys for non‑VTEC cleanup
                const props = { recievedTime: recievedTime };

                // Prefer eventTrackingNumber from vtecObj, then thisObject, then CAP identifier
                const _etn = (vtecObj && vtecObj.eventTrackingNumber) || (thisObject && thisObject.eventTrackingNumber) || capIdentifier || null;
                if (_etn) props.event_tracking_number = _etn;

                // Only attach `vtec` when there are meaningful fields present (prevents empty office/phenomena/significance)
                if (vtecObj && Object.keys(vtecObj).length) props.vtec = vtecObj;

                // Add product_type / phenomena / significance only when we have them
                const phen = (vtecObj && vtecObj.phenomena) || (thisObject && thisObject.phenomena) || null;
                const sig = (vtecObj && vtecObj.significance) || (thisObject && thisObject.significance) || null;
                if (phen && sig) {
                    props.product_type = phen + sig;
                    props.phenomena = phen;
                    props.significance = sig;
                }

                // Pit refer per-part VTEC for id when present, otherwise prefer main VTEC (`vtecId`), then fall back to idString
                const baseId = (vtecObj && vtecObj.office && vtecObj.phenomena && vtecObj.significance && vtecObj.eventTrackingNumber)
                    ? `${vtecObj.office}.${vtecObj.phenomena}.${vtecObj.significance}.${vtecObj.eventTrackingNumber}`
                    : (vtecId || idString);

                // Format message with proper newline spacing (hoisted to file scope)

                const formattedMessage = formatMessageNewlines(msgPart);
                const issuedTime = (vtecObj && vtecObj.startTime) ? vtecObj.startTime : (thisObject && thisObject.startTime) || new Date().toISOString();

                let alertObj = {
                    name: alertName,
                    id: (messageParts.length === 1) ? baseId : (baseId + '_' + idx),
                    sender: (vtecObj && vtecObj.office) ? vtecObj.office : (thisObject && thisObject.office) || '',
                    headline: headline,
                    issued: issuedTime,
                    expiry: (vtecObj && vtecObj.endTime) ? vtecObj.endTime : ((thisObject && thisObject.endTime) ? thisObject.endTime : (capExpires || null)),
                    message: formattedMessage,
                    areaDesc: '',
                    properties: props
                };

                // Attach geometry if available using utility function
                if (coordinates && coordinates.length > 0) {
                    const geometry = createPolygonGeometry(coordinates);
                    if (geometry) {
                        alertObj.geometry = [geometry.coordinates];
                    }
                }

                // If there is no meaningful headline, remove the `headline` property entirely
                try {
                    const h = (alertObj.headline || '').toString();
                    const isJunkHeadline = !h.trim() || /^[\d\W_]+$/.test(h) || /^[0-9]{1,4}$/.test(h) || /^[A-Z0-9]{1,4}$/.test(h) || h.trim().length < 4;
                    if (isJunkHeadline) delete alertObj.headline;
                } catch (e) { /* ignore */ }

                // --- Extract canonical UGC group from this message part (with fallbacks) and resolve friendly names ---
                (function(){})();
                const ugcPattern = /([A-Z]{2,3}[0-9]{3}(?:[>-][0-9]{3,6})*-)/g;
                let canonicalUgc = null;

                // 1) try to find a canonical UGC group in this message part
                const m1 = msgPart.match(ugcPattern);
                if (m1 && m1.length) canonicalUgc = m1[0];

                // 2) fallback: search the entire original rawText (useful when UGC is in preamble/CAP but not in this part)
                if (!canonicalUgc) {
                    const m2 = rawText.match(ugcPattern);
                    if (m2 && m2.length) canonicalUgc = m2[0];
                }

                // 3) final fallback: try to assemble a single-zone UGC from any prefix+3-digit token found in this part
                if (!canonicalUgc) {
                    const pairRe = /([A-Z]{2,3})(\d{3})/g;
                    const pairs = [];
                    let mm;
                    while ((mm = pairRe.exec(msgPart)) !== null) pairs.push(mm[1] + mm[2]);
                    if (pairs.length) canonicalUgc = pairs[0] + '-';
                }

                if (canonicalUgc) {
                    const ugcIds = expandUgcGroup(canonicalUgc);

                    if (ugcIds.length) {
                        // fetch all display names in parallel (cached)
                        const results = await Promise.all(ugcIds.map(id => lookupZoneDisplay(id)));
                        const names = results.filter(Boolean);
                        if (names.length) {
                            // Join multiple names with semicolon as requested
                            alertObj.areaDesc = names.join('; ');
                        }
                    }

                    // Convert UGC -> county FIPS and attach geometry polygons
                    const fipsIds = ugcIds.map(ugcToFips).filter(Boolean);
                    if (fipsIds.length) {
                        alertObj.fips = fipsIds;
                        // Only add FIPS-based geometry if we don't already have coordinate-based geometry
                        if (!alertObj.geometry) {
                            const geometry = [];
                            for (const fipsId of fipsIds) {
                                const entry = fipsGeometry[fipsId];
                                if (entry && Array.isArray(entry.geometry)) {
                                    geometry.push(...entry.geometry);
                                }
                            }
                            if (geometry.length) alertObj.geometry = geometry;
                        }
                    }
                }

                // Fallback: if lookup produced no areaDesc, try to extract an areaDesc string
                // inserted earlier (CAP areaDesc or minimalParts). Prefer multi-line hyphen-terminated
                // fragments, then per-line hyphen-terminated candidates. Skip UGC-like lines.
                if (!alertObj.areaDesc) {
                    // try multi-line fragment first
                    const multi = msgPart.match(/([A-Za-z][\s\S]{10,}?-)/);
                    if (multi && !/[A-Z]{2,3}\d{3}/.test(multi[1])) {
                        let cleaned = multi[1].replace(/[;,]/g, '-').replace(/\s*\n\s*/g, '-').replace(/\s+/g, ' ').trim();
                        cleaned = cleaned.replace(/-+/g, '-').replace(/^[-\s]+|[-\s]+$/g, '');
                        if (cleaned.length) alertObj.areaDesc = cleaned + '-';
                    }
                }

                if (!alertObj.areaDesc) {
                    const lines = msgPart.split('\n').map(l => l.trim()).filter(Boolean);
                    for (const line of lines) {
                        if (/[A-Z]{2,3}\d{3}/.test(line)) continue; // skip UGC lines
                        if (line.endsWith('-') || /\b(Coastal|County|Waters|Parish|City|Lake|River|Coastal Waters)\b/i.test(line)) {
                            let cleaned = line.replace(/[;,]/g, '-').replace(/\s*\n\s*/g, '-').replace(/\s+/g, ' ').trim();
                            cleaned = cleaned.replace(/-+/g, '-').replace(/^[-\s]+|[-\s]+$/g, '');
                            if (cleaned.length) { alertObj.areaDesc = cleaned + (cleaned.endsWith('-') ? '' : '-'); break; }
                        }
                    }
                }

                (function() {
                    const msgSource = (msgPart || alertObj.message || rawText || '');
                    // Example: "TIME...MOT...LOC 1349Z 246DEG 25KT 3458 9702"
                    const motRe = /TIME\.{0,3}MOT\.{0,3}LOC\s+([0-9]{3,4}Z)?\s*(\d{1,3})\s*DEG\s*(\d{1,3})\s*KT\s*((?:\d{4,5}(?:\s+\d{4,5})*))/i;
                    const m = msgSource.match(motRe);
                    if (m) {
                        const raw = m[0].trim();
                        const timeZ = m[1] || null;
                        const deg = m[2] ? parseInt(m[2], 10) : null;
                        const kt = m[3] ? parseInt(m[3], 10) : null;
                        const coordTokens = m[4] ? m[4].trim().split(/\s+/) : [];

                        let lat = null, lon = null;
                        if (coordTokens.length >= 2) {
                            const tLat = coordTokens[0];
                            const tLon = coordTokens[1];
                            function tokenToNum(tok) {
                                if (!/^\d+$/.test(tok)) return NaN;
                                const len = tok.length;
                                const intPart = tok.slice(0, len - 2);
                                const decPart = tok.slice(len - 2);
                                return Number(intPart + '.' + decPart);
                            }
                            const latNum = tokenToNum(tLat);
                            const lonNum = tokenToNum(tLon);
                            if (!isNaN(latNum)) lat = latNum;
                            if (!isNaN(lonNum)) lon = -Math.abs(lonNum);
                        }

                        // Build ISO time using alert issued date (UTC) + parsed HHMMZ
                        let isoTime = null;
                        if (timeZ) {
                            const issuedDate = alertObj.issued ? new Date(alertObj.issued) : new Date();
                            if (!isNaN(issuedDate.getTime())) {
                                const hhmm = timeZ.replace(/Z$/i, '');
                                const hh = parseInt(hhmm.slice(0, hhmm.length - 2), 10);
                                const mm = parseInt(hhmm.slice(-2), 10);
                                let isoDate = new Date(Date.UTC(issuedDate.getUTCFullYear(), issuedDate.getUTCMonth(), issuedDate.getUTCDate(), hh, mm));
                                const diff = Math.abs(isoDate.getTime() - issuedDate.getTime());
                                if (diff > 12 * 60 * 60 * 1000) {
                                    const prev = new Date(isoDate.getTime() - 24 * 60 * 60 * 1000);
                                    const next = new Date(isoDate.getTime() + 24 * 60 * 60 * 1000);
                                    if (Math.abs(prev.getTime() - issuedDate.getTime()) < diff) isoDate = prev;
                                    else if (Math.abs(next.getTime() - issuedDate.getTime()) < diff) isoDate = next;
                                }
                                isoTime = isoDate.toISOString();
                            }
                        }

                        // friendly type detection
                        let type = 'storm';
                        const head = (alertObj.headline || '').toUpperCase();
                        const phen = (alertObj.properties && alertObj.properties.vtec && alertObj.properties.vtec.phenomena) || '';
                        if (/TORNADO|TO\./i.test(head) || /TO\./i.test(phen)) type = 'tornado';
                        else if (/FLASH FLOOD|FLOOD|FF\./i.test(head) || /FF\./i.test(phen)) type = 'flood';

                        const emd = {
                            raw: raw,
                            time: isoTime,
                            type: type,
                            heading: (deg !== null) ? `${deg}DEG` : null,
                            speed: (kt !== null) ? `${kt}KT` : null,
                            lat: (typeof lat === 'number' && !isNaN(lat)) ? Number(lat.toFixed(2)) : null,
                            lon: (typeof lon === 'number' && !isNaN(lon)) ? Number(lon.toFixed(2)) : null,
                            coord: (typeof lat === 'number' && !isNaN(lat) && typeof lon === 'number' && !isNaN(lon)) ? `${lat.toFixed(2)},${lon.toFixed(2)}` : null
                        };

                        // keep only the top-level `eventMotionDescription` (it will be moved under `coordinates` when present)
                        alertObj.eventMotionDescription = emd;

                        // If no geometry was already attached from LAT...LON or CAP polygon,
                        // create a point geometry from the eventMotionDescription lat/lon
                        if (typeof emd.lat === 'number' && !isNaN(emd.lat) && typeof emd.lon === 'number' && !isNaN(emd.lon) &&
                            !alertObj.geometry) {
                            alertObj.geometry = [[[[emd.lon, emd.lat]]]];
                        }
                    }
                })();

                (function() {
                    const src = (msgPart || alertObj.message || '');
                    const emRe = /\b(TORNADO EMERGENCY FOR|FLASH FLOOD EMERGENCY FOR)\s+([A-Z0-9\-,\.\s]+)/i;
                    const emMatch = src.match(emRe);
                    if (emMatch) {
                        const extracted = emMatch[0].replace(/\s+/g, ' ').trim();
                        // always set the headline, but do NOT inject it into the message body
                        alertObj.headline = extracted;
                        return;
                    }

                    const rieRe = /([A-Z][A-Z\s]+REMAINS IN EFFECT\s+(?:UNTIL|FROM)[^\.\n]*)/i;
                    const inEffectRe = /([A-Z][A-Z\s]+IN EFFECT\s+(?:UNTIL|THROUGH|TO|FROM)[^\.\n]*(?:\r?\n\s*[A-Z0-9 \-]{1,80})?)/i;
                    const rieMatch = src.match(rieRe) || src.match(inEffectRe);
                    if (rieMatch) {
                        const extracted = (rieMatch[1] || '').replace(/\s+/g, ' ').trim();
                        if (!/EMERGENCY/i.test(extracted)) {
                            alertObj.headline = extracted;
                        }
                    }
                })();
                
                if (Object.prototype.hasOwnProperty.call(alertObj, 'eventMotionDescription') && alertObj.geometry) {
                    const ordered = {};
                    for (const k of Object.keys(alertObj)) {
                        if (k === 'geometry') {
                            ordered['geometry'] = alertObj['geometry'];
                            ordered['eventMotionDescription'] = alertObj['eventMotionDescription'];
                        } else if (k !== 'eventMotionDescription') {
                            ordered[k] = alertObj[k];
                        }
                    }
                    alertObj = ordered;
                }

                (function() {
                    const srcText = (msgPart || alertObj.message || '');
                    const lines = String(srcText).split(/\r?\n/);
                    const secs = {}; // map of SECTION_NAME -> text
                    let cur = null;

                    // Collect sections that use the `HEADING...content` style (e.g. "WHAT...", "TORNADO...", "MAX HAIL SIZE...")
                    for (let rawLine of lines) {
                        // strip common bullet markers and surrounding whitespace (e.g. "* WHAT...", "- WHAT...", •)
                        const line = rawLine.trim();
                        if (!line) continue;
                        const stripped = line.replace(/^[\s\*\-\u2022\u25BA\u25CF]+/, '').trim();
                        // match headings that use two-or-more dots after a word (robust to 2 or more dots)
                        const h = stripped.match(/^([A-Z0-9][A-Z0-9 \-\/&']{0,60}?)\.{2,}\s*(.*)$/i);
                        if (h) {
                            cur = h[1].toUpperCase();
                            secs[cur] = (h[2] || '').trim();
                        } else if (cur) {
                            // continuation line for current section (use stripped line so leading bullets don't pollute content)
                            secs[cur] = ((secs[cur] || '') + ' ' + stripped).trim();
                        }
                    }

                    // helpers to format values
                    function fmtHail(s) {
                        if (!s) return '';
                        // capture an optional comparator and numeric portion
                        const m = String(s).match(/([<>~]?)\s*([0-9]*\.?[0-9]+)/);
                        if (!m) return String(s).trim();
                        const cmp = (m[1] || '');
                        let num = m[2];
                        if (/^0\./.test(num)) num = num.replace(/^0/, ''); // ".75" instead of "0.75"
                        // always treat hail sizes as inches when numeric only
                        const unit = /IN\b/i.test(s) ? 'IN' : 'IN';
                        return (cmp + num + ' ' + unit).trim();
                    }
                    function fmtWind(s) {
                        if (!s) return '';
                        const m = String(s).match(/([0-9]{1,3})(?:\s*(MPH|KT|KTS))?/i);
                        if (!m) return String(s).trim();
                        const unit = (m[2] || 'MPH').toUpperCase().replace('KTS', 'KT');
                        return `${m[1]} ${unit}`;
                    }

                    const ai = {};

                    // Primary narrative sections — only add if present as explicit headings in the message
                    if (secs['WHAT']) ai.WHAT = secs['WHAT'];
                    if (secs['WHEN']) ai.WHEN = secs['WHEN'];
                    if (secs['WHERE']) ai.WHERE = secs['WHERE'];
                    if (secs['IMPACTS']) ai.IMPACTS = secs['IMPACTS'];

                    // metadata-like sections (preserve exact-match behavior; do NOT conflate IMPACT and IMPACTS)
                    if (secs['HAZARD']) ai.HAZARD = secs['HAZARD'];
                    if (secs['SOURCE']) ai.SOURCE = secs['SOURCE'];
                    if (secs['IMPACT']) ai.IMPACT = secs['IMPACT'];

                    // damage / threat-specific values (set from headings when present)
                    if (secs['TORNADO']) ai.TORNADO = secs['TORNADO'];
                    if (secs['TORNADO DAMAGE THREAT']) ai.TORNADO_DAMAGE_THREAT = secs['TORNADO DAMAGE THREAT'];
                    if (secs['THUNDERSTORM DAMAGE THREAT']) ai.THUNDERSTORM_DAMAGE_THREAT = secs['THUNDERSTORM DAMAGE THREAT'];
                    if (secs['FLASH FLOOD DAMAGE THREAT']) ai.FLASH_FLOOD_DAMAGE_THREAT = secs['FLASH FLOOD DAMAGE THREAT'];
                    if (secs['SNOW SQUALL']) ai.SNOW_SQUALL = secs['SNOW SQUALL'];
                    if (secs['SNOW SQUALL IMPACT']) ai.SNOW_SQUALL_IMPACT = secs['SNOW SQUALL IMPACT'];
                    if (secs['WIND']) ai.WIND = secs['WIND'];
                    if (secs['HAIL']) ai.HAIL = secs['HAIL'];
                    if (secs['WATERSPOUT']) ai.WATERSPOUT = secs['WATERSPOUT'];

                    // new threat fields requested by user
                    if (secs['HAIL THREAT']) ai.HAIL_THREAT = secs['HAIL THREAT'];
                    if (secs['WIND THREAT']) ai.WIND_THREAT = secs['WIND THREAT'];
                    if (secs['FLASH FLOOD']) ai.FLASH_FLOOD = secs['FLASH FLOOD'];

                    // new fields requested by user
                    if (secs['WINDS']) ai.WINDS = secs['WINDS'];
                    if (secs['RELATIVE HUMIDITY']) ai.RELATIVE_HUMIDITY = secs['RELATIVE HUMIDITY'];
                    if (secs['TEMPERATURES']) ai.TEMPERATURES = secs['TEMPERATURES'];
                    if (secs['IMPACTS']) ai.IMPACTS = secs['IMPACTS'];
                    if (secs['SEVERITY']) ai.SEVERITY = secs['SEVERITY'];

                    // promote damage-threat -> short-form keys when only the damage-form is present
                    if (!ai.HAIL_THREAT && ai.HAIL_DAMAGE_THREAT) ai.HAIL_THREAT = ai.HAIL_DAMAGE_THREAT;
                    if (!ai.WIND_THREAT && ai.WIND_DAMAGE_THREAT) ai.WIND_THREAT = ai.WIND_DAMAGE_THREAT;

                    // numeric measurements (accept values from section headings)
                    if (secs['MAX HAIL SIZE'] || secs['MAX HAIL']) ai.MAX_HAIL_SIZE = fmtHail(secs['MAX HAIL SIZE'] || secs['MAX HAIL']);
                    if (secs['MAX WIND GUST'] || secs['MAX WIND']) ai.MAX_WIND_GUST = fmtWind(secs['MAX WIND GUST'] || secs['MAX WIND']);

                    // Fallback: search the entire message for certain values only if they were not set by headings
                    const full = String(srcText || '').replace(/\u00A0/g, ' ');
                    function fallbackSet(key, re, formatter) {
                        if (Object.prototype.hasOwnProperty.call(ai, key) && ai[key]) return;
                        const m = full.match(re);
                        if (m && m[1]) ai[key] = formatter ? formatter(m[1]) : String(m[1]).trim();
                    }

                    // MAX HAIL / MAX WIND fallbacks (catch same-line pairs like "MAX HAIL SIZE...0.25 MAX WIND GUST...40")
                    fallbackSet('MAX_HAIL_SIZE', /MAX\s*HAIL(?:\s*SIZE)?\.{2,}\s*([<>~]?\s*[0-9]*\.?[0-9]+)/i, fmtHail);
                    fallbackSet('MAX_WIND_GUST', /MAX\s*WIND(?:\s*GUST)?\.{2,}\s*([0-9]{1,3})/i, fmtWind);

                    // Threat fallbacks: HAIL / WIND / FLASH FLOOD (accept both "THREAT" and "DAMAGE THREAT")
                    const hailThreatRe = /HAIL(?:\s+(?:DAMAGE\s+)?THREAT(?:\(S\))?)?\.{2,}\s*([A-Z][A-Z\s\-]+)/i;
                    const windThreatRe = /WIND(?:\s+(?:DAMAGE\s+)?THREAT(?:\(S\))?)?\.{2,}\s*([A-Z][A-Z\s\-]+)/i;
                    const flashThreatRe = /FLASH\s*FLOOD(?:\s+(?:DAMAGE\s+)?THREAT(?:\(S\))?)?\.{2,}\s*([A-Z][A-Z\s\-]+)/i;

                    fallbackSet('HAIL_THREAT', hailThreatRe, s => s.trim());
                    fallbackSet('HAIL_DAMAGE_THREAT', hailThreatRe, s => s.trim());
                    fallbackSet('WIND_THREAT', windThreatRe, s => s.trim());
                    fallbackSet('WIND_DAMAGE_THREAT', windThreatRe, s => s.trim());
                    fallbackSet('FLASH_FLOOD_DAMAGE_THREAT', flashThreatRe, s => s.trim());

                    // Also populate short-form FLASH_FLOOD if present as a heading or sentence
                    if (!ai.FLASH_FLOOD) {
                        const mff = full.match(/(^|\n)FLASH\s*FLOOD(?:\s*[:\.]|\s|\.|\n)\s*([^\n]+)/i);
                        if (mff && mff[2]) ai.FLASH_FLOOD = mff[2].trim();
                    }

                    // attach under the exact name the request used (only keys with values are present)
                    // --- Simplify and canonicalize threat fields (user request):
                    // convert long/freeform values into short canonical phrases (e.g. "RADAR INDICATED", "POSSIBLE", "CONSIDERABLE")
                    function simplifyThreatValue(v) {
                        if (!v) return v;
                        let s = String(v).trim();
                        if (!s) return s;
                        const up = s.toUpperCase();

                        // First, try to extract just the core threat indicator by stopping at "MAX" or other breaking points
                        const truncated = up.replace(/\s+(MAX|SIZE|HAIL|WIND|GUST|SPEED|DAMAGE|IMPACT|DEPTH|ACCUMULATION|RATE).*$/i, '').trim();
                        const core = truncated || up;

                        // Prefer to detect RADAR-based indicators
                        if (core.includes('RADAR INDICATED')) return 'RADAR INDICATED';
                        if (core.includes('RADAR ESTIMAT') || core.includes('RADAR-ESTIMAT')) return 'RADAR ESTIMATED';

                        // Common short keywords we want to preserve
                        if (/\bPOSSIBLE\b/.test(core)) return 'POSSIBLE';
                        if (/\bCONSIDERABLE\b/.test(core)) return 'CONSIDERABLE';
                        if (/\bNONE\b/.test(core)) return 'NONE';
                        if (/\bLIKELY\b/.test(core)) return 'LIKELY';
                        if (/\bCONFIRMED\b/.test(core)) return 'CONFIRMED';

                        // If the core string is already short (<= 30 chars) keep it as-is (cleaned)
                        if (core.length <= 30) return core;

                        // Otherwise return the first few words up to punctuation/newline/break
                        const m = core.match(/^([^\n\.,;:\$]{1,60})/);
                        return (m && m[1]) ? m[1].trim() : up.trim();
                    }

                    const _threatKeys = ['HAIL_THREAT','HAIL_DAMAGE_THREAT','WIND_THREAT','WIND_DAMAGE_THREAT','TORNADO_DAMAGE_THREAT','FLASH_FLOOD_DAMAGE_THREAT','THUNDERSTORM_DAMAGE_THREAT','FLASH_FLOOD','TORNADO', 'WATERSPOUT'];
                    for (const tk of _threatKeys) {
                        if (Object.prototype.hasOwnProperty.call(ai, tk) && ai[tk]) ai[tk] = simplifyThreatValue(ai[tk]);
                    }

                    alertObj.alertInfo = ai;
                })();

                parsedAlerts.push(alertObj);
            }

            // Remove any null/undefined entries (in case)
            parsedAlerts = parsedAlerts.filter(Boolean);

            try {
                upsertAlerts(parsedAlerts);
            } catch (err) {
                console.error('Error updating alerts.json:', err);
                log('Error updating alerts.json:', err);
            }
        });

    });

    // Event listener for errors
    xmpp.on('error', (err) => {
        console.error('XMPP error:', err);
        log('XMPP error: ' + err.toString());
        
        // Handle DNS/network errors with reconnection
        if (err.errno === -3001 || err.code === 'EAI_AGAIN' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
            console.log('Network error detected, attempting reconnection...');
            log('Network error detected: ' + err.code + ' - Initiating reconnection.');
            handleReconnect();
            return;
        }
        
        // Clean up interval on error
        if (deleteExpiredAlertsInterval) {
            clearInterval(deleteExpiredAlertsInterval);
            deleteExpiredAlertsInterval = null;
        }
    });

    // Clean up interval when offline
    xmpp.on('offline', () => {
        log("Connection offline")
        console.log('XMPP connection offline');
        if (deleteExpiredAlertsInterval) {
            clearInterval(deleteExpiredAlertsInterval);
            deleteExpiredAlertsInterval = null;
        }
    });

    // Start the connection
    try {
        await xmpp.start();
    } catch (err) {
        // Handle authentication errors
        if (err.toString().includes('not-authorized')) {
            console.error('XMPP Authentication failed: Check your username and password in the .env file.');
            log('XMPP Authentication failed: Check your username and password.');
            process.exit(1);
        }
        
        // Handle DNS/network errors with reconnection
        if (err.errno === -3001 || err.code === 'EAI_AGAIN' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
            console.error('Network/DNS error connecting to XMPP server:', err.message);
            log('Network/DNS error: ' + err.message + ' - Will retry connection.');
            handleReconnect();
            return;
        }
        
        console.error('\nFailed to start XMPP client:', err);
        log('Failed to start XMPP client: ' + err);
        process.exit(1);
    }

})().catch(err => {
    console.error('\nAn error occurred:', err);
    log('An error occurred: ' + err);
    console.log('Restarting in 5 seconds...');
    setTimeout(() => { }, 5000);
});

// Exports
module.exports = {
    start: async () => { 
        console.log('NWWS-OI module start() called');
    },
    auth: (a, b, c, d, e) => {
        username = a;
        password = b; 
        resource = c || 'SparkAlerts NWWS Ingest Client';
        MAX_RECONNECT_ATTEMPTS = d || 10;
        INITIAL_RECONNECT_DELAY = e || 2000;
        console.log(`NWWS-OI configured: User=${username}, Resource=${resource}, MaxRetries=${MAX_RECONNECT_ATTEMPTS}`);
    }
};
