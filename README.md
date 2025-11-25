# SparkAlerts
**SparkAlerts is a simple, secure API frontend to easily access the National Weather Wire Service Open Interface (NWWS-OI) via XMPP.**

Built for and used in [Spark Radar](https://sparkradar.app).

> SparkAlerts is still in BETA and should not be used in production yet.

> If this guide contains errors or needs refinement please open an issue.

<a href="https://www.buymeacoffee.com/nimbusapps"><img src="https://img.shields.io/badge/Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black"></a>
<img src="https://img.shields.io/badge/Node%20js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white">
<img src="https://img.shields.io/badge/Express%20js-000000?style=for-the-badge&logo=express&logoColor=white">

<br> 

## Why SparkAlerts?

- **Simple.** SparkAlerts requires little setup and integrates right in with your current environment.
- **Lightweight.** SparkAlerts runs on one file and few dependencies.
- **Secure.** SparkAlerts was built with security in mind, using CORS and API keys by default.
- **FOSS.** SparkAlerts is free to use for everyone and open source. If you would like to support SparkAlerts, you can donate [here](https://www.buymeacoffee.com/nimbusapps).

<br>

## Run
You will need an NWWS-OI account, which can be requested [here](https://www.weather.gov/nwws/nwws_oi_request). To learn more about the NWWS, see [here](https://www.weather.gov/nwws/).

- [Setup .env file](https://github.com/tgranz/SparkAlerts?tab=readme-ov-file#Environment%20Setup).

- Install the necessary packages with `npm install`

- Run the server with `node index.js`.

<br>

## Environment Setup
To securely store settings and XMPP credentials, you must create a .env file in the working directory of the code.
If you don't have a NWWS-OI username and password, request one [here](https://www.weather.gov/nwws/nwws_oi_request).

Paste this template in a new file named `.env` in the same directory as `index.js` and fill out the values.
```text
# NWWS-OI Login credentials
XMPP_USERNAME={your nwws-oi username}
XMPP_PASSWORD={your nwws-oi password}

# Security Settings
DOMAIN_WHITELIST={optional; a comma-separated list of origins or domains to always allow accessing the api}
ALLOW_NO_ORIGIN={sets whether requests excluding origins should be allowed to bypass cors and api keys}
```