/*
NWWS-OI XMPP INGEST CLIENT: SPARKALERTS
Licensed under the Apache License, Version 2.0 (the "License")
All redistributions of this code must retain the LICENSE file and the copyright below.

(c) 2026 Tyler Granzow


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
varieties CONSENT to these terms.

**WARNING**WARNING**WARNING**WARNING**WARNING**WARNING**WARNING**WARNING**

*/


// ========== IMPORTS AND INITIALIZATION ==========
// Imports
const fs = require('node:fs');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { nosyncLog, setLogLevel } = require('./logging.js');
const nwwsoi = require('./nwwsoi.js');

// Load environment variables from .env file
require('dotenv').config();

// Load configuration JSON file
let config = {};
try {
    const conf = fs.readFileSync('config.json');
    config = JSON.parse(conf);
    if (!config.app?.silent_console || true) console.log('Loaded configuration from config.json');
    setLogLevel(config.app?.log_level || 'WARN');
} catch (e) {
    console.error('Failed to load configuration from config.json.\nThe file may not exist or may contain invalid JSON.');
    process.exit(1);
}

// Resolve credentials (prefer explicit NWWS_* names, then USERNAME/USER)
const xmppUser = process.env.XMPP_USERNAME || null;
const xmppPass = process.env.XMPP_PASSWORD || null;

// Run a check to ensure the XMPP credentials are set
if (!fs.existsSync('.env')) {
    console.error('No .env file found. Check https://github.com/tgranz/SparkAlerts?tab=readme-ov-file#environment-setup for details.');
    process.exit(1);
}
if (!xmppUser) {
    console.error('.env file is missing XMPP_USERNAME variable.');
    process.exit(1);
} else if (!xmppPass) {
    console.error('.env file is missing XMPP_PASSWORD variable.');
    process.exit(1);
}

// Load API keys from config
let API_KEYS = [];
if (!config.api?.disable_keys) {
    API_KEYS = Array.isArray(config.api?.keys) ? config.api.keys : [];
    if (!config.api?.silent_console) {
        console.log(`Loaded ${API_KEYS.length} API key(s) from configuration.`);
        if (config.security?.allow_no_origin) {
            console.warn("WARNING: Requests with no origin are still allowed. API key is still required for null origins.");
        } else {
            console.warn("Requests with no origin are NOT allowed, even with a valid API key.");
            if (config.security?.allowed_origins?.length < 1) {
                console.warn("No whitelisted domains are set. Each request must have a valid API key.")
            } else {
                console.warn("WARNING: Requests from whitelisted domains are allowed, even without an API key!");
            }
        }
    }
} else {
    if (!config.api?.silent_console) {
        console.log('API key validation disabled.');
        if (config.security?.allow_no_origin) {
            console.warn("WARNING: Requests with no origin are still allowed. API key is still required for null origins.");
            if (config.security?.allowed_origins?.length < 1) {
                console.warn("WARNING: No whitelisted domains are set. Origin must be null to access API")
            } else {
                console.log("Requests from whitelisted domains are allowed.");
            }
        } else {
            console.warn("Requests with no origin are NOT allowed.");
            if (config.security?.allowed_origins?.length < 1) {
                console.error("ERROR: No whitelisted domains are set. You have no way to access the API!")
                process.exit(1);
            } else {
                console.log("Requests from whitelisted domains are allowed.");
            }
        }
    }
}


// ========== SETUP ==========
// Setup logging level
setLogLevel(config.app?.log_level || 'WARN');

// Set up the express webserver
const app = express();
var port = config.api?.port || 8080;

// CORS configuration (custom to avoid duplicate Access-Control-Allow-Origin)
const resolveCorsOrigin = (origin) => {
    if (!origin || origin === '' || origin === 'null') {
        nosyncLog('Request origin is NULL or empty.', "DEBUG");
        if (!config.security?.allow_no_origin) {
            return false;
        }
        return origin === 'null' ? 'null' : null;
    }

    for (const domain of config.security?.allowed_origins || []) {
        if (origin.includes(domain)) {
            nosyncLog(`Allowing request from ${origin} as per configuration.`, "DEBUG");
            return origin;
        }
    }

    nosyncLog(`Denying CORS for non-whitelisted origin: ${origin}`, "DEBUG");
    return false;
};

const corsMiddleware = (req, res, next) => {
    const origin = req.get('origin') || '';
    const allowedOrigin = resolveCorsOrigin(origin);

    if (allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader(
            'Access-Control-Allow-Headers',
            'Content-Type, Authorization, X-Request-Time, X-Signature, X-Requested-With'
        );
    }

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    return next();
};

// Configure rate limiting
const apiRateLimiter = rateLimit({
    windowMs: config.api?.rate_window_ms || 60000,
    max: (req) => {
        const apiKey = req.get('Authorization')?.split(' ')[1];
        // If key validation is disabled or no API key provided, use default rate limit
        if (config.api?.disable_keys || !apiKey) {
            return config.api?.rate_limit || 100;
        }
        // If API key is provided and keys are enabled, use per-key rate limit
        return config.api?.key_rate_limit || 1000;
    },
    keyGenerator: (req) => {
        const apiKey = req.get('Authorization')?.split(' ')[1] || req.query.apikey || '';
        return `${apiKey}_${ipKeyGenerator(req)}`;
    },
    message: { 
        status: "ERROR", 
        message: "Rate limit exceeded. Please slow down your requests." 
    }
});

// Main validation check middleware
const validateRequest = (req, res, next) => {
    const origin = req.get('origin') || req.get('referer') || '';
    const authHeader = req.get('Authorization');
    const timestamp = req.get('X-Request-Time');

    // First check if the request has no origin
    if (!origin || origin == '' || origin === 'null') {
        nosyncLog('Request origin is NULL or empty.', "DEBUG");
        if (config.security?.allow_no_origin) {
            nosyncLog('Allowing no-origin request as per configuration.', "DEBUG");
            return next();
        } else {
            nosyncLog('Denying no-origin request as per configuration.', "DEBUG");
            return res.status(403).json({
                status: "ERROR",
                message: "CORS policy: No origin not allowed"
            });
        }
    }
    
    // Origin is not null or empty, check against whitelist
    // Allow requests from whitelisted origins
    for (const domain of config.security?.allowed_origins || []) {
        if (origin && origin.includes(domain)) {
            nosyncLog(`Allowing request from ${origin} as per configuration.`, "DEBUG");
            return next();
        }
    }

    // For non-whitelisted origins, check if API keys are disabled
    if (config.api?.disable_keys) {
        nosyncLog(`API key validation is disabled, but origin ${origin} is not whitelisted.`, "DEBUG");
        return res.status(403).json({
            status: "ERROR",
            message: "403 Forbidden"
        });
    }

    // API keys are enabled, require authorization
    let apiKey = null;
    
    // Try Authorization header first
    if (authHeader && authHeader.startsWith('Bearer ')) {
        apiKey = authHeader.split(' ')[1];
    } else if (req.query.apikey) {
        // Fall back to URL query parameter
        apiKey = req.query.apikey;
    }
    
    if (!apiKey) {
        nosyncLog(`Missing or invalid Authorization header/apikey from origin: ${origin}`, "DEBUG");
        return res.status(401).json({
            status: "ERROR",
            message: "Missing or invalid 'Authorization' header or 'apikey' query parameter"
        });
    }
    
    nosyncLog(`Validating API key: ${apiKey.substring(0, 4)}...`, "DEBUG");

    // Check if API key is in the list
    if (!API_KEYS.includes(apiKey)) {
        nosyncLog(`Invalid API key from: ${origin}`, "DEBUG");
        return res.status(401).json({
            status: "ERROR",
            message: "Invalid API key"
        });
    }

    // Validate timestamp (within 5 minutes)
    if (!timestamp || Math.abs(Date.now() - parseInt(timestamp)) > 300000) {
        nosyncLog(`Invalid or expired timestamp from: ${origin}`, "DEBUG");
        return res.status(401).json({
            status: "ERROR",
            message: "Request timestamp invalid or expired"
        });
    }
    
    // Request is authenticated
    nosyncLog(`Authorized access with valid API key from: ${origin}`, "DEBUG");
    next();
};

// Apply middleware in order
app.use(express.json());
app.use(corsMiddleware);
app.use(apiRateLimiter)


// ========== ENDPOINTS ==========
// Ping endpoint - for uptime monitoring
app.get('/ping', (req, res) => {
    res.status(200).send({ status: "OK" });
});

// Home route - for authorization testing or a homepage
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

        res.status(200).send({ 
            status: "OK",
            count: alerts.length,
            alerts: alerts 
        });

    } catch (err) {
        if (!config.app.silent_console) console.warn('Error handling alerts request:', err);
        nosyncLog(`Error serving alerts: ${err.message}`, "ERROR");
        res.status(500).send({ 
            status: "ERROR", 
            message: "Internal server error while retrieving alerts."
        });
    }
});

// 404 for requests to nonexistent endpoints
app.use((req, res, next) => {
    res.status(404).send({ 
        status: "ERROR", 
        message: "Route not found" 
    });
});


// ========== START SERVER ===========
// Express error handling
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    nosyncLog(`Unhandled error: ${err.message}`, "ERROR");
    res.status(500).send({ 
        status: "ERROR", 
        message: "Internal server error"
    });
});

// Start the server
app.listen(port, () => {
    if (!config.app.silent_console) console.log(`API is now accessible at http://localhost:${port}`);
    nosyncLog(`API (re)started, accessible at http://localhost:${port}`, "INFO");
});

// Authenticate and start the NWWS-OI XMPP client
nwwsoi.auth(
    xmppUser,
    xmppPass,
    config
);
nwwsoi.start();