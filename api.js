import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { readAlertDatabase, getProduct } from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default class API {
    constructor(port) {
        this.port = port;
        this.sseClients = new Set(); // Track all SSE connections

        this.app = express();
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, 'public'))); // Serve static files

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
            // Set CORS header to allow cross-origin requests
            res.setHeader('Access-Control-Allow-Origin', '*');
            // Return all alerts from the database
            res.json({ alerts: readAlertDatabase() });
        });

        // Endpoint to subscribe to SSE stream
        this.app.get('/subscribe', (req, res) => {
            // Set up SSE headers
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('Access-Control-Allow-Origin', '*');

            // Add this client to the set
            this.sseClients.add(res);

            // Keep the connection alive with a comment
            res.write(':connected\n\n');

            // Remove client on disconnect
            req.on('close', () => {
                this.sseClients.delete(res);
            });
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
        

        // Endpoint to get the number of active SSE clients
        this.app.get('/connections', (req, res) => {
            res.json({ count: this.sseClients.size });
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
            try {
                client.write(message);
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