# SparkAlerts
**SparkAlerts is a simple, secure API frontend to easily access the National Weather Wire Service Open Interface (NWWS-OI) via XMPP.**

Built for and used in [Spark Radar](https://sparkradar.app).

> SparkAlerts is still in testing and should not be used in production yet.

> As of 1/27/26, the API security and configuration has changed. Existing instances of previous versions of SparkAlerts should migrate to the latest version.

<a href="https://www.buymeacoffee.com/tgranz"><img src="https://img.shields.io/badge/Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black"></a>
<img src="https://img.shields.io/badge/Node%20js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white">
<img src="https://img.shields.io/badge/Express%20js-000000?style=for-the-badge&logo=express&logoColor=white">

<br> 

## Why SparkAlerts?

- **Simple.** SparkAlerts requires little setup and integrates right in with your current environment.
- **Stable.** SparkAlerts is actively maintained and supported by the community.
- **Lightweight.** SparkAlerts runs on few files dependencies.
- **Secure.** SparkAlerts was built with security in mind, enforcing CORS and use of API keys.
- **FOSS.** SparkAlerts is free to use for everyone and open source. If you would like to support SparkAlerts, you can donate [here](https://www.buymeacoffee.com/nimbusapps).

<br>

## Run
You will need an NWWS-OI account, which can be requested [here](https://www.weather.gov/nwws/nwws_oi_request). To learn more about the NWWS, see [here](https://www.weather.gov/nwws/).

- [Setup .env file](https://github.com/tgranz/SparkAlerts?tab=readme-ov-file#environment-setup).

- [Setup config.json file](https://github.com/tgranz/SparkAlerts?tab=readme-ov-file#configuration-setup).

- Install the necessary packages with `npm install`.

- Run the server with `node index.js`.

<br>

## Environment Setup
To securely store XMPP credentials, you must create a .env file in the working directory of the code.
If you don't have a NWWS-OI username and password, request one [here](https://www.weather.gov/nwws/nwws_oi_request).

Fill out your `.env` file in the
 same directory as `index.js` and fill out the values `XMPP_USERNAME` and `XMPP_PASSWORD`.

```text
XMPP_USERNAME=XXXX.XXXX
XMPP_PASSWORD=XXXXXXXX
```


## Configuration Setup
> Starting 1/27/26, settings are stored in a `config.json` file instead of the `.env` file.

Fill out your `config.json` file in the same directory as `index.js`. You may choose to use some, all, or none of the fields below. The example config.js file shows default values.

```js
{
    "security": {
        // List of valid origins from CORS that can access the server
        // without any API key
        "allowed_origins": [],
        // Allows requests with a blank or null origin to access the
        // server without API key; set to "true" for testing (to run
        // requests in the browser), or "false" in production
        "allow_no_origin": false
    },
    "api": {
        // Max number of requests per "rate_window_ms"
        "rate_limit": 10,
        // Time in ms until the rate limit counter is reset
        "rate_window_ms": 60000,
        // Same as "rate_limit", but for requests with a valid API key
        "key_rate_limit": 1000,
        // Same as "rate_window_ms", but for requests with a valid API
        // key
        "key_rate_window_ms": 60000,
        // Localhost port that the API runs on
        "port": 8080,
        // List of valid API keys
        "keys": [],
        // Requires an API key for origins not found on the
        // "allowed_origins" list; will still not require an API key for
        // no origin requests
        "require_key": true,
        // Disables API keys entirely. If this is true and
        // "allow_no_origin" is also true, all requests except those
        // with an origin on the "allowed_origins" list will be blocked
        "disable_keys": false
    },
    "nwws": {
        // Nickname for the client to appear as in the NWWSOI chatroom
        "nickname": "SparkAlerts NWWS Ingest",
        // If the NWWSOI connection is lost, try this many times to
        // reconnect
        "max_reconnect_attempts": 5,
        // Interval to try reconnecting, in ms, +/- 1000 ms, and
        // increased exponentially upon each failed reconnection
        "reconnect_interval_ms": 2000,
        // Alert products to issue. Issues any warning with the
        // phenomenon that matches any in this list. For valid
        // phenomena, go to https://www.weather.gov/bmx/vtec
        "products": [
            "TO",
            "SV",
        ]
    },
    "app": {
        // Sets the logging level in the service.log file. Can be 
        // "debug", "info". "warn", or "error"
        "log_level": "info",
        // If true, no debug statements or logs will print in the 
        // console except for startup info. Will still log to the log
        // file.
        "silent_console": true
    }
}
```


# FAQ
## I see `XMPP Authentication failed: Check your username and password in the .env file.` in the console output.
**Check your `.env` file. Either you are missing the "XMPP_USERNAME" or "XMPP_PASSWORD" parameter, one of the parameters are incorrect, or the parameter names are misspelled.**

## I see the following output:
```text
Alert action 'NEW' detected - new alert.
No coordinates found in alert, skipping...
Alert action 'NEW' detected - new alert.
No coordinates found in alert, skipping...
```
**Some alerts issued in the XMPP chatroom do not contain coordinates and are therefore useless. You can safely ignore these warnings.**

## I ran the server and see no alerts being returned!
**This is a major limitation of the NWWSOI. SparkAlerts MUST be running WHEN THE ALERT IS ISSUED to record the alert. When it is recorded, the alert will stay until it is expired or cancelled.**

## When I try to access the API in a browser, I recieve `{"status":"ERROR","message":"CORS policy: No origin not allowed"}`.
**For security reasons, no-origin requests (such as those when opening the API directly in the browser) are not allowed by default. If you are testing or do not want this behavior, in your `config.json` file change "security" > "allow_no_origin" to `true`.**