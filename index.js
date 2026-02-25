/*
NWWS-OI XMPP INGEST CLIENT FOR SPARKRADAR.APP

(c) 2026 Tyler G - see LICENSE


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
const path = require('node:path');
const { log } = require('node:console');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
// CORS removed: handled at gateway or not required for this server
const crypto = require('crypto');
const { nosyncLog } = require('./logging.js');
const nwwsoi = require('./nwwsoi.js');

require('dotenv').config();

// Load configuration from config.json
const CONFIG_PATH = path.join(__dirname, 'config.json');
function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        console.error('No config.json file found. Check README.md for configuration setup.');
        process.exit(1);
    }
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        console.error(`config.json is invalid JSON: ${err.message}`);
        process.exit(1);
    }
}
const config = loadConfig();

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
}


// Set up the express webserver
const app = express();
const port = Number.isInteger(config.expressPort) ? config.expressPort : 8433;

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
const API_KEYS = (config.apiKeys && typeof config.apiKeys === 'object') ? config.apiKeys : {};
if (Object.keys(API_KEYS).length > 0) {
    console.log(`Loaded ${Object.keys(API_KEYS).length} API key(s) from config.json.`);
} else {
    console.log('No API keys configured.');
}

const ALLOW_NO_ORIGIN = config.allowNoOrigin === true;
if (!ALLOW_NO_ORIGIN && (!config.domainWhitelist || config.domainWhitelist.length === 0)) {
    console.error('You have no API keys, no whitelisted domains, and do not allow no-origin requests. You cannot access the API!');
}


// Function to generate HMAC signature for request verification
function generateSignature(apiKey, timestamp, method, path) {
    const hmac = crypto.createHmac('sha256', apiKey);
    const data = `${timestamp}${method}${path}`;
    return hmac.update(data).digest('hex');
}


// Parse domain whitelist once at startup
const DOMAIN_WHITELIST = Array.isArray(config.domainWhitelist)
    ? config.domainWhitelist.map(d => String(d).trim()).filter(Boolean)
    : [];
if (DOMAIN_WHITELIST.length > 0) {
    console.log(`Loaded ${DOMAIN_WHITELIST.length} whitelisted domain(s): ${DOMAIN_WHITELIST.join(', ')}`);
}
if (ALLOW_NO_ORIGIN) {
    console.log('No-origin requests are allowed.');
}

// Note: CORS is intentionally not configured here. If this API is behind
// a gateway or reverse proxy that must enforce CORS, configure it there.
// The request validation logic still enforces API key / signature checks.


// Rate limiter based on API key and/or IP
const apiRateLimiter = rateLimit({
    windowMs: (config.rateLimit && Number.isInteger(config.rateLimit.windowMs)) ? config.rateLimit.windowMs : 15 * 60, // 15 seconds
    max: (req) => {
        const apiKey = req.get('Authorization')?.split(' ')[1];
        const defaultMax = (config.rateLimit && Number.isInteger(config.rateLimit.defaultMax)) ? config.rateLimit.defaultMax : 30;
        return apiKey && API_KEYS[apiKey] ? API_KEYS[apiKey].rateLimit : defaultMax;
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

    // If allowNoOrigin=true then bypass domain whitelist and API key checks.
    // This allows development clients (local dev servers, file://, etc.) to fetch without auth.
    if (ALLOW_NO_ORIGIN) {
        nosyncLog(`ALLOW_NO_ORIGIN enabled — bypassing origin whitelist and auth for origin: ${origin || 'none'}`);
        console.log('✓ ALLOW_NO_ORIGIN active — request authorized without API key');
        return next();
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

// CORS enforcement: verify origin against whitelist and return proper headers.
function isOriginAllowed(origin) {
    if (!origin) return false;
    return DOMAIN_WHITELIST.some(domain => origin.includes(domain));
}

app.use((req, res, next) => {
    const origin = req.get('origin') || '';

    if (origin) {
        if (!isOriginAllowed(origin)) {
            nosyncLog(`CORS rejected origin: ${origin}`);
            return res.status(403).json({
                status: "ERROR",
                message: "Origin not allowed"
            });
        }

        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Request-Time,X-Signature');

        if (req.method === 'OPTIONS') return res.status(204).end();
    }

    next();
});

app.use(apiRateLimiter)


// Server-Sent Events (SSE) setup - manage subscribed clients
const sseClients = new Set();

function broadcastAlertToSSE(alertId, alertName) {
    const message = `data: ${JSON.stringify({ id: alertId, name: alertName })}\n\n`;
    sseClients.forEach(res => {
        try {
            res.write(message);
        } catch (err) {
            // Client disconnected, will be removed on close
        }
    });
}

// Expose broadcast function for nwwsoi.js to call
global.broadcastAlertToSSE = broadcastAlertToSSE;


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

// SSE endpoint - subscribe to alert notifications
app.get('/alerts/subscribe', validateRequest, (req, res) => {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Add this client to the broadcast list
    sseClients.add(res);
    console.log(`SSE client subscribed. Total subscribers: ${sseClients.size}`);
    nosyncLog(`SSE client subscribed. Total subscribers: ${sseClients.size}`);

    // Send a keep-alive comment every 30 seconds to detect disconnections
    const keepAliveInterval = setInterval(() => {
        try {
            res.write(': keep-alive\n\n');
        } catch (err) {
            // Client likely disconnected
            clearInterval(keepAliveInterval);
            sseClients.delete(res);
            res.end();
        }
    }, 30000);

    // Clean up on client disconnect
    res.on('close', () => {
        clearInterval(keepAliveInterval);
        sseClients.delete(res);
        console.log(`SSE client disconnected. Total subscribers: ${sseClients.size}`);
        nosyncLog(`SSE client disconnected. Total subscribers: ${sseClients.size}`);
    });

    res.on('error', (err) => {
        console.error('SSE error:', err);
        clearInterval(keepAliveInterval);
        sseClients.delete(res);
    });

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ status: "connected" })}\n\n`);
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
    (config.nwwsoi && config.nwwsoi.resource) ? config.nwwsoi.resource : undefined,
    (config.nwwsoi && Number.isInteger(config.nwwsoi.maxReconnectAttempts)) ? config.nwwsoi.maxReconnectAttempts : undefined,
    (config.nwwsoi && Number.isInteger(config.nwwsoi.initialReconnectDelay)) ? config.nwwsoi.initialReconnectDelay : undefined
);
nwwsoi.start();
