/*
(c) 2024 Tyler Granzow - Apache License 2.0

This file hosts an asynchronous function to listen to the NWWS-OI
XMPP feed, parses incoming alert messages, and stores them in alerts.json
such that the server can be restarted without losing data.

It also performs periodic cleanup of expired alerts from the database.

Alerts issued while the script is offline will not be captured.
*/


// ========== IMPORTS AND INITIALIZATION ==========
// Imports
const fs = require('fs');
const { nosyncLog, log } = require('./logging.js');
const xml2js = require('xml2js');
const path = require('path');

// Variables storing credentials and configuration
var username;
var password;
var resource;
var config;
var reconnectAttempt = 0;
var RECONNECT_DELAY = 2000;


// ========== MAIN LOGIC ==========
// Scope to allow use of async/await at top level
(async () => {
    // Setup XMPP client websocket
    const { client, xml } = await import('@xmpp/client');
    const wsModule = await import('ws');
    global.WebSocket = wsModule.default || wsModule.WebSocket || wsModule;

    // Task to clean up the alerts.json file
    let deleteExpiredAlertsInterval = null;
    async function deleteExpiredAlerts() {
        nosyncLog('Running expired alerts cleanup task.', 'DEBUG');
        try {
            let alerts = [];

            try {
                // Read in existing alerts
                const raw = fs.readFileSync('alerts.json', 'utf8');
                alerts = raw.trim() ? JSON.parse(raw) : [];
                if (!Array.isArray(alerts)) alerts = [];
            } catch (readErr) {
                console.error('Could not read alerts file during cleanup: ' + readErr.message);
                nosyncLog('Could not read alerts file during cleanup: ' + readErr.message, 'ERROR');
                return;
            }

            // Filter out expired alerts (iterate backwards to avoid issues)
            const now = new Date();
            const initialCount = alerts.length;
            alerts = alerts.filter(alert => {
                // If alert has no expiry, keep it indefinitely
                if (!alert.expiry) return true;
                // Keep alerts that have not yet expired
                return now <= new Date(alert.expiry);
            });
            const removedCount = initialCount - alerts.length;

            // Write back updated alerts if any were removed
            if (removedCount > 0) {
                fs.writeFileSync('alerts.json', JSON.stringify(alerts, null, 2));
                nosyncLog(`Expired alerts cleanup ran successfully. (Removed ${removedCount} expired alert(s)).`, 'DEBUG');
            } else {
                nosyncLog('Expired alerts cleanup ran successfully (no expired alerts found).', 'DEBUG');
            }
        } catch (err) {
            nosyncLog(`Expired alerts cleanup exited with an error: ${err.message}`, 'ERROR');
            console.error('Error in alert database cleanup:', err);
        }
    }

    // Enable running the cleanup task every minute
    if (!deleteExpiredAlertsInterval) {
        deleteExpiredAlerts();
        deleteExpiredAlertsInterval = setInterval(deleteExpiredAlerts, 60 * 1000);
    }

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

        // Verify credentials are provided
        if (!xmppConfig.username || !xmppConfig.password) {
            nosyncLog('No credentials were passed to the NWWSOI module.', 'ERROR');
            console.error('No credentials were passed to the NWWSOI module. This is either an issue with the code or the XMPP server.');
            process.exit(1);
        }
        
        // Start XMPP client
        if (!config.app?.silent_console) console.log('Creating XMPP client for NWWS-OI...');
        const xmpp = client(xmppConfig);

        // Handle disconnections
        xmpp.on('disconnect', () => {
            nosyncLog('XMPP client disconnected. Attempting to reconnect...');
            if (!config.app?.silent_console) console.log('XMPP connection closed. Attempting to reconnect...');
            handleReconnect();
        });

        // Handle closed connections
        xmpp.on('close', () => {
            nosyncLog('XMPP connection closed. Attempting to reconnect...');
            if (!config.app?.silent_console) console.log('XMPP connection closed. Attempting to reconnect...');
            handleReconnect();
        });

        // Return the configured XMPP client
        return xmpp;
    }

    // Function to handle reconnections with exponential backoff
    async function handleReconnect() {
        // Clear any existing intervals
        if (deleteExpiredAlertsInterval) {
            clearInterval(deleteExpiredAlertsInterval);
            deleteExpiredAlertsInterval = null;
        }


        if (reconnectAttempt >= config.nwws?.max_reconnect_attempts || 10) {
            nosyncLog('Max reconnection attempts reached. Check network connection and credentials, or increase max_reconnect_attempts. The process will exit now.', 'ERROR');
            console.error('Max reconnection attempts reached! Could not reestablish connection to XMPP server. Check network connection and credentials, or increase max_reconnect_attempts.');
            process.exit(1);
        }

        // Exponential backoff with jitter to avoid thundering herd
        const delay = RECONNECT_DELAY * Math.pow(2, reconnectAttempt) + Math.random() * 1000;
        nosyncLog(`Attempting reconnection in ${Math.round(delay / 1000)} seconds (attempt ${reconnectAttempt + 1}/${config.nwws?.max_reconnect_attempts || 10})...`);
        if (!config.app?.silent_console) console.log(`Reconnecting in ${Math.round(delay / 1000)} seconds (attempt ${reconnectAttempt + 1}/${config.nwws?.max_reconnect_attempts || 10})...`);
        await new Promise(resolve => setTimeout(resolve, delay));

        // Increment attempt counter
        reconnectAttempt++;

        try {
            // Attempt to create and start a new XMPP client
            xmpp = createXMPPClient();
            await xmpp.start();
            if (!config.app?.silent_console) console.log('Reconnection success.');
        } catch (err) {
            // If restart fails, log and try again
            nosyncLog(`Reconnection attempt failed: ${err.message}`, 'WARN');
            console.warn(`Reconnection attempt ${reconnectAttempt} failed:`, err.message);
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
        nosyncLog(`Connected to XMPP chatroom as ${address}`, 'INFO');
        if (!config.app?.silent_console) console.log('Connected to XMPP chatroom successfully.');

        // Try to join the NWWS chat room
        try {
            xmpp.send( xml('presence', { to: `nwws@conference.nwws-oi.weather.gov/${config.nwws?.nickname || 'SparkAlerts NWWS Ingest'}` }) );
        } catch (err) {
            // If there is an error joining, log and try again
            nosyncLog(`Error joining NWWS room: ${err.message}`, 'ERROR');
            console.error('Error joining NWWS chat room:', err);
            handleReconnect();
        }
    });


    // Event listener for incoming stanzas (messages)
    xmpp.on('stanza', (stanza) => {
        // Ignore non-message stanzas (specifically, presence notifications and warning stanzas)
        if (!stanza.is('message') || stanza.toString().includes("**WARNING**WARNING**WARNING**WARNING")) {
            if (!config.app?.silent_console) console.log("Ignoring non-message stanza.");
            return;
        }

        // Convert the XML stanzas into JSON because I hate XML
        var xml = stanza.toString();
        var parser = new xml2js.Parser();

        // Alert message processing
        parser.parseString(xml, (err, result) => {
            // If there is any error parsing, log and continue
            if (err) {
                nosyncLog(`Error parsing XML message: ${err.message}`, 'ERROR');
                console.warn('Error parsing XML, message will not be processed:', err);
                return;
            } else if (!result || !result.message || !result.message.body || !Array.isArray(result.message.body)) {
                console.warn('Invalid XML message structure:', result);
                nosyncLog('Invalid XML message structure, message will not be processed. See console output for details.', 'ERROR');
                return;
            }

            // Extract the message body
            var body = result.message.body[0];

            // Verify body is not empty
            if (body === undefined || body === null) {
                console.warn('Message body is empty, ignoring.');
                nosyncLog('XML message body is empty, ignoring.', 'WARN');
                return;
            }

            // Extract raw text content from the message
            var rawText = result.message.x[0]._;

            // VTEC parser. VTEC help: https://www.weather.gov/bmx/vtec
            try {
                // Try to find VTEC in raw text first
                var vtec = rawText.match(/\/O\..*?\/\n?/);

                // Cannot find VTEC in raw text, try in XML parameters
                if (!vtec) {
                    vtec = rawText.match(/<parameter>\s*<valueName>VTEC<\/valueName>\s*<value>(.*?)<\/value>\s*<\/parameter>/);
                    if (vtec && vtec[1]) vtec = vtec[1];
                }
                
                // Cannot find VTEC in XML parameters. No VTEC, not an alert, or invalid message.
                if (!vtec) throw new Error('No VTEC found');
                
                // Split VTEC string into components
                var vtecObjects = (typeof vtec === 'string' ? vtec : vtec[0]).split('.');

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
                // No VTEC, or an error parsing VTEC
                nosyncLog(`Could not parse VTEC: ${err.message}, ignoring.`, 'DEBUG');
                if(!config.app?.silent_console) console.debug(`Could not parse VTEC: ${err.message}, ignoring.`);
                return;
            }

            // Whitelist filtering to only accept certain alert types
            var acceptPhenomena = config.nwws?.products || ['TO', 'SV'];

            // Check if the alert's phenomena code is whitelisted
            if (!acceptPhenomena.includes(thisObject.phenomena)) {
                if (!config.app?.silent_console) console.log('Ignoring non-whitelisted alert with phenomena code:', thisObject.phenomena);
                nosyncLog('Ignoring non-whitelisted alert with phenomena code: ' + thisObject.phenomena, 'DEBUG');
                return;
            }

            if (thisObject.product !== '/O') {
                if (!config.app?.silent_console) console.log('Ignoring non-operational product type:', thisObject.product);
                nosyncLog('Ignoring non-operational product type: ' + thisObject.product, 'DEBUG');
                return;
            }

            // Check what type of alert this is
            if (thisObject.actions === 'CAN' || thisObject.actions === 'EXP') {
                // This is a cancellation or expiration, delete the alert from the database
                try {
                    let alerts = [];
                    try {
                        // Read in existing alerts
                        const raw = fs.readFileSync('alerts.json', 'utf8');
                        alerts = raw.trim() ? JSON.parse(raw) : [];
                        if (!Array.isArray(alerts)) alerts = [];
                    } catch (readErr) {
                        console.error('Could not read alerts file during cancel/expire: ' + readErr.message);
                        nosyncLog('Could not read alerts file during cancel/expire: ' + readErr.message, 'ERROR');
                        return;
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
                        if (!config.app?.silent_console) console.log('Alert cancelled/expired and removed:', removedAlert.name);
                        nosyncLog(`${removedAlert.name} cancelled/expired and removed: `, 'INFO');
                    } else {
                        if (!config.app?.silent_console) console.warn('No matching alert found to cancel/expire.');
                        nosyncLog('No matching alert found to cancel/expire.', 'WARN');
                    }
                } catch (err) {
                    if (!config.app?.silent_console) console.error('Error updating alerts.json for cancellation/expiration:', err);
                    nosyncLog('Error updating alerts.json for cancellation/expiration: ' + err, 'ERROR');
                }
                return;
            } else if (thisObject.actions == 'UPG' ||
                thisObject.actions == 'COR' ||
                thisObject.actions == 'CON' ||
                thisObject.actions == 'EXT' ||
                thisObject.actions == 'EXA' ||
                thisObject.actions == 'EXB') {
                // Update, correction, or continuation
                // TODO: Implement update/correction logic
                console.log(`Alert action '${thisObject.actions}' detected - update/correction/continuation.`);
                // Preserve coordinates and other data not included with update.
                return;
            } else if (thisObject.actions == 'NEW') {
                // New alert, continue processing
                console.log(`Alert action '${thisObject.actions}' detected - new alert.`);
            } else{
                // Unknown action code
                if (!config.app?.silent_console) console.log('Ignoring alert with unknown action code:', thisObject.actions);
                nosyncLog('Ignoring alert with unknown action code: ' + thisObject.actions, 'DEBUG');
                return;
            }


            // Attempt to extract alert name
            var alertNameMatch = rawText.match(/BULLETIN.*?\s+(.*?)\s+National Weather Service/);
            var alertName = alertNameMatch ? alertNameMatch[1].trim() : null;

            // Alert name not found in message body, try XML parameter
            if (!alertName) {
                alertNameMatch = rawText.match(/<event>(.*?)<\/event>/);
                alertName = alertNameMatch ? alertNameMatch[1].trim() : null;
            }

            // Could not extract alert name
            if (!alertName) alertName = null;
                        

            // Attempt to extract received time
            var receivedTime = null;
            try {
                if (result.message.x && result.message.x[0] && result.message.x[0].$ && result.message.x[0].$.issued) {
                    receivedTime = result.message.x[0].$.issued;
                }
            } catch (err) {
                console.log('Could not extract received time');
            }


            // Attempt to extract lat/lon
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
                            if (Array.isArray(item) && item.length >= 2) {
                                return [Number(item[0]), Number(item[1])];
                            }
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
                if (config.nwws.require_coordinates) {
                    console.log('No coordinates found in alert, skipping...');
                    nosyncLog('No coordinates found in alert, skipping...', 'DEBUG');
                    return;
                }
            }

            // Verify we have valid coordinates after processing
            if (!coordinates || coordinates.length === 0) {
                if (config.nwws.require_coordinates) {
                    console.log('No valid coordinates after processing, skipping...');
                    nosyncLog('No valid coordinates after processing, skipping...', 'DEBUG');
                    return;
                }
            }


            // Message beautification
            // TODO: filter and parse messages with description and instruction tags
            var message = rawText.replace(/\n\n/g, '\n').replace(/\n/g, ' ');
            var idString = thisObject.product_type + thisObject.office + (Math.random() * 1000000).toFixed(0);
            var headline = null;
            try { headline = rawText.split('\n')[0].replace('BULLETIN - ', '').trim(); } catch {}


            // Format parsed result
            var parsedAlert = {
                name: alertName || null,
                id: idString || null,
                coordinates: coordinates || [],
                sender: thisObject.office || null,
                headline: headline || null,
                issued: thisObject.startTime || null,
                expiry: thisObject.endTime || null,
                message: message || null,
                properties: {
                    receivedTime: receivedTime,
                    vtec: thisObject,
                    product_type: thisObject.phenomena + thisObject.significance,
                    phenomena: thisObject.phenomena,
                    significance: thisObject.significance,
                    event_tracking_number: thisObject.eventTrackingNumber
                }
            };

            // Append the alert to alerts.json
            try {
                let alerts = [];
                try {
                    // Read in existing alerts
                    const raw = fs.readFileSync('alerts.json', 'utf8');
                    alerts = raw.trim() ? JSON.parse(raw) : [];
                    if (!Array.isArray(alerts)) alerts = [];
                } catch (readErr) {
                    // If the file is missing or malformed, start fresh
                    if (readErr.code !== 'ENOENT') {
                        console.warn('alerts.json unreadable, recreating file:', readErr.message);
                        nosyncLog('alerts.json unreadable, recreating file: ' + readErr.message, 'WARN');
                    }
                    alerts = [];
                }

                // Push the new alert
                alerts.push(parsedAlert);

                // Write back updated alerts
                fs.writeFileSync('alerts.json', JSON.stringify(alerts, null, 2));

                nosyncLog('Alert stored successfully: ' + parsedAlert.name, 'INFO');
            } catch (err) {
                if (!config.app?.silent_console) console.error('Error updating alerts.json for cancellation/expiration:', err);
                nosyncLog('Error updating alerts.json for cancellation/expiration: ' + err, 'ERROR');
            }
        });

    });

    // Event listener to catch errors
    xmpp.on('error', (err) => {        
        // Handle DNS/network errors with reconnection
        if (err.errno === -3001 || err.code === 'EAI_AGAIN' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
            if (!config.app?.silent_console) console.warn('Network error detected, attempting reconnection...');
            nosyncLog('Network error detected: ' + err.code + ' - Initiating reconnection.', 'WARN');
            handleReconnect();
            if (deleteExpiredAlertsInterval) {
                clearInterval(deleteExpiredAlertsInterval);
                deleteExpiredAlertsInterval = null;
            }
            return;
        } else {
            if (!config.app?.silent_console) console.error('XMPP reported unknown error:', err);
            nosyncLog('XMPP reported unknown error: ' + err.toString(), 'ERROR');
        }
    });

    // Event listener for offline event
    xmpp.on('offline', () => {
        nosyncLog("Connection offline.", 'WARN');
        if (!config.app?.silent_console) console.warn('XMPP connection offline.');
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
            nosyncLog('XMPP Authentication failed: Check your username and password.', 'ERROR');
            process.exit(1);
        }
        
        // Handle DNS/network errors with reconnection
        if (err.errno === -3001 || err.code === 'EAI_AGAIN' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
            console.error('Network/DNS error connecting to XMPP server:', err.message);
            nosyncLog('Network/DNS error: ' + err.message, 'ERROR');
            handleReconnect();
            return;
        }
        
        // Unknown error
        console.error('\nFailed to start XMPP client:', err);
        nosyncLog('Failed to start XMPP client: ' + err, 'ERROR');
        process.exit(1);
    }

})().catch(err => {
    console.error('\nAn unhandled error occurred:', err);
    nosyncLog('An unhandled error occurred: ' + err + ', restarting in 5 sec...', 'ERROR');
    console.log('Restarting in 5 seconds...');
    setTimeout(() => { }, 5000);
});


// Exports
module.exports = {
    start: async () => {},
    auth: (user, pass, conf) => {
        username = user;
        password = pass; 
        resource = conf?.nwws?.nickname || 'SparkAlerts NWWS Ingest Client';
        config = conf || {};
    }
};