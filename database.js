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

function deleteAlert(eventTrackingNumber) {
    try {
        if (!eventTrackingNumber) {
            throw new Error('Cannot delete alert: eventTrackingNumber is required');
        }

        const alerts = readAlertDatabase();
        const updatedAlerts = alerts.filter(alert => alert.vtec?.eventTrackingNumber !== eventTrackingNumber);

        if (updatedAlerts.length === alerts.length) {
            throw new Error(`Alert not found with eventTrackingNumber ${eventTrackingNumber}`);
        }

        fs.writeFileSync('alerts.json', JSON.stringify(updatedAlerts), 'utf8');
    } catch (err) {
        throw new Error('Error deleting alert: ' + err.message);
    }
}

function updateAlert(eventTrackingNumber, updatedData) {
    // Always use ETC to identify alert
    try {
        if (!eventTrackingNumber) {
            throw new Error('Cannot update alert: eventTrackingNumber is required');
        }

        const alerts = readAlertDatabase();
        let alertFound = false;

        const updatedAlerts = alerts.map(alert => {
            if (alert.vtec?.eventTrackingNumber === eventTrackingNumber) {
                alertFound = true;
                console.log(`Updating alert with eventTrackingNumber ${eventTrackingNumber}`);
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
            throw new Error(`Alert not found with eventTrackingNumber ${eventTrackingNumber}`);
        }

        fs.writeFileSync('alerts.json', JSON.stringify(updatedAlerts), 'utf8');
    } catch (err) {
        throw new Error('Error updating alert: ' + err.message);
    }
}

function cancelAlert(eventTrackingNumber, updatedData) {
    // Find alert by ETC
    try {
        if (!eventTrackingNumber) {
            throw new Error('Cannot cancel alert: eventTrackingNumber is required');
        }

        const alerts = readAlertDatabase();
        let alertFound = false;

        const updatedAlerts = alerts.map(alert => {
            if (alert.vtec?.eventTrackingNumber === eventTrackingNumber) {
                alertFound = true;
                console.log(`Cancelling alert with eventTrackingNumber ${eventTrackingNumber}`);
                return { 
                    id: alert.id,
                    productCode: alert.productCode,
                    productName: alert.productName,
                    receivedAt: alert.receivedAt,
                    expiresAt: alert.expiresAt,
                    nwsOffice: alert.nwsOffice,
                    vtec: updatedData.vtec,
                    message: updatedData.message + "\n\n" + alert.message, // Prepend cancellation message to original message
                    geometry: updatedData.geometry, // Use updated geometry
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
            throw new Error(`Alert not found with eventTrackingNumber ${eventTrackingNumber}`);
        }

        fs.writeFileSync('alerts.json', JSON.stringify(updatedAlerts), 'utf8');
    } catch (err) {
        throw new Error('Error canceling alert: ' + err.message);
    }
}

// Export the database functions
export {
    readAlertDatabase,
    addNewAlert,
    checkAndRemoveExpiredAlerts,
    deleteAlert,
    updateAlert,
    cancelAlert
};