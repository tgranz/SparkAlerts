# SparkAlerts
### XMPP Processor with built-in API to easily access the NWWS-OI. (WIP)
Used in [Spark Radar](https://sparkradar.app).

<a href="https://www.buymeacoffee.com/nimbusapps"><img src="https://img.shields.io/badge/Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black"></a>

<img src="https://img.shields.io/badge/Node%20js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white">
<img src="https://img.shields.io/badge/Express%20js-000000?style=for-the-badge&logo=express&logoColor=white">


## Run
You will need some knowledge of the [NWWS Open Ineterface](https://www.weather.gov/nwws/) and a password, which can be requested [here](https://www.weather.gov/nwws/nwws_oi_request).

- Add this to a `.env` file in the working directory of the code:

```txt
# NWWS-OI login via XMPP
XMPP_USERNAME=
XMPP_PASSWORD=
```

- Install the necessary packages with `$: npm install dotenv assert express express-rate-limit cors crypto`

- Run the code with `$: node index.js`.

> If this guide contains errors or needs refinement please open an issue.
