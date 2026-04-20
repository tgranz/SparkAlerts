import fs from 'fs';

function _formatAlertIdentity(identity) {
    if (!identity) {
        return 'null';
    }

    if (typeof identity === 'string') {
        return identity;
    }

    const officeId = identity.officeId || '?';
    const phenomena = identity.phenomena || '?';
    const significance = identity.significance || '?';
    const eventTrackingNumber = identity.eventTrackingNumber || '?';

    return `${officeId}.${phenomena}.${significance}.${eventTrackingNumber}`;
}

function _getUpdatedProps(updatedMessage) {
    // Cancellation mesesages have no props
    // Thus, a PDS tornado warning for example may appear downgraded
    // We need to ignore cancellation messages for props
    const messages = updatedMessage.split('#####');
    // Loop until latest non-cancellation message
    let latestMessageForProps = '';
    for (let i = messages.length - 1; i >= 0; i--) {
        const thisMessage = messages[i].trim();
        if (thisMessage) {
            if (thisMessage.toLowerCase().includes('has been cancelled')){
                continue; // Skip cancellation messages
            } else {
                // This is the latest non-cancellation message, use it for properties
                latestMessageForProps = thisMessage;
                break;
            }
        }
    }

    return {
        isPds: latestMessageForProps.toLowerCase().includes('particularly dangerous situation') || false,
        isConsiderable: latestMessageForProps.toLowerCase().includes('thunderstorm damage threat...considerable') || false,
        isDestructive: latestMessageForProps.toLowerCase().includes('thunderstorm damage threat...destructive') || false,
        isEmergency: latestMessageForProps.toLowerCase().includes('tornado emergency') || latestMessageForProps.toLowerCase().includes('flash flood emergency') || false,
        isTorPossible: latestMessageForProps.toLowerCase().includes('tornado...possible') || false,
        isWaterspoutPossible: latestMessageForProps.toLowerCase().includes('waterspout...possible') || false,
    };
}

function _isMatchingAlert(alert, identity) {
    if (!identity) {
        return false;
    }

    const alertVtec = alert?.vtec;
    if (!alertVtec) {
        return false;
    }

    if (typeof identity === 'string') {
        return alertVtec.eventTrackingNumber === identity;
    }

    return (
        alertVtec.eventTrackingNumber === identity.eventTrackingNumber &&
        alertVtec.officeId === identity.officeId &&
        alertVtec.phenomena === identity.phenomena &&
        alertVtec.significance === identity.significance
    );
}

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

function deleteAlert(alertIdentity) {
    try {
        if (!alertIdentity) {
            throw new Error('Cannot delete alert: alert identity is required');
        }

        const alerts = readAlertDatabase();
        const updatedAlerts = alerts.filter(alert => !_isMatchingAlert(alert, alertIdentity));

        if (updatedAlerts.length === alerts.length) {
            throw new Error(`Alert not found with identity ${_formatAlertIdentity(alertIdentity)}`);
        }

        fs.writeFileSync('alerts.json', JSON.stringify(updatedAlerts), 'utf8');
    } catch (err) {
        throw new Error('Error deleting alert: ' + err.message);
    }
}

function updateAlert(alertIdentity, updatedData) {
    // Use VTEC identity to identify alert
    try {
        if (!alertIdentity) {
            throw new Error('Cannot update alert: alert identity is required');
        }

        const alerts = readAlertDatabase();
        let alertFound = false;

        const updatedAlerts = alerts.map(alert => {
            if (_isMatchingAlert(alert, alertIdentity)) {
                alertFound = true;
                console.log(`Updating alert with identity ${_formatAlertIdentity(alertIdentity)}`);

                const updatedMessage = updatedData.message + "\n\n#####\n\n" + (alert.message || ''); // Prepend update message to original message

                const updatedProps = _getUpdatedProps(updatedMessage);

                return { 
                    id: alert.id,
                    productCode: alert.productCode,
                    productName: alert.productName,
                    receivedAt: new Date().toISOString(),
                    expiresAt: updatedData.expiresAt || new Date(Date.now() + 3600000).toISOString(), // Default to 1 hour if no expiration provided
                    nwsOffice: updatedData.nwsOffice,
                    vtec: updatedData.vtec,
                    message: updatedMessage,
                    geometry: updatedData.geometry,
                    properties: updatedProps
                 };
            }
            return alert;
        });

        if (!alertFound) {
            throw new Error(`Alert not found with identity ${_formatAlertIdentity(alertIdentity)}`);
        }

        fs.writeFileSync('alerts.json', JSON.stringify(updatedAlerts), 'utf8');
    } catch (err) {
        throw new Error('Error updating alert: ' + err.message);
    }
}

function cancelAlert(alertIdentity, updatedData) {
    // Find alert by VTEC identity
    try {
        if (!alertIdentity) {
            throw new Error('Cannot cancel alert: alert identity is required');
        }

        const alerts = readAlertDatabase();
        let alertFound = false;

        const updatedAlerts = alerts.map(alert => {
            if (_isMatchingAlert(alert, alertIdentity)) {
                alertFound = true;
                console.log(`Cancelling alert with identity ${_formatAlertIdentity(alertIdentity)}`);

                const updatedMessage = updatedData.message + "\n\n#####\n\n" + (alert.message || ''); // Prepend update message to original message

                const updatedProps = _getUpdatedProps(updatedMessage);

                return { 
                    id: alert.id,
                    productCode: alert.productCode,
                    productName: alert.productName,
                    receivedAt: new Date().toISOString(),
                    expiresAt: alert.expiresAt,
                    nwsOffice: alert.nwsOffice,
                    vtec: updatedData.vtec,
                    message: updatedMessage,
                    geometry: updatedData.geometry, // Use updated geometry
                    properties: updatedProps
                 };
            }
            return alert;
        });

        if (!alertFound) {
            throw new Error(`Alert not found with identity ${_formatAlertIdentity(alertIdentity)}`);
        }

        fs.writeFileSync('alerts.json', JSON.stringify(updatedAlerts), 'utf8');
    } catch (err) {
        throw new Error('Error canceling alert: ' + err.message);
    }
}

function storeProduct(code, productData) {
    try {
        let json, filePath;
        try {
            json = JSON.stringify(productData);
            filePath = `products/${code.toLowerCase()}.json`;
        } catch (err) {
            json = String(productData);
            filePath = `products/${code.toLowerCase()}.txt`;
        }
        fs.mkdirSync('products', { recursive: true });
        fs.writeFileSync(filePath, json, 'utf8');
    } catch (err) {
        throw new Error('Error storing product data: ' + err.message);
    }
}

function getProduct(code) {
    try {
        const filePath = `products/${code.toLowerCase()}.json`;
        if (!fs.existsSync(filePath)) {
            throw new Error(`Product with code ${code} not found`);
        }
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        throw new Error('Error retrieving product data: ' + err.message);
    }
}

// Export the database functions
export {
    readAlertDatabase,
    addNewAlert,
    checkAndRemoveExpiredAlerts,
    deleteAlert,
    updateAlert,
    cancelAlert,
    storeProduct,
    getProduct
};