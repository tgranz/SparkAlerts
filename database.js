import fs from 'fs';

// Function to read the alert database
function readAlertDatabase() {
    try {
        const data = fs.readFileSync('alerts.json', 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') {
            fs.writeFileSync('alerts.json', JSON.stringify([]), 'utf8');
            return [];
        } else {
            throw new Error('Error reading alert database: ' + err.message);
        }
    }
}

function addNewAlert(alert) {
    try {
        const alerts = readAlertDatabase();
        alerts.push(alert);

        // No formatting to reduce file size
        fs.writeFileSync('alerts.json', JSON.stringify(alerts), 'utf8');
    } catch (err) {
        throw new Error('Error adding new alert: ' + err.message);
    }
}

function checkAndRemoveExpiredAlerts() {
    try {
        const alerts = readAlertDatabase();
        const now = new Date();

        // Filter out expired alerts
        const activeAlerts = alerts.filter(alert => {
            const expireTime = alert.expiresAt ? new Date(alert.expiresAt) : alert.vtec?.expireTime ? new Date(alert.vtec.expireTime) : null;
            if (!expireTime) return true; // If no expiration, keep it

            return expireTime > now;
        });

        // Write the updated list back to the database
        fs.writeFileSync('alerts.json', JSON.stringify(activeAlerts), 'utf8');
        console.log("Expired alert cleanup ran successfully.\n");
    } catch (err) {
        throw new Error('Error checking/removing expired alerts: ' + err.message);
    }
}

function deleteAlert(id, eventTrackingNumber) {
    // Try to find by ID, if not found, try to find by VTEC event tracking number
    try {
        const alerts = readAlertDatabase();
        let updatedAlerts = alerts.filter(alert => (alert.id !== 'null-null' && alert.id !== id) || (eventTrackingNumber && alert.vtec?.eventTrackingNumber !== eventTrackingNumber));

        if (updatedAlerts.length === alerts.length && eventTrackingNumber) {
            updatedAlerts = alerts.filter(alert => alert.vtec?.eventTrackingNumber !== eventTrackingNumber);
        }

        fs.writeFileSync('alerts.json', JSON.stringify(updatedAlerts), 'utf8');
    } catch (err) {
        throw new Error('Error deleting alert: ' + err.message);
    }
}

function updateAlert(eventTrackingNumber, updatedData) {
    // Always use ETC to identify alert
    try {
        const alerts = readAlertDatabase();
        let alertFound = false;

        const updatedAlerts = alerts.map(alert => {
            if (eventTrackingNumber && alert.vtec?.eventTrackingNumber === eventTrackingNumber) {
                alertFound = true;
                return { 
                    id: alert.id,
                    productCode: alert.productCode,
                    productName: alert.productName,
                    receivedAt: new Date().toISOString(),
                    expiresAt: updatedData.expiresAt || new Date(Date.now() + 3600000).toISOString(), // Default to 1 hour if no expiration provided
                    nwsOffice: updatedData.nwsOffice,
                    vtec: updatedData.vtec,
                    message: updatedData.message,
                    geometry: updatedData.geometry,
                    properties: {
                        isPds: updatedData.properties?.isPds || false,
                        isConsiderable: updatedData.properties?.isConsiderable || false,
                        isDestructive: updatedData.properties?.isDestructive || false,
                    }
                 };
            }
            return alert;
        });

        if (!alertFound) {
            throw new Error('Alert not found for update');
        }

        fs.writeFileSync('alerts.json', JSON.stringify(updatedAlerts), 'utf8');
    } catch (err) {
        throw new Error('Error updating alert: ' + err.message);
    }
}

// Export the database functions
export {
    readAlertDatabase,
    addNewAlert,
    checkAndRemoveExpiredAlerts,
    deleteAlert,
    updateAlert
};