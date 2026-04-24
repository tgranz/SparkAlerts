import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { readAlertDatabase, getProduct } from './database.js';
import { recordSubscribe, getAnalytics } from './utils/analytics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function normalizeOrigin(origin) {
    if (!origin || typeof origin !== 'string') return null;

    try {
        return new URL(origin).origin.toLowerCase();
    } catch {
        return origin.trim().toLowerCase().replace(/\/+$/, '');
    }
}

export default class API {
    constructor(port, options = {}) {
        this.port = port;
        this.sseClients = new Set(); // Track all SSE client state objects
        this.allowNoOrigin = options.allowNoOrigin ?? false;
        this.domainWhitelist = new Set((options.domainWhitelist || [])
            .map(normalizeOrigin)
            .filter(Boolean));

        this.app = express();
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, 'public'))); // Serve static files
        this.app.use((req, res, next) => {
            const requestOrigin = normalizeOrigin(req.headers.origin);
            const hasWhitelist = this.domainWhitelist.size > 0;
            const originAllowed = requestOrigin && this.domainWhitelist.has(requestOrigin);
            const noOriginAllowed = !requestOrigin && this.allowNoOrigin;

            if (hasWhitelist && !originAllowed && !noOriginAllowed) {
                return res.status(403).json({ error: 'Origin not allowed.' });
            }

            if (requestOrigin && (!hasWhitelist || originAllowed)) {
                res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
                res.setHeader('Vary', 'Origin');
            }

            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

            if (req.method === 'OPTIONS') {
                return res.sendStatus(204);
            }

            next();
        });

        // Status endpoint
        this.app.get('/', (req, res) => {
            res.json({ status: 'ok' });
        });

        // Dashboard endpoint
        this.app.get('/dashboard', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });

        // Endpoint to get all active alerts
        this.app.get('/alerts', (req, res) => {
            // Return all alerts from the database
            res.json({ alerts: readAlertDatabase() });
        });

        // Endpoint to subscribe to SSE stream
        this.app.get('/subscribe', (req, res) => {
            const toLog = req.query.log === 'true' ? true : false; // Default to false if not specified
            console.log('Subscribe hit; log subscribe event:', toLog);

            // Set up SSE headers
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');

            // Flush headers early so proxies and browsers treat this as a live stream immediately
            if (typeof res.flushHeaders === 'function') {
                res.flushHeaders();
            }

            // Instruct EventSource clients how quickly they should retry after disconnect
            res.write('retry: 5000\n\n');

            const heartbeatIntervalMs = 25000;
            const client = {
                res,
                heartbeat: null
            };

            const cleanupClient = () => {
                if (client.heartbeat) {
                    clearInterval(client.heartbeat);
                    client.heartbeat = null;
                }
                this.sseClients.delete(client);
            };

            // Add this client to the set
            this.sseClients.add(client);

            // Keep the connection alive with a comment
            res.write(':connected\n\n');

            // Keep stream alive through proxies/load balancers that close idle HTTP connections
            client.heartbeat = setInterval(() => {
                if (res.writableEnded || res.destroyed) {
                    cleanupClient();
                    return;
                }

                try {
                    res.write(`:heartbeat ${Date.now()}\n\n`);
                } catch {
                    cleanupClient();
                }
            }, heartbeatIntervalMs);

            // Record successful subscribe event
            if (toLog) recordSubscribe();

            // Remove client on disconnect
            req.on('close', cleanupClient);
            res.on('close', cleanupClient);
            res.on('error', cleanupClient);
        });

        this.app.get('/product/:code', (req, res) => {
            const code = req.params.code;
            switch (code) {
                case 'COD':
                    try {
                        const productData = getProduct(code.toLowerCase());
                        res.json(productData);
                    } catch (err) {
                        res.status(404).json({ error: err.message });
                    }
                    break;
                default:
                    res.status(404).json({ error: 'Product not supported or unavailable.' });
            }
        });
        

        // Endpoint to get analytics data (subscribe events by day for last 30 days)
        this.app.get('/analytics', (req, res) => {
            res.json(getAnalytics());
        });

        // Endpoint to get current connections
        this.app.get('/connections', (req, res) => {
            res.json({ connections: this.sseClients.size });
        });

        this.app.listen(this.port, () => {
            console.log(`API server running on http://localhost:${this.port}`);
        });
    }

    // Function that triggers a SSE:NEW event
    // Indicates a new alert has been added to the database
    triggerNewAlertEvent(alert) {
        if (!alert) {
            console.warn('API: triggerNewAlertEvent called with no alert data');
            return;
        }
        this._broadcastEvent('NEW', alert);
    }

    // Function that triggers a SSE:UPDATE event
    // Indicates the database has changed but no new alert has been added
    triggerUpdateAlertEvent(alert) {
        if (!alert) {
            console.warn('API: triggerUpdateAlertEvent called with no alert data');
            return;
        }
        this._broadcastEvent('UPDATE', alert);
    }

    _broadcastEvent(eventType, data) {
        if (!data) {
            console.error(`API: Cannot broadcast ${eventType} event with null/undefined data`);
            return;
        }

        let jsonData;
        try {
            jsonData = JSON.stringify(data);
        } catch (err) {
            console.error(`API: Failed to stringify ${eventType} event data:`, err.message);
            return;
        }

        const message = `event: ${eventType}\ndata: ${jsonData}\n\n`;
        
        // Send to all connected SSE clients
        let successCount = 0;
        this.sseClients.forEach(client => {
            const response = client.res;

            if (!response || response.writableEnded || response.destroyed) {
                this.sseClients.delete(client);
                return;
            }

            try {
                response.write(message);
                successCount++;
            } catch (err) {
                // Client disconnected, remove it
                this.sseClients.delete(client);
            }
        });

        if (successCount > 0) {
            console.log(`API: Broadcasted ${eventType} event to ${successCount} client(s)`);
        }
    }
}