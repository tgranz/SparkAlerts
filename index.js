// Import components
import NWWSOI from "./nwwsoi.js";
import API from "./api.js";
import { checkAndRemoveExpiredAlerts } from './database.js';

// Import configuration from config.json file
import fs from 'fs';
let config;
try { config = JSON.parse(fs.readFileSync('./config.json', 'utf8')); }
catch (err) { console.error('Error loading config.json:', err.message); process.exit(1); }

// Start API server
const apiServer = new API(config?.api?.port || 3000);

// Start the NWWSOI client listener
const nwwsoiClient = new NWWSOI(config?.products || {}, { onNew: () => apiServer.triggerNewAlertEvent(), onUpdate: () => apiServer.triggerUpdateAlertEvent() });

// Check for expired alerts every 30 seconds
setInterval(() => {
    try {
        checkAndRemoveExpiredAlerts();
    } catch (err) {
        console.error('Error checking/removing expired alerts:', err.message);
    }
}, 30 * 1000);