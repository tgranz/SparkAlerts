# SparkAlerts
**SparkAlerts is a simple, secure API frontend to easily access the National Weather Wire Service Open Interface (NWWS-OI) via XMPP.**

Built for and used in [Spark Radar](https://sparkradar.app).

> SparkAlerts is still in BETA and should not be used in production yet.

> If this guide contains errors or needs refinement please open an issue.

<a href="https://www.buymeacoffee.com/tgranz"><img src="https://img.shields.io/badge/Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black"></a>
<img src="https://img.shields.io/badge/Node%20js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white">
<img src="https://img.shields.io/badge/Express%20js-000000?style=for-the-badge&logo=express&logoColor=white">

<br> 

## Why SparkAlerts?

- **Simple.** SparkAlerts requires little setup and integrates right in with your current environment.
- **Stable.** SparkAlerts is actively maintained and supported by the community.
- **Lightweight.** SparkAlerts runs on few files dependencies.
- **Secure.** SparkAlerts was built with security in mind, using CORS and API keys by default.
- **FOSS.** SparkAlerts is free to use for everyone and open source. If you would like to support SparkAlerts, you can donate [here](https://www.buymeacoffee.com/nimbusapps).

<br>

## Run
You will need an NWWS-OI account, which can be requested [here](https://www.weather.gov/nwws/nwws_oi_request). To learn more about the NWWS, see [here](https://www.weather.gov/nwws/).

- [Setup .env file](https://github.com/tgranz/SparkAlerts?tab=readme-ov-file#environment-setup).

- Install the necessary packages with `npm install`.

- Run the server with `node index.js`.

<br>

## Environment Setup
To securely store your XMPP credentials, you must create a .env file in the working directory of the code.
If you don't have a NWWS-OI username and password, request one [here](https://www.weather.gov/nwws/nwws_oi_request).

Fill out your `.env` file in the same directory as `index.js` and fill out the values `XMPP_USERNAME` and `XMPP_PASSWORD`.

```text
XMPP_USERNAME=XXXX.XXXX
XMPP_PASSWORD=XXXXXXXX
```

## Configuration File
To set your settings, add the following template code to a `config.json` in the working directory of the code.

```json
{
	"expressPort": 8433,
	"allowNoOrigin": false,
	"domainWhitelist": [
		"https://sparkradar.app",
		"http://localhost:5173"
	],
	"apiKeys": {
		"YOUR_API_KEY": {
			"name": "Development API Key",
			"rateLimit": 100,
			"whitelist": [],
			"lastUsed": null,
			"active": true
		}
	},
	"rateLimit": {
		"windowMs": 900,
		"defaultMax": 30
	},
	"nwwsoi": {
		"resource": "SparkAlerts NWWS Ingest Client",
		"maxReconnectAttempts": 10,
		"initialReconnectDelay": 2000
	},
	"allowNoGeometry": false,
	"allowedAlerts": [
		"Tornado Warning",
		"Severe Thunderstorm Warning"
	]
}
```

## Configuration

To control which alert types SparkAlerts will process, use the `allowedalerts.json` file in the project directory. This file contains a list of alert names that are permitted.

### How to Allow Alerts

1. Open `allowedalerts.json` in your text editor.
2. Add or remove alert names as needed. Each alert should be a string in the JSON array.
3. Save the file. The server will use this list to filter incoming alerts.

**Example:**

```json
[
	"Tornado Warning",
	"Severe Thunderstorm Warning",
	"Flood Warning"
]
```

**Tip:** Only alerts listed in `allowedalerts.json` will be processed. To allow all alerts, include all possible alert names. To restrict, remove unwanted alert types.

**Note:** Changes to `allowedalerts.json` take effect the next time you restart the server.

---