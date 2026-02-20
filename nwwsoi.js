/*
(c) 2024 Tyler Granzow - Apache License 2.0

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

// For storing crexentials
var username = null;
var password = null;
var resource = null;
var MAX_RECONNECT_ATTEMPTS = 10;
var INITIAL_RECONNECT_DELAY = 2000;

// Startup alert filtering: remove alerts with same eventTrackingNumber if issued before another's startTime

function filterAlertsOnStartup() {
    try {
        let alerts = [];
        try {
            const raw = fs.readFileSync('alerts.json', 'utf8');
            alerts = raw.trim() ? JSON.parse(raw) : [];
            if (!Array.isArray(alerts)) alerts = [];
        } catch (readErr) {
            if (readErr.code !== 'ENOENT') {
                console.warn('alerts.json unreadable during startup filter:', readErr.message);
            }
            return;
        }
        const etnMap = {};
        const idMap = {};
        alerts.forEach(alert => {
            const id = alert.id;
            if (!id) return;
            const issued = new Date(alert.issued || alert.properties?.recievedTime || 0).getTime();
            if (!idMap[id] || issued > idMap[id].issued) {
                idMap[id] = { alert, issued };
            }
        });
        // Add alerts without id
        const filteredAlerts = alerts.filter(alert => !alert.id);
        // Add only the latest alert for each id
        filteredAlerts.push(...Object.values(idMap).map(obj => obj.alert));
        fs.writeFileSync('alerts.json', JSON.stringify(filteredAlerts, null, 2));
        console.log('Startup alert filter applied.');
    } catch (err) {
        console.error('Error during startup alert filter:', err);
    }
}

filterAlertsOnStartup();

(async () => {
    // Polyfill WebSocket for @xmpp/client
    const { client, xml } = await import('@xmpp/client');
    const wsModule = await import('ws');
    global.WebSocket = wsModule.default || wsModule.WebSocket || wsModule;

    // Variable to store the interval ID so we can stop it if needed
    let deleteExpiredAlertsInterval = null;

    // Task to clean up the alerts.json file
    async function deleteExpiredAlerts() {
        console.log('Running expired alerts cleanup...');
        try {
            let alerts = [];

            try {
                const raw = fs.readFileSync('alerts.json', 'utf8');
                alerts = raw.trim() ? JSON.parse(raw) : [];
                if (!Array.isArray(alerts)) alerts = [];
            } catch (readErr) {
                if (readErr.code !== 'ENOENT') {
                    console.warn('alerts.json unreadable during cleanup:', readErr.message);
                    log('alerts.json unreadable during cleanup: ' + readErr.message);
                }
                return; // Nothing to clean
            }

            // Remove alerts whose endTime (expiry) is in the past
            const now = new Date();
            const initialCount = alerts.length;
            alerts = alerts.filter(alert => {
                let endTime = null;
                if (alert.expiry) {
                    endTime = new Date(alert.expiry);
                } else if (alert.properties && alert.properties.vtec && alert.properties.vtec.endTime) {
                    endTime = new Date(alert.properties.vtec.endTime);
                }
                if (!endTime || isNaN(endTime.getTime())) return true; // Keep if no valid endTime
                return now <= endTime; // Keep only non-expired alerts
            });

            const removedCount = initialCount - alerts.length;

            // Write back only if something was removed
            if (removedCount > 0) {
                fs.writeFileSync('alerts.json', JSON.stringify(alerts, null, 2));
                console.log(`Expired alerts cleanup: removed ${removedCount} alert(s).`);
                log(`Expired alerts cleanup: removed ${removedCount} alert(s).`);
            } else {
                console.log('Expired alerts cleanup: no expired alerts found.');
            }
        } catch (err) {
            log('Error in database cleanup: ' + err);
            console.error('Error in database cleanup:', err);
        }
    }

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

    // Load allowed alerts at startup
const allowedAlertsPath = path.join(__dirname, 'allowedalerts.json');
let allowedAlerts = [];
try {
    allowedAlerts = JSON.parse(fs.readFileSync(allowedAlertsPath, 'utf8'));
} catch (e) {
    console.error('Could not load allowedalerts.json:', e);
    allowedAlerts = [];
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
            // - capSent / capExpires: ISO timestamps from <sent> / <expires>
            // - capIdentifier: alert <identifier> (used as fallback id / eventTrackingNumber)
            // - capNwsHeadline: parameter NWSheadline (preferred headline for non-VTEC cleanup)
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

            // Helper: parse a human-readable timestamp from the message text and return an ISO UTC string.
            // Matches examples like "1037 PM PST Fri Feb 13 2026" or "9:28 PM MST Fri Feb 13 2026".
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


            // ===================== FULL MESSAGE FORMAT DETECTION ===========================
            // If the message contains any of the keywords, skip CAP XML cleanup.
            // Keywords: URGENT, STATEMENT, MESSAGE, REQUEST, BULLETIN (case-insensitive)
            const fullMsgKeywords = /\b(URGENT|STATEMENT|MESSAGE|REQUEST|BULLETIN)\b/i;
            const isFullMessage = fullMsgKeywords.test(rawText);

            let cleanedCAPXML = false;
            // set when we perform the non‑VTEC "minimal cleanup" from a CAP payload —
            // used to prevent splitting and other full-message behaviors
            let capMinimalCleanup = false;
            if (!isFullMessage) {
                // ===================== CAP XML CLEANUP ===========================
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

                        // Helper to get geocode by valueName
                        function getGeocode(name) {
                            if (!info.area || !info.area.geocode) return '';
                            const geos = Array.isArray(info.area.geocode) ? info.area.geocode : [info.area.geocode];
                            const found = geos.find(g => g.valueName && g.valueName.toUpperCase() === name.toUpperCase());
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

                        // Replace areaDesc and UGC with provided values
                        const areaDesc = `Lake Pontchartrain and Lake Maurepas-Mississippi Sound-
Lake Borgne-Chandeleur Sound-Breton Sound-
Coastal Waters from Port Fourchon LA to Lower Atchafalaya River
LA out 20 nm-
Coastal waters from the Southwest Pass of the Mississippi River
to Port Fourchon Louisiana out 20 NM-
Coastal Waters from Boothville LA to Southwest Pass of the
Mississippi River out 20 nm-
Coastal waters from Pascagoula Mississippi to Stake Island out
20 NM-
Coastal waters from Port Fourchon Louisiana to Lower Atchafalaya
River LA from 20 to 60 NM-
Coastal waters from Southwest Pass of the Mississippi River to
Port Fourchon Louisiana from 20 to 60 NM-
Coastal Waters from Stake Island LA to Southwest Pass of the
Mississippi River from 20 to 60 nm-
Coastal waters from Pascagoula Mississippi to Stake Island
Louisiana out 20 to 60 NM-`;

                        const ugc = `GMZ530-532-534-536-538-550-552-555-557-570-572-575-577-010945-`;

                        // Clean senderName
                        let sender = info.senderName || '';
                        sender = sender.replace(/^NWS\s*/i, 'National Weather Service ');

                        // Compose output in requested order
                        let cleanedMsg = '';
                        cleanedMsg += sender ? sender + '\n' : '';
                        cleanedMsg += ugc ? ugc + '\n' : '';
                        cleanedMsg += getParam('VTEC') ? getParam('VTEC') + '\n' : '';
                        cleanedMsg += areaDesc ? areaDesc + '\n' : '';
                        cleanedMsg += alert.sent ? formatSentTime(alert.sent) + '\n' : '';
                        // prefer to preserve NWSheadline in `headline` (do NOT duplicate into the message)
                        const _nwsHeadline = getParam('NWSheadline') || '';
                        if (_nwsHeadline) capNwsHeadline = _nwsHeadline;
                        cleanedMsg += info.description ? info.description + '\n' : '';
                        cleanedMsg += info.instruction ? info.instruction + '\n' : '';

                        // --- Try to preserve LAT...LON / coordinates from CAP for non-VTEC minimal cleanup ---
                        try {
                            function decToUgcpair(lat, lon) {
                                const la = Math.round(Math.abs(Number(lat)) * 100);
                                const lo = Math.round(Math.abs(Number(lon)) * 100);
                                return `${String(la).padStart(4, '0')} ${String(lo).padStart(4, '0')}`;
                            }
                            function ugcPairToCoord(pair) {
                                const parts = pair.trim().split(/\s+/);
                                const lat = parseFloat(parts[0].slice(0,2) + '.' + parts[0].slice(2));
                                const lon = -parseFloat(parts[1].slice(0,2) + '.' + parts[1].slice(2));
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

                            earlyPairs = Array.from(new Set(earlyPairs)).filter(g => /^\d{4}\s+\d{4}$/.test(g));
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
                // ===================== END CAP XML CLEANUP ===========================
            }

            // ================================================================================
            // VTEC parser
            // https://www.weather.gov/bmx/vtec

            let thisObject = {};
            let vtec = null;
            let vtecObjects = [];
            try {
                vtec = rawText.match(/\/O\..*?\/\n?/);
                if (!vtec) {
                    vtec = rawText.match(/<parameter>\s*<valueName>VTEC<\/valueName>\s*<value>(.*?)<\/value>\s*<\/parameter>/);
                    if (vtec && vtec[1]) vtec = vtec[1];
                }
                if (!vtec) throw new Error('No VTEC found');
                vtecObjects = (typeof vtec === 'string' ? vtec : vtec[0]).split('.');
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
                thisObject = {
                    product: vtecObjects[0],
                    actions: vtecObjects[1],
                    office: vtecObjects[2],
                    phenomena: vtecObjects[3],
                    significance: vtecObjects[4],
                    eventTrackingNumber: vtecObjects[5],
                    startTime: (parseHumanTimestampFromText(rawText) || vtecToIso(vtecObjects[6].split('-')[0])),
                    endTime: vtecToIso(vtecObjects[6].split('-')[1])
                }
            } catch (err) {
                // No VTEC, allow fallback to event-based logic
                thisObject = {};
            }

            // --- Remove alerts that have both VTEC and cleaned CAP XML ---
            if (
                cleanedCAPXML &&
                thisObject.phenomena &&
                thisObject.significance
            ) {
                // Do not add this alert
                console.log('Alert has both VTEC and cleaned CAP XML, skipping.');
                return;
            }

            // --- Remove alerts whose message is just the entire XML code ---
            // If the message is just a CAP XML block, skip it
            const isRawXMLOnly = (
                rawText.trim().startsWith('<?xml') &&
                rawText.trim().endsWith('</alert>')
            );
            if (isRawXMLOnly) {
                console.log('Alert message is raw XML only, skipping.');
                return;
            }

            // --- Reject messages that look like embedded/serialized JSON or a full CAP object ---
            // Some sources send the entire CAP object or a JSON-serialized payload inside the message
            // (contains lots of quoted key/value pairs, `properties`, `vtec`, `event_tracking_number`, `urn:oid`, etc.).
            // These should not be added to the public API -- skip them here.
            const jsonLikePairs = (rawText.match(/"\w+"\s*:\s*"/g) || []).length;
            const looksLikeEmbeddedJson = /urn:oid:|"properties"\s*:|"event_tracking_number"|"product_type"|\bvtec\b\s*:|\bstartTime\b/i.test(rawText) || jsonLikePairs >= 3;
            // If the message contains an actual CAP XML block, allow the CAP-cleanup paths to run
            // (do not treat CAP XML as "embedded JSON"). This ensures non-VTEC CAP XML gets the
            // minimal cleanup instead of being skipped entirely.
            const capXmlPresent = /<\?xml[\s\S]*?<alert[\s\S]*?<\/alert>/.test(rawText);
            if (looksLikeEmbeddedJson && !capXmlPresent) {
                console.log('Alert message appears to be embedded/serialized CAP/JSON — skipping.');
                log('Skipped message that appears to be embedded/serialized CAP/JSON.');
                return;
            }

            // --- Allow alerts with missing VTEC/phenomena/significance if event is allowed ---
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
                // --- Minimal XML cleanup for non-VTEC alerts ---
                // Only apply this block to alerts that do NOT have VTEC (no phenomena/significance)
                // and that contain a CAP XML payload. This ensures SML (simple message logic) is only for non-VTEC XML alerts.
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

                            // --- Preserve preamble and UGC line ---
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

                            // --- Capture CAP metadata for non-VTEC minimal-cleanup and populate fallbacks ---
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
                                    // CAP <expires> is commonly found under <alert> or inside the first <info> block —
                                    // check both locations so we don't miss it due to tag placement or casing.
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
                            } catch (e) { /* ignore CAP metadata extraction errors */ }

                            // For non-VTEC minimal-cleanup prefer the CAP <event> as the alert `name`
                            if (event && event.length) {
                                alertName = event;
                            }

                            // Do NOT prepend NWSheadline into `description` here —
                            // the CAP `NWSheadline` will be inserted into the cleaned
                            // `message` parts (immediately before `description`).

                            // --- Format sent time as requested ---
                            function formatIssuedTime(sent) {
                                if (!sent) return '';
                                try {
                                    const d = new Date(sent);
                                    let hours = d.getHours();
                                    let mins = d.getMinutes();
                                    let ampm = hours >= 12 ? 'PM' : 'AM';
                                    let hour12 = hours % 12 || 12;
                                    let tz = '';
                                    const isDST = d.getMonth() >= 2 && d.getMonth() <= 10;
                                    if (sent.includes('-05:00')) tz = isDST ? 'EDT' : 'EST';
                                    else if (sent.includes('-06:00')) tz = isDST ? 'CDT' : 'CST';
                                    else if (sent.includes('-07:00')) tz = isDST ? 'MDT' : 'MST';
                                    else if (sent.includes('-08:00')) tz = isDST ? 'PDT' : 'PST';
                                    else if (sent.includes('-09:00')) tz = isDST ? 'AKDT' : 'AKST';
                                    else if (sent.includes('-10:00')) tz = isDST ? 'HDT' : 'HST';
                                    else if (sent.includes('-04:00')) tz = isDST ? 'ADT' : 'AST';
                                    else tz = 'UTC';
                                    const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: '2-digit' }).replace(/,/g, '');
                                    return `${hour12}${mins.toString().padStart(2, '0')} ${ampm} ${tz}, ${dateStr}`;
                                } catch {
                                    return sent;
                                }
                            }

                            // --- Reorder and build minimalParts per user spec:
                            // preamble (if any) -> event -> sender -> issued -> UGC -> areaDesc -> NWSheadline -> description -> instruction
                            // Apply the full paragraph/newline normalization to extracted CAP fields so
                            // non‑VTEC minimal-cleanup receives the same `\n`/paragraph fixes as full messages.
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
                                    const ugc4Re = /\b(\d{4})\s+(\d{4})\b/g;
                                    while ((m = ugc4Re.exec(txt)) !== null) {
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
                                // Deduplicate and validate 4-digit pairs
                                latLonPairs = Array.from(new Set(groups)).filter(g => /^\d{4}\s+\d{4}$/.test(g));
                                // Convert UGC-style pairs back to numeric [lat, lon] and store for later use
                                if (latLonPairs.length > 0) {
                                    function ugcPairToCoord(pair) {
                                        const parts = pair.trim().split(/\s+/);
                                        // lat 4-digit -> insert decimal after 2 digits, lon 4-digit -> insert decimal after 2 digits, assume west negative
                                        const lat = parseFloat(parts[0].slice(0,2) + '.' + parts[0].slice(2));
                                        const lon = -parseFloat(parts[1].slice(0,2) + '.' + parts[1].slice(2));
                                        return [lat, lon];
                                    }
                                    capCoordinates = latLonPairs.map(ugcPairToCoord).filter(Boolean);
                                }
                            } catch (e) {
                                 // ignore extraction errors
                             }
                            // --- Insert LAT...LON line FIRST ---
                            if (latLonPairs.length > 0) {
                                minimalParts.push('LAT...LON ' + latLonPairs.join(' '));
                            } else {
                                // Fallback: try to extract from event motion or rawText if not found
                                // Try event motion text for UGC-style pairs
                                if (info && info.parameter) {
                                    const params = Array.isArray(info.parameter) ? info.parameter : [info.parameter];
                                    const foundMotion = params.find(p => p.valueName && /event\s?motion|eventmotion|eventmotiondescription/i.test(p.valueName));
                                    if (foundMotion && typeof foundMotion.value === 'string') {
                                        const motionCoords = [];
                                        const ugc4Re = /\b(\d{4})\s+(\d{4})\b/g;
                                        let m;
                                        while ((m = ugc4Re.exec(foundMotion.value)) !== null) {
                                            motionCoords.push(`${m[1]} ${m[2]}`);
                                        }
                                        if (motionCoords.length > 0) {
                                            minimalParts.push('LAT...LON ' + motionCoords.join(' '));
                                            latLonPairs = motionCoords.slice();
                                            function ugcPairToCoord(pair) {
                                                const parts = pair.trim().split(/\s+/);
                                                const lat = parseFloat(parts[0].slice(0,2) + '.' + parts[0].slice(2));
                                                const lon = -parseFloat(parts[1].slice(0,2) + '.' + parts[1].slice(2));
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

                                // --- CAP parameter extraction helpers ---
                                function getCapParam(name) {
                                    if (!info.parameter) return undefined;
                                    const params = Array.isArray(info.parameter) ? info.parameter : [info.parameter];
                                    const found = params.find(p => p.valueName && p.valueName.toUpperCase() === name.toUpperCase());
                                    return found ? found.value : undefined;
                                }

                                // --- Waterspout Detection ---
                                let waterspoutDetection = getCapParam('waterspoutDetection');
                                let waterspoutLine = '';
                                if (waterspoutDetection && String(waterspoutDetection).toLowerCase().includes('possible')) {
                                    waterspoutLine = 'WATERSPOUT...POSSIBLE';
                                }

                                // --- Max Hail Size ---
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

                                // --- Max Wind Gust ---
                                let maxWindGust = getCapParam('maxWindGust');
                                let maxWindLine = '';
                                if (maxWindGust !== undefined) {
                                    let windVal = parseFloat(maxWindGust);
                                    if (!isNaN(windVal)) {
                                        maxWindLine = `MAX WIND GUST...${windVal}`;
                                    }
                                }

                                // --- Event Motion ---
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
                                    const ugc4Re = /\b(\d{4})\s+(\d{4})\b/g;
                                    while ((m = ugc4Re.exec(txt)) !== null) {
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

                                // If we found UGC-style coord pairs in the event-motion text but did not
                                // already detect an explicit LAT...LON earlier, insert a LAT...LON
                                // paragraph so the coordinates appear BEFORE the TIME...MOT...LOC and
                                // before the MAX HAIL / MAX WIND lines that may follow.
                                if (coords.length && latLonPairs.length === 0) {
                                    minimalParts.push('LAT...LON ' + coords.join(' '));
                                    latLonPairs = coords.slice();
                                    function ugcPairToCoord(pair) {
                                        const parts2 = String(pair).trim().split(/\s+/);
                                        const lat = parseFloat(parts2[0].slice(0,2) + '.' + parts2[0].slice(2));
                                        const lon = -parseFloat(parts2[1].slice(0,2) + '.' + parts2[1].slice(2));
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
 // --- END: Extract coordinates and Event Motion ---

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
                        let alerts = [];

                        try {
                            const raw = fs.readFileSync('alerts.json', 'utf8');
                            alerts = raw.trim() ? JSON.parse(raw) : [];
                            if (!Array.isArray(alerts)) alerts = [];
                        } catch (readErr) {
                            // If the file is missing or malformed, nothing to delete
                            if (readErr.code !== 'ENOENT') {
                                console.warn('alerts.json unreadable, cannot delete alert:', readErr.message);
                                log('alerts.json unreadable, cannot delete alert: ' + readErr.message);
                            }
                            alerts = [];
                        }

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
                            const removedAlert = alerts.splice(alertIndex, 1)[0];
                            fs.writeFileSync('alerts.json', JSON.stringify(alerts, null, 2));
                            console.log('Alert cancelled and removed:', removedAlert.name);
                            log('Alert cancelled and removed: ' + removedAlert.name);
                        } else {
                            console.log('No matching alert found to cancel.');
                            log('No matching alert found to cancel.');
                        }
                    } catch (err) {
                        console.error('Error updating alerts.json for cancellation:', err);
                        log('Error updating alerts.json for cancellation: ' + err);
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
            // Prefer CAP <event> (or CAP NWSheadline when available) since it describes the
            // specific message part — this avoids taking a blanket "BULLETIN" preamble
            // (for example a Watch) when the CAP payload is actually a different event
            // such as "Special Weather Statement".
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
            // Rules:
            // - If message contains an allowed alert name (case-insensitive), use that name.
            // - Do NOT use "Severe Weather Statement" or "Flash Flood Statement" even if present.
            // - "Special Weather Statement" is allowed and will be used if present in allowedalerts.json.
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

            // Extract lat/lon
            var latLonMatch = rawText.match(/LAT\.\.\.LON\s+([\d\s]+)/);
            let coordinates = [];
            var standardCoordinates = [];
 
            if (latLonMatch) {
                var nums = latLonMatch[1].trim().split(/\s+/);
                console.log(`Extracted ${nums.length / 2} coordinate pairs`);
                for (let i = 0; i < nums.length; i += 2) {
                    coordinates.push({
                        lat: parseFloat(nums[i].slice(0, 2) + '.' + nums[i].slice(2)),
                        lon: -parseFloat(nums[i + 1].slice(0, 2) + '.' + nums[i + 1].slice(2)) // Assuming western hemisphere
                    });
                }
 
                // Standardize coordinates to [[lat, lon], ...]
                if (Array.isArray(coordinates)) {
                    standardCoordinates = coordinates
                        .map(item => {
                            // handle already-array form [lat, lon]
                            if (Array.isArray(item) && item.length >= 2) {
                                return [Number(item[0]), Number(item[1])];
                            }
                            // handle object form {lat, lon}
                            if (item && typeof item === 'object' && 'lat' in item && 'lon' in item) {
                                return [Number(item.lat), Number(item.lon)];
                            }
                            return null;
                        })
                        .filter(pair => pair && isFinite(pair[0]) && isFinite(pair[1]));
                }
 
                // Replace original coordinates with standardized form
                coordinates = standardCoordinates;
            } else {
                // No coordinates found
                coordinates = null;
            }
            // If no LAT...LON line was present in rawText, but we captured coords from CAP XML, use them
            if ((!coordinates || coordinates.length === 0) && Array.isArray(capCoordinates) && capCoordinates.length > 0) {
                coordinates = capCoordinates;
             }
            // Do not skip alerts if no coordinates; just omit the property

            // Simple message beautification
            // TODO: filter and parse messages with description and instruction tags

            // Normalize paragraphs while preserving paragraph breaks:
            // - collapse 3+ blank lines to 2
            // - join single-line wraps inside a paragraph into a single line (replace single \n with space)
            // - trim leading/trailing blank lines
            // - additionally collapse *one* extra paragraph break (\n\n -> \n) for specific
            //   known patterns (preamble numbers, preamble codes, UGC lines, VTEC lines,
            //   timestamps, common headlines, and short capitalized name splits like
            //   "San\n\nJoaquin"). These are conservative, pattern-specific fixes.
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
                // handle cases with no whitespace, single newline, or multiple whitespace/newlines
                out = out.replace(/&&\s*\n+(?=\s*LAT\.\.\.LON)/g, '&&\n\n');
                out = out.replace(/&&(?=\s*LAT\.\.\.LON)/g, '&&\n\n');

                // --------------------------- Targeted fixes ---------------------------
                // 1) Number-only preamble lines (e.g. "140\n\nWGUS86 ...") -> keep a single newline
                out = out.replace(/(^|\n)(\d{1,4})\n\n(?=[A-Z0-9])/gm, '$1$2\n');

                // 2) UGC-style line that ends with a hyphen: keep a single newline after it
                out = out.replace(/([A-Z]{2,3}[0-9]{3}(?:[>-][0-9]{3,6})*-)\n\n/g, '$1\n');

                // 3) VTEC or other slash-enclosed blocks (e.g. "/O.NEW.../" or "/00000.N.ER.../")
                //    should not be separated by an extra blank line
                out = out.replace(/(\/[^\n\/]{1,200}?\/)\n\n/g, '$1\n');

                // 4) Short capitalized-name splits (e.g. "San\n\nJoaquin") -> merge to a single newline
                out = out.replace(/(\b[A-Z][a-z]{1,20})\n\n([A-Z][a-z]{1,20}\b)/g, '$1\n$2');

                // 5) AWIPS/preamble product headers and adjacent all-caps codes (WGUS86 KSTO 161749, FLSSTO, etc.)
                //    turn double-newline into a single newline so header lines remain adjacent
                out = out.replace(/(^|\n)([A-Z]{2,6}\s+[A-Z]{2,4}\s+\d{5,8})\n\n(?=[A-Z0-9])/gm, '$1$2\n');
                out = out.replace(/(^|\n)([A-Z]{4,10})\n\n(?=[A-Z0-9])/gm, '$1$2\n');

                // 6) Generic adjacent ALL-CAPS/code lines -> single newline (conservative catch-all)
                out = out.replace(/(^|\n)([A-Z0-9\/\.\-&' ]{1,60})\n\n([A-Z0-9\/\.\-&' ]{1,60})/gm, '$1$2\n$3');

                // 7) Specific phrase/timestamp fixes: Flood Advisory, NWS office line, human timestamp
                out = out.replace(/(Flood Advisory)\n\n/gi, '$1\n');
                // Collapse double-newline after 'National Weather Service <office>' whether or not there's a trailing comma
                out = out.replace(/(National Weather Service [^\n,]{1,120},)\n\n/gi, '$1\n');
                out = out.replace(/(National Weather Service [^\n,]{1,120})(?!,)\n\n/gi, '$1\n');
                // Ensure exactly one newline BEFORE a human timestamp (collapse multiple blank lines)
                // Accept times like "839 PM", "0839 PM", or "9:39 PM" and common real-world variants
                out = out.replace(/\n{2,}(?=(?:At\s+)?(?:\d{3,4}|\d{1,2}(?::\d{2})?)\s*(?:AM|PM)\s*(?:PST|PDT|MST|MDT|CST|CDT|EST|EDT|HST|HDT|AKDT|AKST)\s*(?:,?\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))?\s*[A-Za-z]{3}\s+\d{1,2}\s+\d{4})/gi, '\n');
                // Extra fallback: collapse double-newline immediately before 3- or 4-digit times (e.g. "\n\n839 PM...")
                out = out.replace(/\n{2,}(?=(?:At\s+)?\d{3,4}\s*(?:AM|PM))/gi, '\n');
                // Ensure timestamp is followed by exactly two newlines (timestamp ends paragraph)
                out = out.replace(/((?:At\s+)?(?:\d{3,4}|\d{1,2}(?::\d{2})?)\s*(?:AM|PM)\s*(?:PST|PDT|MST|MDT|CST|CDT|EST|EDT|HST|HDT|AKDT|AKST)\s*(?:,?\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))?\s*[A-Za-z]{3}\s+\d{1,2}\s+\d{4})\n*/gi, '$1\n\n');

                // 10) Collapse double-newline after common section headings (EXCEPT those that should remain their own paragraph)
                (function(){
                    // keep these compact (collapse the extra blank line)
                    const headings = [
                        'WIND',
                        'HAIL',
                        'HAIL THREAT',
                        'WIND THREAT',
                        'TORNADO',
                        'TORNADO DAMAGE THREAT',
                        'THUNDERSTORM DAMAGE THREAT',
                        'FLASH FLOOD DAMAGE THREAT',
                        'FLASH FLOOD',
                        'WATERSPOUT',
                        'EXPECTED RAINFALL RATE'
                    ];
                    for (const h of headings) {
                        const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        // match the heading possibly followed by dots and whitespace, then two+ newlines
                        const re = new RegExp('(' + esc + '(?:\.{2,}|\.{0,3})?)\\n\\n', 'gi');
                        out = out.replace(re, '$1\n');
                    }
                })();

                // Ensure the following headings have TWO newlines BEFORE them but ONLY ONE newline AFTER
                (function(){
                    const adjust = ['LAT...LON','TIME...MOT...LOC','TIME.MOT.LOC','MAX HAIL SIZE','MAX WIND GUST','WATERSPOUT'];
                    for (const h of adjust) {
                        const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                        // 1) If the heading follows a paragraph without a blank line, ensure a blank line BEFORE it
                        //    (convert single-newline separation into a paragraph break)
                        out = out.replace(new RegExp('([^\\n])\\n(\\s*' + esc + '(?:\\.{2,}|\\.{0,3})?[^\\n]*)','gi'), '$1\\n\\n$2');

                        // 2) Normalize any amount of blank lines BEFORE the heading down to exactly TWO
                        out = out.replace(new RegExp('\\n{2,}(\\s*' + esc + '(?:\\.{2,}|\\.{0,3})?[^\\n]*)','gi'), '\\n\\n$1');

                        // 3) Ensure exactly ONE newline AFTER the heading (collapse 2+ following newlines to 1)
                        out = out.replace(new RegExp('(' + esc + '(?:\\.{2,}|\\.{0,3})?[^\\n]*)\\n{2,}','gi'), '$1\\n');

                        // 4) If heading is at EOF with no trailing newline, ensure a single trailing newline
                        out = out.replace(new RegExp('(' + esc + '(?:\\.{2,}|\\.{0,3})?[^\\n]*)$','gi'), '$1\\n');
                    }
                })();

                // 8) Hyphen-terminated areaDesc handling:
                //    - keep adjacent capitalized fragments joined (e.g. "X-\nY" -> "X-Y")
                //    - collapse stray newlines inside long hyphen-separated areaDesc paragraphs
                //      (e.g. "Mariposa-...-Kings Canyon NP-Grant Grove Area" should be a single paragraph)
                out = out.replace(/(-)\n+(?=\s*[A-Z][a-z])/g, '$1');

                // Collapse internal single-newlines inside paragraphs that contain multiple hyphen-separated
                // tokens (these are almost always areaDesc lines). Run this BEFORE we force a newline
                // before "Including" so the subsequent rule can place "Including" on its own line.
                out = out.replace(/(^|\n)((?:(?!\n).*-){2,}.*?)(?=\n{2,}|$)/gm, function(_, pfx, body){
                    return pfx + body.replace(/\n+/g, ' ');
                });

                // Ensure 'Including' starts on its own line when it follows an area-desc fragment
                out = out.replace(/-\s*(Including\b)/gi, '-\n$1');

                // 9) Collapse any newlines inside an "Including ..." list (until the next paragraph) into spaces
                //    (the "Including" heading will be on its own line due to the rule above)
                out = out.replace(/(Including\b[\s\S]*?)(?=\n{2,}|$)/gi, function(m){ return m.replace(/\n+/g, ' '); });

                // 9b) Normalize "locations ... include" blocks:
                //    - ensure exactly one newline after the heading, list each location on its own line,
                //      and end the list with two newlines (unless the following paragraph already provides separation).
                out = out.replace(/(locations(?:\s+impacted)?\s+includes?\b[^\n]*)\n+([\s\S]*?)(?=\n{2,}|$)/gi, function(_, heading, listBody){
                    // collapse internal newlines to spaces, then split on common separators
                    const flat = listBody.replace(/\n+/g, ' ').trim();
                    const parts = flat.split(/\s*(?:,|;|\/|\band\b|\s-\s|\s+—\s+)\s*/i).map(s=>s.trim()).filter(Boolean);
                    if (parts.length <= 1) {
                        // not a multi-item list — ensure single newline after heading and keep remainder
                        return heading + '\n' + flat;
                    }
                    // return heading + newline + one-item-per-line + paragraph break
                    return heading + '\n' + parts.join('\n') + '\n\n';
                });

                // 9c) Collapse an extra blank line before short all-caps region/state names (e.g. "\n\nKANSAS") to a single newline,
                //      but do not collapse section headings like PRECAUTIONARY/PREPAREDNESS ACTIONS or other known section headers.
                out = out.replace(/\n{2,}(?=\s*(?!PRECAUTIONARY|PREPAREDNESS|ACTIONS|WHAT|WHERE|IMPACTS|LAT\.{3}|TIME|WIND|HAIL|TORNADO)[A-Z0-9 '\&\-.]{1,40}\b(?:\.{3})?(?:\n|$))/gi, '\n');

                // 11) Collapse double-newline between numeric-only lines (UGC/LAT...LON number lists)
                // Convert patterns like "1234 56789\n\n2345 67890" -> single newline between numeric lines
                out = out.replace(/(^|\n)(\s*(?:\d{3,5}(?:\s+\d{3,5})*)\s*)\n\n(?=\s*\d{3,5})/gm, '$1$2\n');

                // 12) For starred sections like "* WHAT...", "* WHERE...", etc. collapse internal double-newlines
                // into single newlines while preserving a double-newline between different sections.
                // Do not allow the starred-section block to consume trailing delimiter lines
                // (lines that contain only &&, $ or $$). Stop the block before such delimiter lines.
                out = out.replace(/(\*\s+[A-Z][\s\S]*?)(?=\n\*\s+[A-Z]|\n\s*(?:&&|\$\$?|\$)\s*(?:\n|$)|$)/g, function(block) {
                    // collapse multiple blank lines inside the block to single newlines
                    // but do not remove the final blank-line separator (we'll re-ensure it)
                    let inner = block.replace(/\n{3,}/g, '\n\n');
                    // collapse internal double-newlines that are not immediately followed by '* '
                    inner = inner.replace(/\n\n(?!\*\s)/g, '\n');
                    // ensure block ends with exactly two newlines so sections stay separated
                    inner = inner.replace(/\n+$/g, '') + '\n\n';
                    return inner;
                });

                // 13) Ensure short all-caps product lines (e.g., "NPWBUF") are followed by a blank line
                // This keeps preamble blocks visually separated: "546\nWWUS71 KBUF 170217\nNPWBUF\n\n"
                out = out.replace(/(^|\n)([A-Z]{3,8})\n(?!\n)/gm, '$1$2\n\n');

                // Ensure PRECAUTIONARY / PREPAREDNESS ACTIONS (with or without leading '*') is its own paragraph
                // Accept optional spaces around the slash and preserve a leading '* ' if present.
                out = out.replace(/\n{0,2}\s*(\*\s*)?(PRECAUTIONARY\s*\/\s*PREPAREDNESS ACTIONS\.{3,})\s*\n{0,2}/gi, '\n\n$1$2\n\n');

                // Final enforcement: ensure '&&' and '$$' are surrounded by exactly two newlines
                // This runs last so earlier replacements can't collapse these separators.
                out = out.replace(/\n{0,2}&&\n{0,2}/g, '\n\n&&\n\n');
                out = out.replace(/\n{0,2}\$\$\n{0,2}/g, '\n\n$$\n\n');

                // Last-resort: if any double-newline still appears immediately before a 3- or 4-digit time
                // (examples: "\n\n839 PM...", "\n\n1139 PM..."), collapse it to a single newline.
                out = out.replace(/\n{2,}(?=(?:At\s+)?\d{3,4}\s*(?:AM|PM))/gi, '\n');

                // Final collapse: reduce any 3+ consecutive newlines to exactly two
                // (fixes cases where earlier replacements accidentally introduce a third blank line)
                out = out.replace(/\n{3,}/g, '\n\n');

                return out;
            }

            // Normalize incoming message newlines and enforce heading spacing rules.
            // Hoisted so it can be used early during CAP/rawText processing as well as per-part.
            function formatMessageNewlines(msg) {
                if (!msg) return msg;
                let formatted = String(msg);

                // 0) Remove all XML tags (anything between < and >)
                formatted = formatted.replace(/<[^>]+>/g, '');

                // 1) Convert literal escaped sequences ("\\n", "\\r\\n") into actual newlines
                formatted = formatted.replace(/\\r\\n/g, '\n');
                formatted = formatted.replace(/\\n/g, '\n');

                // 2) Normalize any remaining CR/LF into \n
                formatted = formatted.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

                // 3) Remove stray trailing/leading whitespace around newlines (prevents " <newline>HEADING" cases)
                formatted = formatted.replace(/[ \t]+\n/g, '\n');
                formatted = formatted.replace(/\n[ \t]+/g, '\n');
                formatted = formatted.replace(/^\s+|\s+$/g, '');

                // 4) Defensive: replace any remaining backslash+n sequences
                formatted = formatted.replace(/\\+n/g, '\n');

                // 5) Collapse runs of 3+ newlines down to exactly 2 (paragraph separation)
                formatted = formatted.replace(/\n{3,}/g, '\n\n');

                // 6) Ensure exact spacing before headings that should have TWO newlines
                const twoNL = ['HAZARD\\.\\.\\.', 'SOURCE\\.\\.\\.', 'IMPACT\\.\\.\\.', 'Locations impacted include'];
                for (const h of twoNL) {
                    // If the heading is on the same line as previous text (possibly separated by spaces),
                    // strip those spaces and insert exactly two newlines before the heading.
                    formatted = formatted.replace(new RegExp('([^\\n\\s])\\s*(' + h + ')', 'g'), '$1\n\n$2');
                    // Collapse any existing newline(s)+optional spaces before the heading to exactly two newlines
                    formatted = formatted.replace(new RegExp('\\n+\\s*(' + h + ')', 'g'), '\n\n$1');
                }

                // 7) Ensure exact spacing before headings that should have ONE newline
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
                    // If heading immediately follows text (possibly with spaces), strip spaces and insert one newline
                    formatted = formatted.replace(new RegExp('([^\\n\\s])\\s*(' + h + ')', 'g'), '$1\n$2');
                    // Collapse any existing newline(s)+optional spaces before the heading to exactly one newline
                    formatted = formatted.replace(new RegExp('\\n+\\s*(' + h + ')', 'g'), '\n$1');
                }

                // 8) Ensure TIME...MOT...LOC is single-lined (followed by normal spacing)
                formatted = formatted.replace(/(LAT\.\.\.LON[^\n]*)\n+(\s*TIME\.\.\.MOT\.\.\.LOC)/g, '$1\n$2');

                // 9) Final pass: remove any remaining trailing spaces before newlines, collapse multiples and trim
                formatted = formatted.replace(/[ \t]+\n/g, '\n');
                formatted = formatted.replace(/\n{3,}/g, '\n\n');
                formatted = formatted.replace(/^\s+|\s+$/g, '');

                return formatted;
            }

            // --- START: Message cleanup and splitting logic ---

            /**
             * Cleans up and splits the alert message so that && and $$ tokens (and any trailing text)
             * are appended to the previous message part, not as their own part.
             * Also removes XML tags and replaces 2+ spaces with \n.
             * @param {string} msg
             * @returns {string[]} Array of cleaned message blocks
             */
            function cleanAndSplitMessage(msg) {
                if (!msg) return [];

                // Remove XML tags (anything between <...>)
                msg = msg.replace(/<[^>]+>/g, '');

                // Replace 2+ spaces with \n
                msg = msg.replace(/ {2,}/g, '\n');

                // Split at every && or $$, but append the delimiter and its trailing text to the previous part
                let splitRegex = /(\s*(?:&&|\$\$)[^\s]*)/g;
                let parts = [];
                let lastIndex = 0;
                let match;
                while ((match = splitRegex.exec(msg)) !== null) {
                    // Everything before the delimiter
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

                // Only split at && or $$ delimiters, do NOT split at UGC codes
                let blocks = parts.map(part => normalizeParagraphs(part));
                // Ensure delimiters are surrounded by double newlines
                blocks = blocks.map(b => {
                    if (!b) return b;
                    b = b.replace(/\s*&&\s*/g, '\n\n&&\n\n');
                    b = b.replace(/\s*\$\$\s*/g, '\n\n$$\n\n');
                    return b;
                });
                // Remove empty blocks (but keep blocks with &&, $$, or text)
                return blocks.filter(b => b && b.replace(/\s/g, '').length > 0);
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
                // Heuristic: detect short uppercase continuation lines (e.g. "EVENING") that are
                // part of a wrapped headline and merge them into the headline while removing
                // the wrapped line from the raw message so it is not duplicated.
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

                function normalizeHeadlineCandidate(s) { return String(s || '').replace(/\s+/g, ' ').replace(/^BULLETIN - /i, '').trim(); }

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

                    // If the computed headline looks like a numeric/product code (e.g. "785") or is too short,
                    // try to prefer a more descriptive line from the full rawText.  This fixes cases where the
                    // first raw line is an AWIPS/product number and a real headline appears later (e.g. "...FLOOD
                    // ADVISORY IN EFFECT UNTIL 445 PM CST THIS AFTERNOON...").
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
            // Helper: expand a UGC group string into individual UGC IDs (ignore timestamps / non-3-digit tokens)
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

            // Simple HTTPS GET -> JSON with small cache
            const __zoneInfoCache = (global.__zoneInfoCache = global.__zoneInfoCache || new Map());
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

            // Build parsedAlerts asynchronously so we can fetch zone/county names
            let parsedAlerts = [];
            for (let idx = 0; idx < messageParts.length; idx++) {
                const msgPart = messageParts[idx];

                // --- Remove message parts that are just XML ---
                const isPartRawXMLOnly = (
                    msgPart.trim().startsWith('<?xml') &&
                    msgPart.trim().endsWith('</alert>')
                );
                if (isPartRawXMLOnly) continue;

                // Extract VTEC from each message part
                let vtec = msgPart.match(/\/O\..*?\/\n?/);
                if (!vtec) {
                    vtec = msgPart.match(/<parameter>\s*<valueName>VTEC<\/valueName>\s*<value>(.*?)<\/value>\s*<\/parameter>/);
                    if (vtec && vtec[1]) vtec = vtec[1];
                }
                if (!vtec) vtec = null;
                let vtecObjects = vtec ? (typeof vtec === 'string' ? vtec : vtec[0]).split('.') : [];

                // Function to convert VTEC time to ISO UTC timestamp
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

                // Build vtec object for this message part.
                // - If a full VTEC string is present, parse all fields.
                // - Otherwise, for true non‑VTEC minimal cleanup build a *minimal* vtec object
                //   containing only meaningful values (eventTrackingNumber/startTime/endTime)
                //   or set to `null` when nothing is available. This prevents empty string
                //   fields like office/phenomena/significance from being emitted.
                let vtecObj = null;
                if (vtecObjects.length >= 7) {
                    vtecObj = {
                        product: vtecObjects[0],
                        actions: vtecObjects[1],
                        office: vtecObjects[2],
                        phenomena: vtecObjects[3],
                        significance: vtecObjects[4],
                        eventTrackingNumber: vtecObjects[5],
                        startTime: (parseHumanTimestampFromText(msgPart) || vtecToIso(vtecObjects[6].split('-')[0])),
                        endTime: vtecToIso(vtecObjects[6].split('-')[1])
                    };
                } else {
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

                let alertObj = {
                    name: alertName,
                    id: (messageParts.length === 1) ? baseId : (baseId + '_' + idx),
                    sender: (vtecObj && vtecObj.office) ? vtecObj.office : (thisObject && thisObject.office) || '',
                    headline: headline,
                    issued: (vtecObj && vtecObj.startTime) ? vtecObj.startTime : (thisObject && thisObject.startTime) || null,
                    expiry: (vtecObj && vtecObj.endTime) ? vtecObj.endTime : ((thisObject && thisObject.endTime) ? thisObject.endTime : (capExpires || null)),
                    message: formattedMessage,
                    ugc: [],
                    areaDesc: '',
                    properties: props
                };

                // Attach coordinates if available (either from LAT...LON line or CAP polygon/params)
                if (coordinates && coordinates.length > 0) {
                    alertObj.coordinates = coordinates;
                }

                // If there is no meaningful headline, remove the `headline` property entirely so
                // stored alerts don't contain empty/junk headline values (user request).
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
                    // store as array of individual UGC codes as requested
                    alertObj.ugc = ugcIds;

                    if (ugcIds.length) {
                        // fetch all display names in parallel (cached)
                        const results = await Promise.all(ugcIds.map(id => lookupZoneDisplay(id)));
                        const names = results.filter(Boolean);
                        if (names.length) {
                            // Join multiple names with semicolon as requested
                            alertObj.areaDesc = names.join('; ');
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

                // --- Extract structured eventMotionDescription from TIME...MOT...LOC if present ---
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

                        // If the eventMotionDescription includes a valid lat/lon and no coordinates were already
                        // attached from LAT...LON or CAP polygon, promote it to `coordinates` so API consumers
                        // always receive a `coordinates` property when a point is available.
                        if (typeof emd.lat === 'number' && !isNaN(emd.lat) && typeof emd.lon === 'number' && !isNaN(emd.lon) &&
                            (!alertObj.coordinates || !alertObj.coordinates.length)) {
                            alertObj.coordinates = [[Number(emd.lat), Number(emd.lon)]];
                        }
                    }
                })();

                // --- Normalize headline when message contains 'REMAINS IN EFFECT' or an 'EMERGENCY FOR' line ---
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
                    // also match plain "IN EFFECT ..." lines (examples: "FLOOD ADVISORY IN EFFECT UNTIL 445 PM CST THIS AFTERNOON" or
                    // "SMALL CRAFT ADVISORY NOW IN EFFECT FROM NOON SUNDAY TO NOON AST MONDAY") — include FROM as well.
                    // allow a short uppercase continuation on the following line (covers "...THIS AFTERNOON" on next line)
                    const inEffectRe = /([A-Z][A-Z\s]+IN EFFECT\s+(?:UNTIL|THROUGH|TO|FROM)[^\.\n]*(?:\r?\n\s*[A-Z0-9 \-]{1,80})?)/i;
                    const rieMatch = src.match(rieRe) || src.match(inEffectRe);
                    if (rieMatch) {
                        const extracted = (rieMatch[1] || '').replace(/\s+/g, ' ').trim();
                        if (!/EMERGENCY/i.test(extracted)) {
                            alertObj.headline = extracted;
                        }
                    }
                })();

                // If `eventMotionDescription` exists, ensure it is serialized directly after `coordinates`.
                // Do NOT add the property when it does not exist — this preserves compact output.
                if (Object.prototype.hasOwnProperty.call(alertObj, 'eventMotionDescription') && alertObj.coordinates) {
                    const ordered = {};
                    for (const k of Object.keys(alertObj)) {
                        if (k === 'coordinates') {
                            ordered['coordinates'] = alertObj['coordinates'];
                            ordered['eventMotionDescription'] = alertObj['eventMotionDescription'];
                        } else if (k !== 'eventMotionDescription') {
                            ordered[k] = alertObj[k];
                        }
                    }
                    alertObj = ordered;
                }

                // --- START: build `alertinfo` object from message sections (WHAT / WHEN /WHERE / IMPACTS / threat fields) ---
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

                    alertObj.alertinfo = ai;
                })();
                // --- END: alertinfo build ---

                parsedAlerts.push(alertObj);
            }

            // Remove any null/undefined entries (in case)
            parsedAlerts = parsedAlerts.filter(Boolean);

            // ===================== DEDUPLICATION LOGIC ===========================
            try {
                let alerts = [];

                try {
                    const raw = fs.readFileSync('alerts.json', 'utf8');
                    alerts = raw.trim() ? JSON.parse(raw) : [];
                    if (!Array.isArray(alerts)) alerts = [];
                } catch (readErr) {
                    // If the file is missing or malformed, start fresh
                    if (readErr.code !== 'ENOENT') {
                        console.warn('alerts.json unreadable, recreating file:', readErr.message);
                        log('alerts.json unreadable, recreating file: ' + readErr.message);
                    }
                    alerts = [];
                }

                // For each parsedAlert, remove any existing alert with the same id, then add the new one
                parsedAlerts.forEach(parsedAlert => {
                    const id = parsedAlert.id;
                    if (id) {
                        const removedAlerts = alerts.filter(alert => alert.id === id);
                        if (removedAlerts.length > 0) {
                            removedAlerts.forEach(removedAlert => {
                                console.log(`✗ Alert removed: ${removedAlert.name} (ID: ${removedAlert.id})`);
                                log('Alert removed: ' + removedAlert.name + ' (ID: ' + removedAlert.id + ')');
                            });
                        }
                        alerts = alerts.filter(alert => alert.id !== id);
                    }
                    alerts.push(parsedAlert);
                    console.log(`✓ Alert stored successfully: ${parsedAlert.name} (ID: ${parsedAlert.id})`);
                    log('Alert stored successfully: ' + parsedAlert.name + ' (ID: ' + parsedAlert.id + ')');
                });
                fs.writeFileSync('alerts.json', JSON.stringify(alerts, null, 2));
            } catch (err) {
                console.error('Error updating alerts.json:', err);
                log('Error updating alerts.json:', err);
            }
            // ===================== END DEDUPLICATION LOGIC ===========================
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
