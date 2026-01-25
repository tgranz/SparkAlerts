/*
NWWS-OI XMPP INGEST CLIENT FOR SPARKRADAR.APP

(c) 2024 Tyler Granzow - not to be used without permission


WARNING from the NWWS-OI system:
**WARNING**WARNING**WARNING**WARNING**WARNING**WARNING**WARNING**WARNING**

This code connects to a United States Federal Government computer system,
which may be accessed and used only for official Government business by
authorized personnel.  Unauthorized access or use of the computer system
may subject violators to criminal, civil, and/or administrative action.

All information on the computer system may be intercepted, recorded,
read, copied, and disclosed by and to authorized personnel for official
purposes, including criminal investigations. Access or use of the
computer system by any person whether authorized or unauthorized,
varITUTES CONSENT to these terms.

**WARNING**WARNING**WARNING**WARNING**WARNING**WARNING**WARNING**WARNING**

*/


// Imports
var { match } = require('assert');
var { json } = require('stream/consumers');
const fs = require('node:fs');
const { log } = require('node:console');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const cors = require('cors');
const crypto = require('crypto');
const { nosyncLog } = require('./logging.js');
const nwwsoi = require('./nwwsoi.js');

require('dotenv').config();

// Run a check to ensure the required environment variables are set
if (!fs.existsSync('.env')) {
    console.error('No .env file found. Check https://github.com/tgranz/SparkAlerts?tab=readme-ov-file#environment-setup for details.');
    process.exit(1);
}
if (!process.env.XMPP_USERNAME) {
    console.error('.env file is missing XMPP_USERNAME variable. Check https://github.com/tgranz/SparkAlerts?tab=readme-ov-file#environment-setup for details.');
    process.exit(1);
} else if (!process.env.XMPP_PASSWORD) {
    console.error('.env file is missing XMPP_PASSWORD variable. Check https://github.com/tgranz/SparkAlerts?tab=readme-ov-file#environment-setup for details.');
    process.exit(1);
} else if (!process.env.ALLOW_NO_ORIGIN) {
    console.error('.env file is missing ALLOW_NO_ORIGIN variable. Check https://github.com/tgranz/SparkAlerts?tab=readme-ov-file#environment-setup for details.');
    process.exit(1);
}


// Set up the express webserver
const app = express();
var port = 8433;
if (process.env.EXPRESS_PORT) {
    var port = parseInt(process.env.EXPRESS_PORT);
}

// API keys configuration
/*format:

aaa: {
    name: 'Development API Key',
    rateLimit: 100, // requests per window
    whitelist: [], // allowed IPs/domains
    lastUsed: null,
    active: true
}

*/
let API_KEYS = {};
if (process.env.API_KEYS_JSON) {
    try {
        API_KEYS = JSON.parse(process.env.API_KEYS_JSON);
        console.log(`Loaded ${Object.keys(API_KEYS).length} API key(s) from environment.`);
    } catch (e) {
        console.warn('API_KEYS contains invalid JSON! Error:', e.message);
    }
} else {
    console.log('No API keys configured.');
}

if (!process.env.ALLOW_NO_ORIGIN && process.env.DOMAIN_WHITELIST == null) {
    console.error('You have no API keys, no whitelisted domains, and do not allow no-origin requests. You cannot access the API!');
}


// Function to generate HMAC signature for request verification
function generateSignature(apiKey, timestamp, method, path) {
    const hmac = crypto.createHmac('sha256', apiKey);
    const data = `${timestamp}${method}${path}`;
    return hmac.update(data).digest('hex');
}


// Parse domain whitelist once at startup
const DOMAIN_WHITELIST = process.env.DOMAIN_WHITELIST ? process.env.DOMAIN_WHITELIST.split(',').map(d => d.trim()) : [];
if (DOMAIN_WHITELIST.length > 0) {
    console.log(`Loaded ${DOMAIN_WHITELIST.length} whitelisted domain(s): ${DOMAIN_WHITELIST.join(', ')}`);
}
if (process.env.ALLOW_NO_ORIGIN === 'true') {
    console.log('No-origin requests are allowed.');
}

// CORS configuration
const corsOptions = {
    origin: function (origin, callback) {
        
        if (process.env.ALLOW_NO_ORIGIN === 'true') { 
            // Some browsers send the string 'null' as the Origin header
            // when the page is loaded from a local file or sandboxed context.
            if (!origin || origin == '' || origin === 'null') {
                console.log('CORS: Allowing no-origin request');
                return callback(null, true);
            }
        }
        
        // Allow requests from whitelisted origins
        for (const domain of DOMAIN_WHITELIST) {
            if (origin && origin.includes(domain)) {
                console.log(`CORS: Allowing whitelisted origin: ${origin}`);
                return callback(null, true);
            }
        }
        
        // For other origins, we'll validate their API key and signature in the request handler
        // Deny CORS here for non-whitelisted origins so browsers enforce restrictions.
        console.log(`CORS: Denying CORS for non-whitelisted origin: ${origin}`);
        return callback(null, false);
    },

    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Time', 'X-Signature', 'X-Requested-With'],
    credentials: true,
    optionsSuccessStatus: 204
};


// Rate limiter based on API key and/or IP
const apiRateLimiter = rateLimit({
    windowMs: 15 * 60, // 15 seconds
    max: (req) => {
        const apiKey = req.get('Authorization')?.split(' ')[1];
        return apiKey && API_KEYS[apiKey] ? API_KEYS[apiKey].rateLimit : 30;
    },
    keyGenerator: (req) => {
        const apiKey = req.get('Authorization')?.split(' ')[1] || '';
        return `${apiKey}_${ipKeyGenerator(req)}`;
    },
    message: { 
        status: "ERROR", 
        message: "Rate limit exceeded. Please slow down your requests." 
    }
});


// Combined origin and token check middleware
const validateRequest = (req, res, next) => {
    const origin = req.get('origin') || req.get('referer') || '';
    const authHeader = req.get('Authorization');
    const timestamp = req.get('X-Request-Time');
    const signature = req.get('X-Signature');
    
    console.log(`[${req.method}] ${req.path} - Origin: ${origin || 'none'}`);
    
    // Allow requests from whitelisted domains
    for (const domain of DOMAIN_WHITELIST) {
        if (origin && origin.includes(domain)) {
            nosyncLog(`Authorized access from whitelisted domain: ${origin}`);
            console.log(`✓ Whitelisted domain authorized: ${domain}`);
            return next();
        }
    }

    // Allow requests with no origin if configured
    if (process.env.ALLOW_NO_ORIGIN === 'true') {
        // Accept the literal 'null' value as a no-origin request as some
        // browsers (or file:// contexts) send Origin: null.
        if (origin == '' || origin === 'null' || !origin) {
            nosyncLog(`Authorized access with no origin.`);
            console.log('✓ No-origin request authorized');
            return next();
        }
    }

    // For non-whitelisted origins, require api key
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        nosyncLog(`Missing or invalid Authorization header from: ${origin}`);
        console.log(`✗ Auth failed: Missing or invalid Authorization header`);
        return res.status(401).json({
            status: "ERROR",
            message: "Missing or invalid 'Authorization' header"
        });
    }

    const apiKey = authHeader.split(' ')[1];
    const keyConfig = API_KEYS[apiKey];
    console.log(`Validating API key: ${apiKey.substring(0, 8)}...`);

    // Validate API key
    if (!keyConfig || !keyConfig.active) {
        nosyncLog(`Invalid or inactive API key from: ${origin}`);
        console.log(`✗ Auth failed: Invalid or inactive API key`);
        return res.status(401).json({
            status: "ERROR",
            message: "Invalid or inactive API key"
        });
    }

    // Validate timestamp (within 5 minutes)
    if (!timestamp || Math.abs(Date.now() - parseInt(timestamp)) > 300000) {
        nosyncLog(`Invalid or expired timestamp from: ${origin}`);
        console.log(`✗ Auth failed: Invalid or expired timestamp`);
        return res.status(401).json({
            status: "ERROR",
            message: "Request timestamp invalid or expired"
        });
    }

    // Validate signature
    const expectedSignature = generateSignature(apiKey, timestamp, req.method, req.path);
    if (!signature || signature !== expectedSignature) {
        nosyncLog(`Invalid signature from: ${origin}`);
        console.log(`✗ Auth failed: Invalid signature`);
        return res.status(401).json({
            status: "ERROR",
            message: "Invalid request signature"
        });
    }

    // Update key usage metadata
    keyConfig.lastUsed = Date.now();
    
    // Request is authenticated
    nosyncLog(`Authorized access with valid API key from: ${origin}`);
    console.log(`✓ API key authorized: ${keyConfig.name || 'Unnamed key'}`);
    next();
};


// Apply middleware
app.use(express.json());
app.use(cors(corsOptions));
app.use(apiRateLimiter)


// Ping endpoint - for uptime monitoring (no auth)
app.get('/ping', (req, res) => {
    res.status(200).send({ status: "OK" });
});

// Apply validateRequest only to protected routes
// Home route - for authorization testing
app.get('/', validateRequest, (req, res) => {
    res.status(200).send({ status: "AUTHORIZED" });
});

// The main endpoint - get alerts
app.get('/alerts', validateRequest, async (req, res) => {
    try {
        var alerts = [];
        try{
            const data = await fs.promises.readFile('alerts.json', 'utf8');
            alerts = JSON.parse(data);
            console.log(`Loaded ${alerts.length} alert(s) from alerts.json`);
        } catch (err) {
            console.log('No alerts.json file found or empty, returning empty array');
            alerts = [];
        }

        console.log(`Responding with ${alerts.length} alert(s)`);
        res.status(200).send({ 
            status: "OK",
            count: alerts.length,
            alerts: alerts 
        });

    } catch (err) {
        console.error('Error handling alerts request:', err);
        nosyncLog(`Error serving alerts: ${err.message}`);
        res.status(500).send({ 
            status: "ERROR", 
            message: "Internal server error while retrieving alerts.",
            extra_info: err.message.toString() 
        });
    }
});

// 404 for requests to nonexistent endpoints
app.use((req, res, next) => {
    res.status(404).send({ 
        status: "ERROR", 
        message: "Not found" 
    });
});

// Other internal error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    nosyncLog(`Unhandled error: ${err.message}`);
    res.status(500).send({ 
        status: "ERROR", 
        message: "Internal server error",
        extra_info: err.message.toString()
    });
});


// Start the server
app.listen(port, () => {
    console.log(`API is now running at http://localhost:${port}`);
    nosyncLog(`API is now running at http://localhost:${port}`);
});

// Start the NWWS-OI XMPP client
nwwsoi.auth(
    process.env.XMPP_USERNAME,
    process.env.XMPP_PASSWORD,
    process.env.XMPP_RESOURCE,
    process.env.MAX_RECONNECT_ATTEMPTS,
    process.env.INITIAL_RECONNECT_DELAY
);
nwwsoi.start();