# Google Assistant Helper

This project is a Node.js server that provides a helper proxy/middleman for passing commands to the Google Assistant via the published API. It provides the following functionality:

* Broadcast of text messages to Google Assistant devices using the default broadcast voice
* Broadcast of audio files to Google Assistant devices (some restrictions apply)
* Execution of custom commands and broadcast of responses
* Playback of audio resources via Chromecast
* Playback of text via Chromecast using the [Google Cloud Text-to-Speech API](https://cloud.google.com/text-to-speech/)
* \[*Optional*\] TLS Support

The impetus for this project is to provide a simple and full-featured way of using Google Home devces for custom announcements for use with e.g. smart home integrations.

*N.B.*: It is possible to call the Google Assistant Helper endpoints from [IFTTT](https://ifttt.com/), but this is typically too slow to be useful.

## Requirements

This is a [Node.js](https://nodejs.org/en/) server, and this documentation will assume that Node.js is installed, and that the user has some familiarity with Node.js and `npm`.

This project should run on most modern Debian variants. It may run on other operating systems; YMMV.

Chromecast functionality requires mDNS; on Debian this requires `dbus` and `avahi-daemon` to be running. You may need to install the `libavahi-compat-libdnssd-dev` package.

## Setup Instructions

1. Clone this project
    ```
    git clone https://github.com/mpaik/google-assistant-helper.git
    cd google-assistant-helper
    ```

2. Install the server and dependencies
    *N.B.*: This project is not available via the public `npm` repository due to its alpha quality and likely limited userbase.

    ```
    npm install
    ```

3. Create an Developer Project with the Actions Console

    Follow [this guide](https://developers.google.com/assistant/sdk/guides/service/python/embed/config-dev-project-and-account) from Google to set up a new project for use with the Google Assistant API. Note that a Google account will be required.

    When prompted to choose a category after Step 3 in the guide, select `Skip`.

4. Activate API(s)

    In Step 4 of the guide, you may need to select a project via the drop down at the top of the page to activate the API. Note that the project you just created may appear only under the `ALL` tab.

    At the Dashboard, click `ENABLE APIS AND SERVICES` and search for `assistant`. Select and enable the Google Assistant API.

    \[*Optional*\]: If you wish to use the Google Cloud Text-to-Speech API to synthesize messages for delivery via Chromecast, also enable the Cloud Text-To-Speech API.

5. Configure the OAuth consent screen

    In step 5 of the guide, you are instructed to configure the OAuth consent screen for your application.

    Only the email address (of the user you used to create the project, or of a group owned by this user) and the Product name are mandatory. Enter a recognizable Product name to ensure you are providing OAuth consent to the correct application later in the setup process.

6. Create an OAuth client ID

    From the project dashboard, select `Credentials` in the left bar.

    Select the `Create credentials` drop-down and select `OAuth client ID`, and create a client ID of type 'Other' on the following screen. The name is immaterial, but enter something easy to identify. Note that this ID is associated with your **application** rather than a **user** of the application.

    When the process completes, dismiss the dialog box displaying the client ID and client secret. Locate the OAuth 2.0 client ID in the list, and click the download icon to retrieve a JSON file containing the client secret and other relevant data.

7. \[*Optional*\] Create Google accounts for zones

    Broadcasts to Google Assistant devices are sent to all devices associated with the account. Creating accounts for different zones enables the sending of broadcasts to some devices but not others (e.g. to those devices located in public parts of the home but not bedrooms).

    Create a Google (i.e. Gmail, G Suite) account for each desired zone. On an Android device, open the Google Home app, add the new account, and link it to the Google Assistant devices in the desired zone. Note that this linking requires voice input, and that the use of the primary user's voice may confuse normal use of the Google Assistant system. Online text-to-speech generators provide an avenue to create the necessary utterances without introducing ambiguity.

8. \[*Optional*\] Create a Service Account Key in order to use Google Cloud Text-to-Speech

    Playback of generated speech on Chromecast devices requires a Service Account Key to use the Cloud Text-to-Speech API.

    Perform Steps 2 and 4 in the Google Cloud Text-to-Speech API: Node.js Client Quickstart [here](https://github.com/googleapis/nodejs-text-to-speech/).

## Configuration Instructions

The `config.json` file contains all the configuration information for the application. These include:

`port` - **Number**. The port on which the server should run. Note that special permissions may be required for port numbers < 1024.

`certPath` and `certPrivKeyPath` - \[*Optional*\] **String**. Paths to a certificate and certificate private key, respectively, to enable TLS. If other services will call this service as a webhook from outside the local network, the use of TLS is **strongly encouraged**. [Let's Encrypt](https://letsencrypt.org) provides free certificates for registered domain hosts (i.e. not for use with raw IP addresses).

`keyFilePath` - **String**. Path to the OAuth client ID secret file from Step 6 of the Setup Instructions above.

`logFile` - **String**. Name of logfile. This project uses Winston logging.

`fileLogLevel` - **String**. Log level for file logger.

`consoleLogLevel` - **String**. Log level for console logger.

`saveAudioFiles` - **Boolean**. Flag to state whether to save the audio responses from the Google Assistant. Mostly useful for debugging, as audio responses from the Assistant cannot be broadcast. Files will be saved in the working directory.

`language` - **String**. Language code to use with the Google Assistant. At present, only `en-US` is verified to work properly; reports of other languages working and/or contributions to help them work are appreciated.

`relays` - Contains activation flags and route paths for each of the six broadcast types:

* `broadcast` - Takes strings to broadcast to Google Assistant devices

* `broadcastAudio` - Enables broadcast of preconfigured audio files defined in `sounds`. Restrictions apply.

* `custom` - Enables execution of custom commands to the assistant, e.g. `what time is it?`. Broadcasts can be sent via this route by executing `broadcast <announcement>`.

* `chromecastAudio` - Enables sending of audio files defined in `sounds` to Chromecast devices or groups, including Google Home devices.

* `chromecastTTS` - Enables sending of audio announcements created by Google Cloud Text-to-Speech. Settings specific to this relay are:

    * `apiCredentialPath` - **String**. Path to the separate Service Account Key, described in Step 8 of the Setup Instructions above.

    * `cachePath` - **String**. Path to cache TTS request files, to speed repeated requests and reduce the risk of exceeding the free tier of the Google Cloud Text-to-Speech API. Filenames are a hash of elements including the full text of the request and the metadata of the language and voice requested.

    * `defaultLanguage` - **String**. The default language voice to use for the TTS API voice request.

    * `defaultGender` - **String**. The default gender to use for the TTS API voice request.

    The Google Cloud Text-to-Speech API has `Standard` and `Wavenet` voices. The latter are more accurate, but more expensive and with only 25% the number of characters in the free tier. `Standard` voices are used by default, and this server has no affordance to specify Wavenet voices by default. Wavenet voices can be invoked directly by name in the request itself, described below.

* `chromecastURL` - Enables sending of media to Chromecast devices on demand by supplying media URLs and types.

* `chromecastControl` - Enables control of ongoing Chromecast playback initiated through this server.

For each relay, set `on` to `true` to activate, or to `false` to deactivate. Note that relay routes must be unique.

**Note that while the URLs of the relay endpoints can be customized, the names of the relays, e.g. `custom`, `chromecastTTS`, may not.**

The `broadcastAudio` and `chromecastAudio` relays may have the same preconfigured sounds or different ones, but they are separately defined because not all sounds can be played via broadcast. The input to the audio broadcast stream is expected to be a verbal command entered via microphone. As such, the machine learning model that processes the input expects said input to meet two important conditions:

1. It must contain human speech
2. It must contain noise

Thus the server cannot broadcast audio files such as alarms, sound effects, ringtones, etc. Perhaps more surprisingly, if the sound provided is too clean (e.g. the output from a text-to-speech interpreter), the call will still fail. The Google Assistant interpreter appears to issue an [`END_OF_UTTERANCE`](https://developers.google.com/assistant/sdk/reference/rpc/google.assistant.embedded.v1alpha2#google.assistant.embedded.v1alpha2.EmbeddedAssistant) at the end of a command only when noise is present; therefore an audio file without noise will cause the Assistant request to time out.

Further, inputs to the audio broadcast facility may only be in `FLAC` or `LINEAR16` (raw), while Chromecast has a much wider range of valid input formats. **Note that the sounds for the `broadcastAudio` relay have `format` attributes whereas those for the `chromecastAudio` endpoint have `contentType` attributes. Note also that while the Assistant API supports `FLAC`, this application does not.**

`staticServer` - Contains configuration for the static server used to serve assets for the `chromecastAudio` and `chromecastTTS` relays:

* `port` - **Number**. The port on which to start the static asset server

* `path` - **String**. The filesystem path that contains the static assets

* `route` - **String**. The route path on which the static asset server will listen

* `whitelist` - **Array**. Whitelist of IP addresses permitted to connect to the static asset server. As the intent is to make assets available to local Chromecast devices, all other IP addresses are blacklisted by default. Chromecast devices will not allow TLS connections over self-signed certificates, and Let's Encrypt will not sign certificates associated with IP addresses rather than hostnames. It is possible in principle to create an externally accessible server to serve media, but this introduces security risks and the present application does not support this scenario.

The static asset server will be started automatically if and only if either the `chromecastAudio` or `chromecastTTS` relays are active.

`users` - Contains configuration for users/zones. Each named user has:

* `savedTokensPath` - **String**. The path to the file to contain saved access tokens. These tokens/files will not exist at the outset and will be created during the initial run of the application.

* `relayKey` - **String**. A key to use in the JSON request for cursory authentication

* `chromecastFriendlyName` - \[*Optional*\] **String**. The name used to refer to the Chromecast device or group to which this user will cast, as displayed in the Google Home app.

## Initial Run

Upon first run, the server will attempt, and fail, to access the tokens authorizing the application to access user data and thereby communicate with the Google Assistant. The console log will display a URL of the form

```
https://accounts.google.com/o/oauth2/auth?access_type=offline&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fassistant-sdk-prototype&response_type=code&client_id=THIS_CLIENT_ID&redirect_uri=urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob
```

where `THIS_CLIENT_ID` will be substituted with the client ID established in Step 3 of the Setup Instructions above and included in the OAuth JSON file.

As directed, navigate to the URL displayed in the console, log in with the appropriate Google account, copy the access token provided, paste it into the console, and press `Enter`. The server will automatically create the token file for future use.

## Usage Instructions

Once the server is configured and running, test the relays to ensure that they function as expected. Tools like [Postman](https://www.getpostman.com/) are useful for creating arbitrary POST requests for this purpose.

Requests must have the `Content-Type: application/json`, and the body must be valid JSON. All requests must contain the fields:

* `command` - **String**. The command to be executed. Valid values vary depending on what relay is being used; see below.

* `user` - **String**. The user invoking the command, as defined in the `users` object in `config.json`.

* `relayKey` - **String**. The key associated with the user above.

The server will respond with a `200` code if the request is successful, or a `500` if not.

All requests can also optionally pass:

* `delayInSecs` - **Number**. The number of seconds by which to delay the execution of this command. This can be used, for instance, to announce the completion of a brew cycle on a coffeemaker but delay the broadcast by long enough to allow the coffee to finish dripping.

### Broadcast

Broadcasts invoke the broadcast functionality of Google Assistant devices. This is analogous to typing `broadcast <message>` into the Google Assistant on an Android device. In this case, the `broadcast` is omitted, and only the message is included in the `command` field in the request JSON, e.g.:

```
{
	"command": "Mr. Watson, come here, I want to see you",
	"user": "global",
	"relayKey": "Qk5U7G6O3AiUIM1yHCOFPf"
}
```

### BroadcastAudio

Audio broadcast commands rely on preconfigured `LINEAR16` files with defined names, which are sent as byte streams via the Google Assistant API. In this case, the `command` field in the request JSON is populated with the name of the desired sound, e.g.: 

```
{
	"command": "gameovermangameover",
	"user": "global",
	"relayKey": "Qk5U7G6O3AiUIM1yHCOFPf"
}
```

As stated above, files for audio broadcast must contain human speech to trigger the correct events from the API.

### Custom

Custom Google Assistant commands allow free entry of text into the Assistant. This can be dangerous, as it permits access to resources associated with the account being used. The `command` field in the request JSON should contain the relevant command, e.g.: 

```
{
	"command": "what time is it?",
	"user": "global",
	"relayKey": "Qk5U7G6O3AiUIM1yHCOFPf"
}
```

Commands that begin a conversation, i.e. those that require a response other than a simple acknowledgment from the Google Assistant, elicit text responses from the assistant which are then broadcast to the Google Assistant devices associated with the account used to invoke the command. Otherwise, the invocation is more or less identical to that of the audio broadcast.

Custom commands that are expected to return audio (not all do - many return only text, while yet others return both) can be set to broadcast the audio response by providing an additional argument in the JSON:

* `broadcastAudioResponse` - **Boolean**. A flag to indicate whether or not to broadcast an audio response.

The facility to broadcast audio has several important limitations. First, the Google Assistant will interpret a long enough silence as the end of utterance, and will initiate broadcast, so many responses from the Assistant itself will be cut off in the middle (e.g. jokes that wait to deliver a punchline). As such, this application truncates silences before sending the audio to the Google Assistant API, which may make the cadence of the speech sound fast. Second, the Google Assistant broadcast facility has an undocumented hard limit for length of about 20 seconds. If audio longer than this is passed via the API, the Assistant will fail in unpredictable ways. As such, if audio longer than a threshold value is returned by a custom request, this application will simply drop the request rather than cause failure. The aborted attempt will be logged, however.

To test that this facility is working, you can try, e.g.: 

```
{
    "command": "tell me a joke",
    "user": "global",
    "relayKey": "Qk5U7G6O3AiUIM1yHCOFPf",
    "broadcastAudioResponse": true
}
```

### ChromecastAudio

Chromecast Audio commands are similar to the audio broadcast commands above, with a few caveats. First, Chromecast devices can play many more types of media than the Google Assistant broadcast facility. Second, playing audio via Chromecast will interrupt any media already playing on the Chromecast device, including Google Home devices, whereas broadcasts will simply play over the currently playing media.

```
{
	"command": "therearefourlights",
	"user": "global",
	"relayKey": "Qk5U7G6O3AiUIM1yHCOFPf"
}
```

Chromecast audio broadcasts are a good option to enable zoned/grouped announcements without the hassle of creating new Google accounts per zone for zoned broadcasts.

### ChromecastTTS

Chromecast TTS commands use the Google Cloud Text-to-Speech API to synthesize audio from written text and play it via Chromecast devices or groups. The `command` field should contain the text to be synthesized, e.g.:

```
{
	"command": "What's the frequency, Kenneth?",
	"user": "global",
	"relayKey": "Qk5U7G6O3AiUIM1yHCOFPf"
}
```

The Chromecast TTS relay also accepts an optional `voice` object in the request JSON describing which voice to use, consisting of a `name`, `languageCode`, and an `ssmlGender`, all strings. The full list of valid combinations can be found [here](https://cloud.google.com/text-to-speech/docs/voices). The presence of this object will override the `defaultLanguage` and `defaultGender` specified in the `config.json`.

```
{
	"command": "G'day, mate",
	"user": "global",
	"relayKey": "Qk5U7G6O3AiUIM1yHCOFPf",
	"voice": {
		"languageCode": "en-AU",
		"ssmlGender": "MALE",
		"name": "en-AU-Standard-B"
	}
}
```

### ChromecastURL

The Chromecast URL relay allows the on-demand playback of media URLs via Chromecast devices or groups. The `command` field should contain the URL of the media to be played. Further, the request must contain a `contentType` specifying what type of media the URL points to. At present, only buffered (vs. live) streams are supported.

```
{
	"command": "http://commondatastorage.googleapis.com/gtv-videos-bucket/big_buck_bunny_1080p.mp4",
	"user": "global",
	"relayKey": "Qk5U7G6O3AiUIM1yHCOFPf",
	"contentType": "video/mp4"
}
```

### ChromecastControl

The Chromecast Control relay allows the control of ongoing Chromecast playback initiated by this server. This functionality is necessary because the Google Assistant API appears currently not to support media control and playback requests. The `command` field should contain one of `PLAY`, `PAUSE`, `STOP`, and `SEEK`. The `SEEK` command must be accompanied by a field `currentTime` with the time index of the desired seek point, in integer seconds; i.e. to seek to 2:12, this value should be `132`.

```
{
	"command": "PAUSE",
	"user": "global",
	"relayKey": "Qk5U7G6O3AiUIM1yHCOFPf"
}
```

or 

```
{
	"command": "SEEK",
	"currentTime": 132,
	"user": "global",
	"relayKey": "Qk5U7G6O3AiUIM1yHCOFPf"
}
```
