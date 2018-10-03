// Copyright 2018 Michael Paik
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict'

const https = require('https'),
      express = require('express'),
      logger = require('winston'),
      expressWinston = require('express-winston'),
      GoogleAssistant = require('google-assistant'),
      serveStatic = require('serve-static'),
      ipfilter = require('express-ipfilter').IpFilter,
      config = require('./config.json'),
      fs = require('fs'),
      ip = require('ip'),
      path = require('path'),
      crypto = require('crypto'),

      app = express(); // ExpressJS instance for external relay endpoints

      // ExpressJS instance for internal chromecast serving - instantiated later
var staticApp = null;


const assistants = {}, // Map from username to assistant
      audioBuffers = {}, // Map from conversation to audio buffer
      relayRoutes = {}; // Map from relay to route

// Values from proto enums for audio encodings - use in config files
const AUDIO_IN_LINEAR16 = "LINEAR16",
      AUDIO_IN_FLAC = "FLAC";

const AUDIO_OUT_LINEAR16 = "LINEAR16",
      AUDIO_OUT_MP3 = "MP3",
      AUDIO_OUT_OPUS_IN_OGG = "OGG";

const validRelays = ["broadcast", "broadcastAudio", "custom", "chromecastAudio",
                        "chromecastTTS", "chromecastURL", "chromecastControl"];

const tts = (config.relays.chromecastTTS.on) ? require('@google-cloud/text-to-speech') : null;
const ttsClient = (tts) ? new tts.TextToSpeechClient({keyFilename: `${config.relays.chromecastTTS.apiCredentialPath}`}) : null;

const silence = new Int16Array(16000); // one second of silence, initialized to 0

// Helps to keep track of what message is for what conversation with multiple streams
var conversationCounter = 0;

// Winston logger configuration
var winstonConfig = {
  transports: [
    new logger.transports.File({
      level: config.fileLogLevel,
      filename: "./"+config.logFile,
      handleExceptions: true,
      json: true,
      colorize: false
    }),
    new logger.transports.Console({
      level: config.consoleLogLevel,
      handleExceptions: true,
      json: false,
      colorize: true,
      prettyPrint: true
    })
    ],
    exitOnError: false
};

logger.configure(winstonConfig);
logger.debug(`Logger initialized`);

// Load cast. This must be after the logger is configured to use the same default
const cast = require('./cast');

// Use JSON middleware
app.use(express.json());

// Add middleware to catch body parser errors
app.use((err, req, res, next) => {
  logger.error(`Error parsing JSON, returning 400`,err);
  res.status(400).send({"result":"Malformed JSON"});
});

var router = express.Router();

// Build the routes
var compositeRoute = [];
Object.keys(config.relays).forEach(k => {
  if (config.relays[k].on) {
    if (!validRelays.includes(k)) { // If this isn't an allowed relay
      logger.error(`Invalid relay "${k}", aborting.`);
    }
    else if (!config.relays[k].route) {
      logger.error(`Route not defined for relay ${k}, aborting.`);
      process.exit(3);
    }
    compositeRoute.push(config.relays[k].route);
    // Validate and set relays
    relayRoutes[k] = config.relays[k].route;
  }
});
if (compositeRoute.length == 0) {
  logger.error(`No services active; no routes configured. Exiting.`);
  process.exit(2);
}

logger.debug(`Binding POST route for ${compositeRoute}`);
// Broadcasts & custom text commands
router.post(compositeRoute, function (req, res) {
  let command = req.body.command;
  let user = req.body.user;
  let relayKey = req.body.relayKey;
  let delay = req.body.delayInSecs;

  // Make sure we have everything we need
  if (command == null || user == null || relayKey == null) {
    if (relayKey) relayKey = `[Redacted]`;
    logger.info(`Malformed request, returning 400: command: "${command}", user: ${user}, relayKey: ${relayKey}.`);
    res.status(400).send({"result":"Malformed request"});
  }
  else {
    logger.info(`Received request: command: "${command}", user: ${user}, relayKey: [Redacted], delayInSecs: ${delay}`);
    // Check whether we have the right PSK for the user
    if (config.users[user] && relayKey === config.users[user].relayKey) {
      // If this is an audio broadcast route, send audio broadcast
      if (relayRoutes["broadcastAudio"] != null && req.path === config.relays.broadcastAudio.route) {
        // command is the name of the predefined sound, look up and send
        if (!config.relays.broadcastAudio.sounds[command]) {
          logger.error(`No sound ${command} configured. Aborting.`);
          res.status(500).send({"result": `Server error.`});
        }
        else if (!(config.relays.broadcastAudio.sounds[command].format === "FLAC"
                || config.relays.broadcastAudio.sounds[command].format === "LINEAR16")) {
          logger.error(`Invalid format ${config.sounds[command].format} - only FLAC and LINEAR16 allowed. Aborting.`);
          res.status(500).send({"result": `Server error.`});
        }
        else {
          logger.info(`Sending sound ${command} via broadcast for user ${user}.`);
          setTimeout(() => {sendBroadcastAudio(config.relays.broadcastAudio.sounds[command].path,
                                               user,
                                               config.relays.broadcastAudio.sounds[command].format)},
                     delay == null ? 0 : delay * 1000);
          res.status(200).send({"result":`Played ${command} via broadcast.`});
        }
      }
      // If this is the Chromecast TTS route
      else if (relayRoutes["chromecastTTS"] != null && req.path === config.relays.chromecastTTS.route) {
        let voice = req.body.voice ? req.body.voice : {languageCode: config.relays.chromecastTTS.defaultLanguage,
                                                       ssmlGender: config.relays.chromecastTTS.defaultGender};
        let voiceString = `${voice.languageCode}_${voice.ssmlGender}_${voice.name}`;
        let encodedCommand = crypto.createHash('sha1').update(command+voiceString).digest('hex');
        // If we have a cached copy
        if (fs.existsSync(`${config.relays.chromecastTTS.cachePath}/${encodedCommand}.mp3`)) {
          logger.debug(`Cache hit for TTS request "${command}" via Chromecast for user ${user}.`);
        }
        else { // If we don't have a cached copy
          logger.debug(`Cache miss for TTS request "${command}" via Chromecast for user ${user}.`);
          // Default voice unless a voice has been specified
          let ttsRequest = {
            input: {text: command},
            voice: voice,
            audioConfig: {audioEncoding: 'MP3'}
          }
          ttsClient.synthesizeSpeech(ttsRequest, (e, response) => {
            if (e) {
              logger.error(`Problem synthesizing speech.`, e);
              res.status(500).send({"result": 'Server error.'});
              return;
            }
            fs.writeFileSync(`${config.relays.chromecastTTS.cachePath}/${encodedCommand}.mp3`,
                             response.audioContent,
                             'binary',
                             e => {
                              if (e) {                            
                                logger.error(`Problem synthesizing speech.`, e);
                                res.status(500).send({"result": 'Server error.'});
                                return;
                              }
                              logger.debug(`Successfully wrote ${config.relays.chromecastTTS.cachePath}/${encodedCommand}.mp3 to disk.`);
                             });
          });
        }
        setTimeout(() => {cast.cast(config.users[user].chromecastFriendlyName,
                               `http://${ip.address()}:${config.staticServer.port}${config.staticServer.route}/${encodedCommand}.mp3`,'audio/mp3')},
                   delay == null ? 0 : delay * 1000);
        res.status(200).send({"result": `Played ${command} via Chromecast.`});              
      }
      // If this is the Chromecast route
      else if (relayRoutes["chromecastAudio"] != null && req.path === config.relays.chromecastAudio.route) {
        if (!config.relays.chromecastAudio.sounds[command]) {
          logger.error(`No sound ${command} configured. Aborting.`);
          res.status(500).send({"result": 'Server error.'});
        }
        else {
          logger.info(`Sending sound ${command} via Chromecast for user ${user}.`);
          setTimeout(() => {cast.cast(config.users[user].chromecastFriendlyName,
                                 `http://${(ip.address())}:${config.staticServer.port}${config.staticServer.route}/${path.basename(config.relays.chromecastAudio.sounds[command].path)}`,config.relays.chromecastAudio.sounds[command].contentType)},
                     delay == null ? 0 : delay * 1000);
          res.status(200).send({"result": `Played ${command} via Chromecast.`});
        }
      }
      // If this is the ChromecastURL route
      else if (relayRoutes["chromecastURL"] != null && req.path === config.relays.chromecastURL.route) {
        // If we are missing contentType, error out
        if (!req.body.contentType) {
          logger.error(`Missing contentType. Aborting.`);
          res.status(500).send({"result": 'Server error, missing contentType.'});
        }
        else {
          logger.info(`Sending contentId=${command}, contentType=${req.body.contentType} via Chromecast for user ${user}.`);
          setTimeout(() => {cast.cast(config.users[user].chromecastFriendlyName,command,req.body.contentType)},
                     delay == null ? 0 : delay * 1000);
          res.status(200).send({"result": `Played ${command} via Chromecast.`});
        }
      }
      // If this is the Chromecast control route
      else if (relayRoutes["chromecastControl"] != null && req.path === config.relays.chromecastControl.route) {
        // Check whether valid command, sanitize
        if (req.body.command && (req.body.command === cast.PLAY ||
                                 req.body.command === cast.PAUSE ||
                                 req.body.command === cast.STOP ||
                                 (req.body.command === cast.SEEK &&
                                  req.body.currentTime &&
                                  Number.isInteger(req.body.currentTime) &&
                                  req.body.currentTime >= 0))) {
          let ctl = {type: req.body.command};
          if (req.body.command === cast.SEEK) ctl.currentTime = req.body.currentTime;
          logger.info(`Sending control request via Chromecast for user ${user}.`,ctl);
          setTimeout(() => {cast.control(config.users[user].chromecastFriendlyName,ctl)},
                     delay == null ? 0 : delay * 1000);
          res.status(200).send({"result": `Send control request ${command} via Chromecast.`});
        }
        else {
          logger.error(`Malformed request. Aborting.`);
          res.status(500).send({"result": 'Malfored request.'});
        }
      }
      // If this is broadcast text or custom
      else {
      // If this is a broadcast route, add broadcast
        if (relayRoutes["broadcast"] != null && req.path === config.relays.broadcast.route) {
          command = `broadcast ${command}`
        }
        logger.info(`Sending "${command}" for user ${user}.`);
        setTimeout(() => {sendTextInput(command, user)},
                   delay == null ? 0 : delay * 1000);
        res.status(200).send({"result": `Executed ${command}`});
      }
    }
    // Else bail
    else {
      logger.info(`Invalid relayKey for user ${user}, denying access.`);
      res.status(403).send({"result": `Access denied.`});
    }
  }
});

logger.debug(`Binding GET route for ${compositeRoute}`);
// Method not allowed for GET
router.get(compositeRoute, (req, res) => res.status(405).send({"result":`Method not allowed.`}));

logger.debug(`Binding all route for *`);
// 404s for everything else
router.all('*', (req, res) => res.status(404).send({"result":`Page not found.`}));

// express-winston logger first
app.use(expressWinston.logger(winstonConfig));
// Then router
app.use(router);
// Then express-winston error logger
app.use(expressWinston.errorLogger(winstonConfig));

// Typed array utility function
function concatenate(resultConstructor, ...arrays) {
    let totalLength = 0;
    for (let arr of arrays) {
        totalLength += arr.length;
    }
    let result = new resultConstructor(totalLength);
    let offset = 0;
    for (let arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}

// Callback from conversations
function startConversation(conversation, conversationCounter, user, bytes, format, continued) {
  conversation
    // Response: 'response'
    .on('response', (text) => {
      if (text) {
        logger.info(`Text response from Google Assistant.`,{"conversationCounter": conversationCounter,
                                                            "text": text});
        logger.info(`Broadcasting content of text response`);
        sendTextInput(`broadcast ${text}`, user);
      }
    })
    // Response: 'end-of-utterance'
    .on('end-of-utterance', () => {logger.debug(`Received end-of-utterance.`,{"conversationCounter": conversationCounter});})
    // Response: 'transcription' for speech to text - Unhandled as we're not issuing voice commands
    .on('transcription', (transcriptionResult) => {logger.debug(`Received transcription.`,{"conversationCounter": conversationCounter,
                                                                                           "transcriptionResult" : transcriptionResult});})
    // Response: 'audio-data' - concatenate frames
    .on('audio-data', (audioData) => {
      // We only care about audio-data content if we're saving the audio.
      logger.debug(`Receiving audio-data frame`,{"conversationCounter": conversationCounter, "audioDataFrameLength": audioData.length});
      if (!audioBuffers.hasOwnProperty(conversationCounter)) {
        logger.debug(`First frame of audio data - Initializing Int16 array.`,{"conversationCounter": conversationCounter});
        audioBuffers[conversationCounter] = new Int16Array(audioData);
      }
      else {
        logger.debug(`Continuing audio-data`,{"conversationCounter": conversationCounter, "audioDataFrameLength": audioData.length});
        audioBuffers[conversationCounter] = concatenate(Int16Array, audioBuffers[conversationCounter], new Int16Array(audioData));
      }
      logger.debug(`Received audio-data frame.`,{"conversationCounter": conversationCounter, "audioDataFrameLength": audioData.length,
                                                 "audioDataTotalLength": audioBuffers[conversationCounter].length});
    })
    // Response: 'device-action' - Unhandled as we're not a physical device
    .on('device-action', (deviceRequestJson) => {logger.debug(`Received device-action - Unhandled.`,{"conversationCounter": conversationCounter,
                                                                                                     "deviceRequestJson": deviceRequestJson});})
    // Reponse: 'volume-percent' - Unhandled as we're not a physical device
    .on('volume-percent', (volumePercent) => {logger.debug(`Received volume-percent - Unhandled.`,{"conversationCounter": conversationCounter,
                                                                                                   "volumePercent": volumePercent});})
    // Response: 'screen-data' - Unhandled as we don't have a screen
    .on('screen-data', (data) => {logger.debug(`Received screen-data - Unhandled.`,{"conversationCounter": conversationCounter,
                                                                                    "data": data});})
    // Response: 'ended'
    .on('ended', (error, continueConversation) => {
      if (error) logger.error(`Error while conducting conversation; conversation ended.`,{"conversationCounter": conversationCounter,
                                                                                          "error": error});
      else {
        if (continueConversation) {
          logger.debug(`Conversation ended with invitation to continue.`,{"conversationCounter": conversationCounter});
          if (bytes) {
            logger.debug(`Have audio bytes to continue conversation; sending.`,{"conversationCounter": conversationCounter});
            assistants[user].start({"audio":{"encodingOut": AUDIO_OUT_LINEAR16,
                                             "sampleRateOut": 16000,
                                             "encodingIn": format}},
                          (conversation) => startConversation(conversation,conversationCounter,user,bytes,format,true));
          }
        }
        else {
          if (audioBuffers.hasOwnProperty(conversationCounter)) { // We are ending a conversation that included audio
            if (config.saveAudioFiles) {
              logger.info(`Conversation ended with audio content; flushing to disk.`,{"conversationCounter":conversationCounter});
              try {
                fs.writeFileSync(`./audio-${conversationCounter}.lpcm16`, Buffer.from(audioBuffers[conversationCounter]));
              }
              catch (err) {
                logger.error(`Unable to save audio response file.`,{"conversationCounter": conversationCounter,
                                                                              "path": `./audio-${conversationCounter}.mp3`,
                                                                              "error": err});
              }
            }
            delete audioBuffers[conversationCounter];
          }
          logger.debug(`Conversation ended.`,{"conversationCounter":conversationCounter});
          conversation.end();
        }
      }
    })
    // Response: 'error'
    .on('error', (error) => {
      logger.error(`Google Assistant returned error.`,{"conversationCounter": conversationCounter,
                                                       "error": error});
      conversation.end();
    });

    // If we are responding to a continued conversation with audio we're sending (e.g. broadcast audio)
    if (bytes && continued) {
      logger.info(`Sending audio in response to continued conversation.`,{"conversationCounter": conversationCounter,
                                                                          "audioDataTotalLength": bytes.length});
      let i;
      for (i = 0; i < bytes.length; i+= 1600) {
        logger.debug(`Sending frame; indexes ${i} to ${i+1600 < bytes.length ? i+1600 : bytes.length} of ${bytes.length}`,
                     {"conversationCounter": conversationCounter});
        conversation.write(bytes.subarray(i,i+1600 < bytes.length ? i+1600 : bytes.length));
      }
      // Write a bunch of silence
      conversation.write(silence);
  }
}

// Our primary method of interacting with Google Assistant
function sendTextInput(text, user) {
  if (!config.users.hasOwnProperty(user)) {
    logger.error(`User ${user} not found, aborting request ${text}.`);
  } 
  else {
    logger.info(`Received request ${text} for user ${user}.`);
    let assistant = assistants[user];
    assistant.start({"textQuery":text,"language":config.language,
                    "audio": {"encodingOut": AUDIO_OUT_LINEAR16,
                              "sampleRateOut": 16000}},
                    (conversation) => startConversation(conversation,conversationCounter++,user));
  }
}

// For broadcasting audio files (only FLAC and LPCM supported by the Google Assistant API)
function sendBroadcastAudio(path, user, format) {
  if (!config.users.hasOwnProperty(user)) {
    logger.error(`User ${user} not found, aborting request ${text}.`);
  } 
  else {
    let bytes;
    logger.info(`Received request to broadcast ${path} in format ${format} for user ${user}.`);
    let assistant = assistants[user];
    logger.debug(`Opening audio file ${path}`)
    try {
      bytes = new Int16Array(fs.readFileSync(path));
    }
    catch (err) {logger.error(`Unable to load file ${path}`, err);};

    logger.debug(`Sending initial "broadcast" message to preface audio`);
    assistant.start({"textQuery": "broadcast","language":config.language,
                     "audio":{"encodingOut": AUDIO_OUT_LINEAR16},
                              "sampleRateIn": 16000},
                    (conversation) => startConversation(conversation,conversationCounter++,user,bytes,format));
  }
}

logger.info(`Starting external relay server.`);
// If settings are present for TLS creds
if (config.certPrivKeyPath && config.certPath) {
  try {
    https.createServer({key: fs.readFileSync(config.certPrivKeyPath),
                        cert: fs.readFileSync(config.certPath)},
                       app).listen(config.port, () => logger.info(`HTTPS server started on port ${config.port}.`));
  }
  catch (err) {logger.error (`Problem creating server with TLS credentials.`,err);};
}
else {
  app.listen(config.port, () => logger.info(`HTTP Server created on port ${config.port}.`));
}
logger.info(`Relay online.`);
if (config.relays.chromecastAudio.on || config.relays.chromecastTTS.on) {
  staticApp = express();
  logger.info(`Starting internal media server endpoint.`);
  // If there's a whitelist, apply it to the static server app
  if (config.staticServer.whitelist && config.staticServer.whitelist !== "") {
    logger.info(`Configuring media static app to whitelist IPs`,{"staticServerWhitelist":config.staticServer.whitelist});
    staticApp.use(ipfilter(config.staticServer.whitelist, {mode: 'allow'}));
  }
  staticApp.use(expressWinston.logger(winstonConfig));
  // serve-static for serving media files for Chromecast
  staticApp.use(config.staticServer.route,serveStatic(config.staticServer.path));
  // If TTS enabled, add fallback directory for static service iff the two paths are different
  if (config.relays.chromecastTTS.on && config.staticServer.path !== config.relays.chromecastTTS.cachePath) 
    staticApp.use(config.staticServer.route,serveStatic(config.relays.chromecastTTS.cachePath));
  staticApp.use(expressWinston.errorLogger(winstonConfig));
  staticApp.listen(config.staticServer.port, () => logger.info(`Static server started on port ${config.staticServer.port}.`));
  logger.info(`Media server online.`);
};

// Quick-and-dirty forcing of sequential callbacks to wait on stdin.
// Kludge, but the number of users should be small enough for a shallow call stack.
function configureNextUser(userKeys) {
  let user = userKeys.shift();
  logger.debug(`Creating assistant for user ${user}.`);
  let assistant = new GoogleAssistant({"savedTokensPath":config.users[user].savedTokensPath,"keyFilePath":config.keyFilePath});
  assistant
    .on('ready', function() {
      logger.info(`Assistant for ${user} ready.`);
      assistants[user] = this;
      if (userKeys.length > 0) configureNextUser(userKeys);
    })
    .on('error', (e) => {
      logger.error(`Assistant Error when activating user ${k}.`,e); 
   })
}

// Set up assistants. We do this sequentially in case of re-auth. Delay to clean up log
setTimeout(() => configureNextUser(Object.keys(config.users)),500);

// Check whether any users were successfully configured
if (assistants.length === 0) {
  logger.error(`No assistants configured. Exiting.`);
  process.exit(1);
}