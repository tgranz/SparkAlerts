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

    // Task to clean up the alerts.json file
    async function deleteExpiredAlerts() {
        try {
            // Read in the database
            const data = JSON.parse(fs.readFileSync('alerts.json', 'utf8'));

            // If the alert is expired, remove it
            for (let alert of data) {
                let expiry = new Date(alert.expiry);
                let now = new Date();
                if (now > expiry) data.splice(data.indexOf(alert), 1);
            }

            // Write the cleaned database back to file
            fs.writeFile('alerts.json', JSON.stringify(data, null, 2), (err) => { });
        } catch (err) {
            log('Error in database cleanup:', err);
            console.error('Error in database cleanup:', err);
        }
    }

    // Run the deleteExpiredAlerts task every minute
    try {
        if (!deleteExpiredAlertsInterval) {
            deleteExpiredAlerts();
            deleteExpiredAlertsInterval = setInterval(deleteExpiredAlerts, 60 * 1000);
        }
    } catch (err) {}



    // Variable to store the interval ID so we can stop it if needed
    let deleteExpiredAlertsInterval = null;

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
        if (!stanza.is('message')) { return; }

        // The chat room sends this warning when a user joins, safely ignore it
        if (stanza.toString().includes("**WARNING**WARNING**WARNING**WARNING")) { return; }

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
                var vtec = rawText.match(/\/O\..*?\/\n?/);
                vtecObjects = vtec.split('.');

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

            // ================================================================================

            // Extract alert name
            var alertNameMatch = rawText.match(/BULLETIN.*?\s+(.*?)\s+National Weather Service/);
            var alertName = alertNameMatch ? alertNameMatch[1].trim() : null;

            // Extract recieved time
            var recievedTime = body.message.x[0].$.issued;

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
            var message = rawText.replace(/\n\n/g, '\n').replace(/\n/g, ' ');

            // Output parsed result
            var parsedAlert = {
                name: alertName,
                coordinates: coordinates,
                sender: thisObject.office,
                headline: rawText.split('\n')[0].replace('BULLETIN - ', '').trim(),
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

            // Append the alert to alerts.json
            try {
                let alertsData = fs.readFileSync('alerts.json', 'utf8');
                let alerts = JSON.parse(alertsData);
                alerts.push(parsedAlert);
                fs.writeFileSync('alerts.json', JSON.stringify(alerts, null, 2));
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
        if (err.toString().includes('not-authorized') || err.errno in [-3001, -101]) {
            console.error('XMPP Authentication failed: Check your username and password in the .env file.');
            log('XMPP Authentication failed: Check your username and password.');
            process.exit(1);
        }
        console.error('\nFailed to start XMPP client:', err);
        log('Failed to start XMPP client:' + err);
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