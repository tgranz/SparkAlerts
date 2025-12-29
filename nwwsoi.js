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

// For storing crexentials
var username = null;
var password = null;

(async () => {
    // Polyfill WebSocket for @xmpp/client
    const { client, xml } = await import('@xmpp/client');
    const wsModule = await import('ws');
    global.WebSocket = wsModule.default || wsModule.WebSocket || wsModule;

    // Variable to store the interval ID so we can stop it if needed
    let deleteExpiredAlertsInterval = null;

    // Task to clean up the alerts.json file
    async function deleteExpiredAlerts() {
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

            // Filter out expired alerts (iterate backwards to avoid issues)
            const now = new Date();
            const initialCount = alerts.length;
            alerts = alerts.filter(alert => {
                if (!alert.expiry) return true; // Keep alerts without expiry
                const expiry = new Date(alert.expiry);
                return now <= expiry; // Keep only non-expired alerts
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
        // Clear any existing intervals
        if (deleteExpiredAlertsInterval) {
            clearInterval(deleteExpiredAlertsInterval);
            deleteExpiredAlertsInterval = null;
        }

        if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
            log('Max reconnection attempts reached. Check network connection and credentials, or increase MAX_RECONNECT_ATTEMPTS.');
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
        } catch (err) {
            // If restart fails, log and try again
            log(`Reconnection attempt failed: ${err.message}`);
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
        parser.parseString(xml, (err, result) => {


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

            // ================================================================================
            // VTEC parser
            // https://www.weather.gov/bmx/vtec

            try {
                // Try to find VTEC in raw text first
                var vtec = rawText.match(/\/O\..*?\/\n?/);
                
                /*<parameter>
                    <valueName>VTEC</valueName>
                    <value>/O.NEW.KDLH.SC.Y.0147.251220T0000Z-251220T1200Z/</value>
                </parameter>*/

                if (!vtec) {
                    vtec = rawText.match(/<parameter>\s*<valueName>VTEC<\/valueName>\s*<value>(.*?)<\/value>\s*<\/parameter>/);
                    if (vtec && vtec[1]) vtec = vtec[1];
                }
                
                if (!vtec) throw new Error('No VTEC found');
                
                vtecObjects = (typeof vtec === 'string' ? vtec : vtec[0]).split('.');

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

                thisObject = {
                    product: vtecObjects[0],
                    actions: vtecObjects[1],
                    office: vtecObjects[2],
                    phenomena: vtecObjects[3],
                    significance: vtecObjects[4],
                    eventTrackingNumber: vtecObjects[5],
                    startTime: vtecToIso(vtecObjects[6].split('-')[0]),
                    endTime: vtecToIso(vtecObjects[6].split('-')[1])
                }
            } catch (err) {
                // No VTEC, this is not an alert
                return;
            }

            var acceptPhenomena = [
                'TO', // Tornado
                'SV', // Severe Thunderstorm
                'FF', // Flash Flood
                'MA', // Marine
                'AF', // Air Quality
                'HU', // Hurricane
                'TR', // Tropical Storm
                'TY', // Typhoon
                'FL', // Flood
                'SQ', // Snow Squall
                'LW', // Lake Wind
                'UP', // Heavy Freezing Spray
                'ZR', // Freezing Rain
                'WS', // Winter Storm
                'IS', // Ice Storm
                'LE', // Lakeshore Flood
                'WW', // Winter Weather
                'CF'  // Coastal Flood
            ]

            if (!acceptPhenomena.includes(thisObject.phenomena)) {
                // Not an alert type we care about
                console.log('Ignoring alert with phenomena code:', thisObject.phenomena);
                return;
            }

            // ================================================================================

            if (thisObject.actions === 'CAN' || thisObject.actions === 'EXP') {
                // This is a cancellation or expiration, delete the alert from the database
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
                        console.log('Alert cancelled/expired and removed:', removedAlert.name);
                        log('Alert cancelled/expired and removed: ' + removedAlert.name);
                    } else {
                        console.log('No matching alert found to cancel/expire.');
                        log('No matching alert found to cancel/expire.');
                    }
                } catch (err) {
                    console.error('Error updating alerts.json for cancellation/expiration:', err);
                    log('Error updating alerts.json for cancellation/expiration: ' + err);
                }
                return;
            } else if (thisObject.actions !== 'UPG' || thisObject.actions !== 'COR' || thisObject.actions !== 'CON') {
                // Update, correction, or continuation
                // TODO: Implement update/correction logic
                // Preserve coordinates and other data not included with update.
            }

            // Extract alert name
            var alertNameMatch = rawText.match(/BULLETIN.*?\s+(.*?)\s+National Weather Service/);
            var alertName = alertNameMatch ? alertNameMatch[1].trim() : null;

            if (!alertName) {
                // Different format: <event>Snow Squall Warning</event>
                alertNameMatch = rawText.match(/<event>(.*?)<\/event>/);
                alertName = alertNameMatch ? alertNameMatch[1].trim() : 'Unknown Alert';
            }
            
            // Extract recieved time
            var recievedTime = null;
            try {
                recievedTime = body.message.x[0].$.issued;
            } catch {}

            // Extract lat/lon
            var latLonMatch = rawText.match(/LAT\.\.\.LON\s+([\d\s]+)/);
            let coordinates = [];
            var standardCoordinates = [];

            if (latLonMatch) {
                var nums = latLonMatch[1].trim().split(/\s+/);
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
            }

            // Simple message beautification
            // TODO: filter and parse messages with description and instruction tags
            var message = rawText.replace(/\n\n/g, '\n').replace(/\n/g, ' ');

            var idString = thisObject.product_type + thisObject.office + (Math.random() * 1000000).toFixed(0);

            var headline = null;
            try {
                headline = rawText.split('\n')[0].replace('BULLETIN - ', '').trim();
            } catch {}

            // Output parsed result
            var parsedAlert = {
                name: alertName,
                id: idString,
                coordinates: coordinates,
                sender: thisObject.office,
                headline: headline,
                issued: thisObject.startTime,
                expiry: thisObject.endTime,
                message: message,
                properties: {
                    recievedTime: recievedTime,
                    vtec: thisObject,
                    product_type: thisObject.phenomena + thisObject.significance,
                    phenomena: thisObject.phenomena,
                    significance: thisObject.significance,
                    event_tracking_number: thisObject.eventTrackingNumber
                }
            };

            // Append the alert to alerts.json (tolerate empty/invalid file)
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

                alerts.push(parsedAlert);
                fs.writeFileSync('alerts.json', JSON.stringify(alerts, null, 2));
                console.log('Alert stored successfully:', parsedAlert.name);
                log('Alert stored successfully: ' + parsedAlert.name);
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
    start: async () => { },
    auth: (a, b, c, d, e) => {
        username = a;
        password = b; 
        resource = c || 'SparkAlerts NWWS Ingest Client';
        MAX_RECONNECT_ATTEMPTS = d || 10;
        INITIAL_RECONNECT_DELAY = e || 2000;
    }
};