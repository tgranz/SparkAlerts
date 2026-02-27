// Import XMPP client
import { client, xml } from '@xmpp/client';

// Import dotenv to load environment variables
import dotenv from 'dotenv';
dotenv.config();

// Import filesystem for lookups
import fs from 'fs';

// Import parsers
import CAPParser from './parsers/cap_parser.js';
import WMOParser from './parsers/wmo_parser.js';

// Import database worker
import { addNewAlert, deleteAlert, updateAlert, cancelAlert } from './database.js';
import { act } from 'react';

// Function to check if message is a CAP message based on TTAII code
function isCapMessage(ttaaii) {
    // TTAII of a SPS looks like: WWUS81
    // First two letters indicate the header; "XO" is for CAP messages
    return ttaaii.startsWith('XO');
}

// Main 
export default class NWWSOI {
    constructor(productsConfig, callbacks = { onNew: () => {}, onUpdate: () => {} }) {
        // Store the productFilter and ensure proper case
        this.productFilter = productsConfig?.allowed_products || [];
        this.productFilter = this.productFilter.map(code => code.toUpperCase());

        // Store other configurations
        this.requireGeometry = productsConfig?.require_geometry || false;

        // Load lookup tables
        this.productCodes = JSON.parse(fs.readFileSync('./lookups/product-codes.json', 'utf8'));

        // Store demo outputs for all product codes
        this.demoDir = './demo';
        this.messageCounter = 0;
        fs.mkdirSync(this.demoDir, { recursive: true });

        this.xmpp = client({
            service: 'xmpp://nwws-oi.weather.gov',
            domain: 'nwws-oi.weather.gov',
            resource: 'SparkAlerts NWWS Ingest',
            username: process.env.XMPP_USERNAME,
            password: process.env.XMPP_PASSWORD,
        });

        this.xmpp.on('error', (err) => {
            console.error('XMPP Error:', err);
        });

        this.xmpp.on('online', async (address) => {
            console.log('Connected as', address.toString(), '\n');

            // Join chatroom
            const roomJid = 'room@conference.example.com';
            const presence = xml( 'presence', { to: 'nwws@conference.nwws-oi.weather.gov/SparkRadar' });
            await this.xmpp.send(presence);
        });

        this.xmpp.on('stanza', (stanza) => {
            if (stanza.is('message') && stanza.attrs.type === 'groupchat') {

                const messageText = stanza.getChildText('body');
                const productInfo = this._identifyProductFromMessage(messageText);
                const nwsOffice = stanza.getChild('x', 'nwws-oi')?.attrs?.cccc || null;
                const ttaaii = stanza.getChild('x', 'nwws-oi')?.attrs?.ttaaii || null;
                const isCap = isCapMessage(ttaaii || '');

                if (!productInfo.productName) {
                    // productName will be null if product code is not found in lookups
                    return;
                } else if (this.productFilter.length > 0 && !this.productFilter.includes(productInfo.productCode)) {
                    // If product filter is set and this product code is not in the filter, skip processing
                    console.log('Skipping product', productInfo.productName, 'as it is not in the filter list\n');
                    return;
                }

                // Run the parser depending on if this is a CAP or plain text message
                const parser = isCap ? new CAPParser(stanza) : new WMOParser(stanza);

                // Log only CAP messages so I can add CAP parsing logic later
                if (isCap && productInfo.productCode) {
                    const productDir = `${this.demoDir}/${productInfo.productCode}`;
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const demoPath = `${productDir}/${timestamp}-${++this.messageCounter}.txt`;

                    fs.mkdirSync(productDir, { recursive: true });
                    fs.writeFileSync(demoPath, stanza.toString(), 'utf8');

                    console.warn("CAP messages not yet supported. Saved message to", demoPath);
                    return;
                }

                // Extract additional parsed properties
                const geometry = parser.getProperty('geometry') || null;

                // If geometry is required for this product but the parser was not able to extract it, skip this message
                if (this.requireGeometry && !geometry) {
                    console.warn('Skipping', productInfo.productName, 'contains null geometry\n');
                    return;
                }

                // Log some details
                console.log(productInfo.productName, 'from', nwsOffice);
                console.log('Is CAP Message:', isCap);
                console.log('VTEC:', parser.getProperty('vtec'));
                //console.log('Extracted message:', parser.getMessage());
                console.log('Geometry:', geometry);
                //console.log('Content:', stanza.getChildText('x'));
                //console.log('Full Stanza:', stanza.toString());
                console.log('\n')

                const vtec = parser.getProperty('vtec');

                const alertData = {
                    id: parser.getProperty('id'),
                    productCode: productInfo.productCode,
                    productName: productInfo.productName,
                    receivedAt: new Date().toISOString(),
                    expiresAt: parser.getProperty('expiration') || new Date(Date.now() + 3600000).toISOString(), // Default to 1 hour if no expiration provided
                    nwsOffice: nwsOffice,
                    vtec: vtec,
                    message: parser.getRawMessage(),
                    geometry: geometry,
                    properties: {
                        isPds: parser.getProperty('isPds') || false,
                        isConsiderable: parser.getProperty('isConsiderable') || false,
                        isDestructive: parser.getProperty('isDestructive') || false,
                    }
                };

                // Check alert action from VTEC
                if (vtec) {
                    // If no VETC we will default to "NEW"
                    const action = vtec.actionCode || 'NEW';

                    // NEW = New event
                    // CON = Continuation (same event, updated information)
                    // EXT = Extension (extended expiration time)
                    // EXA = Extension (extended area)
                    // EXB = Extension (extended time and area)
                    // UPG = Upgrade (uncommon)
                    // CAN = Cancellation
                    // EXP = Expiration
                    // COR = Correction
                    // ROU = Routine message (uncommon)

                    if (action === 'EXP') {
                        // Expiration - remove this alert from the database with the same event tracking number
                        try {
                            deleteAlert(parser.getProperty('vtec')?.eventTrackingNumber || null);
                            callbacks.onUpdate();
                        } catch (err) {
                            if (err.message.includes('Alert not found')) {
                                console.warn('Attempted to delete alert that does not exist in database:', err.message);
                            } else {
                                console.error('Error deleting alert from database:', err.message);
                            }
                        }
                        return;
                    } else if (action === 'CAN') {
                        // Cancellation - Append cancellation message, update geometry, but keep everything else
                        const eventTrackingNumber = parser.getProperty('vtec')?.eventTrackingNumber;
                        console.log(`Attempting to cancel alert with eventTrackingNumber: ${eventTrackingNumber}`);
                        try {
                            cancelAlert(eventTrackingNumber, alertData);
                            callbacks.onUpdate();
                            return;
                        } catch (err) {
                            console.warn('Failed to cancel alert:', err.message, '- Adding as new alert instead');
                            // Fall through to add as new alert
                        }
                    } else if (action === 'ROU') {
                        return; // Ignore routine messages as they are not actual alerts
                    } else if (action !== 'NEW') {
                        // Some sort of update - update the existing alert in the database with new information
                        const eventTrackingNumber = parser.getProperty('vtec')?.eventTrackingNumber;
                        console.log(`Attempting to ${action} alert with eventTrackingNumber: ${eventTrackingNumber}`);
                        try {
                            updateAlert(eventTrackingNumber, alertData);
                            callbacks.onUpdate();
                            return;
                        } catch (err) {
                            console.warn('Failed to update alert:', err.message, '- Adding as new alert instead');
                            // Fall through to add as new alert
                        }
                    }
                }

                // Push this alert to the database
                try {
                    addNewAlert(alertData);
                    callbacks.onNew();
                    console.log('Successfully stored alert in database\n');
                } catch (err) {
                    console.error('Error saving alert to database:', err.message);
                }
            }
        });

        this.xmpp.start().catch(console.error);
    }

    _getProductName(product) {
        return this.productCodes[product] || null;
    }

    _identifyProductFromMessage(message) {
        var product = null;
        try {
            product = message.split('valid')[0].split('issues')[1].trim();
        } catch {}

        // Product is 3 letters. If additional letters are present, the code may be in parenthesis
        if (product && product.length > 3) {
            try { 
                product = product.split('(')[1].split(')')[0].trim();
            } catch {}
        }

        // If still longer than 3 letters, there is an issue. Log and return null
        if (product && product.length > 3) {
            console.warn('Unable to identify product from message:', message);
            return null;
        }

        return { productCode: product, productName: this._getProductName(product) };
    }
}