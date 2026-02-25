/*
Alert Database Operations

Functions for managing the alerts.json database file.
*/

const fs = require('fs');
const { log } = require('../logging.js');

const ALERTS_FILE = 'alerts.json';

/**
 * Load alerts from alerts.json file
 * @returns {Array} Array of alert objects
 */
function loadAlerts() {
    try {
        const raw = fs.readFileSync(ALERTS_FILE, 'utf8');
        const alerts = raw.trim() ? JSON.parse(raw) : [];
        return Array.isArray(alerts) ? alerts : [];
    } catch (readErr) {
        if (readErr.code !== 'ENOENT') {
            console.warn(`${ALERTS_FILE} unreadable:`, readErr.message);
        }
        return [];
    }
}

/**
 * Save alerts to alerts.json file
 * @param {Array} alerts - Array of alert objects
 */
function saveAlerts(alerts) {
    try {
        fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
    } catch (err) {
        console.error(`Error saving ${ALERTS_FILE}:`, err);
        log(`Error saving ${ALERTS_FILE}: ` + err);
        throw err;
    }
}

/**
 * Delete expired alerts from the database
 * @returns {number} Number of alerts removed
 */
function deleteExpiredAlerts() {
    console.log('Running expired alerts cleanup...');
    try {
        let alerts = loadAlerts();
        if (alerts.length === 0) {
            console.log('No alerts to clean up.');
            return 0;
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
            saveAlerts(alerts);
            console.log(`Expired alerts cleanup: removed ${removedCount} alert(s).`);
            log(`Expired alerts cleanup: removed ${removedCount} alert(s).`);
        } else {
            console.log('Expired alerts cleanup: no expired alerts found.');
        }
        
        return removedCount;
    } catch (err) {
        log('Error in database cleanup: ' + err);
        console.error('Error in database cleanup:', err);
        return 0;
    }
}

/**
 * Apply startup filter to remove duplicate alerts
 * Keeps only the latest alert for each ID
 */
function applyStartupFilter() {
    try {
        let alerts = loadAlerts();
        if (alerts.length === 0) {
            console.log('No alerts to filter.');
            return;
        }

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
        
        saveAlerts(filteredAlerts);
        console.log('Startup alert filter applied.');
    } catch (err) {
        console.error('Error during startup alert filter:', err);
    }
}

/**
 * Add or update alerts in the database
 * @param {Array} parsedAlerts - Array of alert objects to add/update
 */
function upsertAlerts(parsedAlerts) {
    try {
        let alerts = loadAlerts();

        // For each parsedAlert, remove any existing alert with the same id, then add the new one
        parsedAlerts.forEach(parsedAlert => {
            if (!parsedAlert || !parsedAlert.id) {
                console.warn('Skipping alert with no ID');
                return;
            }

            // Remove existing alert(s) with same ID
            alerts = alerts.filter(a => a.id !== parsedAlert.id);

            // Add the new alert
            alerts.push(parsedAlert);
            console.log(`Added/updated alert: ${parsedAlert.name} (${parsedAlert.id})`);

            // Broadcast to SSE clients if available
            if (typeof global.broadcastAlertToSSE === 'function') {
                global.broadcastAlertToSSE(parsedAlert);
            }
        });

        saveAlerts(alerts);
    } catch (err) {
        console.error('Error updating alerts.json:', err);
        log('Error updating alerts.json: ' + err);
        throw err;
    }
}

/**
 * Delete alert by ID
 * @param {string} alertId - Alert ID to delete
 * @returns {boolean} True if alert was found and deleted
 */
function deleteAlertById(alertId) {
    try {
        let alerts = loadAlerts();
        const initialCount = alerts.length;
        
        alerts = alerts.filter(a => a.id !== alertId);
        
        if (alerts.length < initialCount) {
            saveAlerts(alerts);
            console.log(`Deleted alert: ${alertId}`);
            return true;
        }
        
        return false;
    } catch (err) {
        console.error('Error deleting alert:', err);
        log('Error deleting alert: ' + err);
        return false;
    }
}

module.exports = {
    loadAlerts,
    saveAlerts,
    deleteExpiredAlerts,
    applyStartupFilter,
    upsertAlerts,
    deleteAlertById
};
