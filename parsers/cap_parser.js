
export default class CAPParser {
    constructor(fullMessage) {
        // fullMessage is the XMPP stanza object

        // Extract header information from the message
        this.productMessage = fullMessage.getChildText('x');
        this.ttaaii = fullMessage.getChild('x', 'nwws-oi')?.attrs?.ttaaii || null;
        this.issuedAt = fullMessage.getChild('x', 'nwws-oi')?.attrs?.issue || null;
        this.officeCode = fullMessage.getChild('x', 'nwws-oi')?.attrs?.cccc || null;

        // Run processing
        this._process();
    }

    _process() {
        // Nothing for now
    }

    getProperty(propertyName) {
        // Function to return an alert property
        switch (propertyName) {
            case 'ttaaii':
                return this.ttaaii;
            case 'issuedAt':
                return this.issuedAt;
        }
    }

    getRawMessage() {
        // Function to return the raw message text
        return this.productMessage || null;
    }

    getMessage() {
        return this.productMessage || null;
    }

    _isCapMessage(ttaaii) {
        return ttaaii.startsWith('XO');
    }
}