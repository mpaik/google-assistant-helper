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
const AUDIO_IN_LINEAR16 = "LINEAR16";

const AUDIO_OUT_LINEAR16 = "LINEAR16";

const MAX_BUFFER_LENGTH = 280000,
      MAX_SILENCE_LENGTH = 8000,
      SILENCE_THRESHOLD = 100;

const validRelays = ["broadcast", "broadcastAudio", "custom", "chromecastAudio",
                        "chromecastTTS", "chromecastURL", "chromecastControl"];

const tts = (config.relays.chromecastTTS.on) ? require('@google-cloud/text-to-speech') : null;
const ttsClient = (tts) ? new tts.TextToSpeechClient({keyFilename: `${config.relays.chromecastTTS.apiCredentialPath}`}) : null;

const silence = new Int16Array(32000); // one second of silence, initialized to 0

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

var router = express.Router({caseSensitive: true});

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
        else if (!(config.relays.broadcastAudio.sounds[command].format === AUDIO_OUT_LINEAR16)) {
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
        setTimeout(() => {sendTextInput(command, user, req.body.broadcastAudioResponse)},
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

// Chunk a large audio buffer into several smaller buffers at silence points
function chunkBuffer(buf, minSamples, maxLength, threshold) {
  let bufs = [];
  let start = 0;
  let end = null;

  let endMarks = [];

  logger.debug(`Chunking buffer of length ${buf.length} with maximum chunk length ${maxLength} with minimum silence length ${minSamples} samples.`);

  for (let i = 0; i < buf.length; i+=2) {
    if (buf.readInt16LE(i) < threshold) {
      if (end == null) { // If this is the beginning fencepost
        start = i;
      }
      end = i;
    }
    else if (end != null) { // If we are ending a window of silence
      if (end-start+2 > minSamples) {
        // If we under the boundary and if this is long enough, mark end
        if (i < maxLength) {
          endMarks.push(i);
        }
        // If we have crossed the maximum length, slice and start over
        else {
          // If we have no silences, abort
          if (endMarks.length == 0) {
            logger.error(`Unable to create chunk shorter than ${maxLength} from buffer. Aborting.`);
            throw `Unable to create chunk shorter than ${maxLength} from buffer. Aborting.`;
          }
          logger.debug(`Creating chunk of length ${endMarks[endMarks.length-1]}, less than ${maxLength}.`,endMarks);
          bufs.push(buf.slice(0,endMarks[endMarks.length-1]));
          buf = buf.slice(endMarks[endMarks.length-1]);
          i = 0;
          start = 0;
          endMarks = [];
        }
        end = null;
      }
    }
  }
  // Append last chunk
  bufs.push(buf);
  return bufs;
}

// Truncate any silences to at most maxSamples samples
function truncateSilences(buf, maxSamples, threshold) {
  let start = 0;
  let end = null;

  for (let i = 0; i < buf.length; i+=2) {
    if (buf.readInt16LE(i) < threshold) {
      if (end == null) { // If this is the beginning fencepost
        start = i;
      }
      end = i;
    }
    else if (end != null) { // If we are ending a window of silence
      if (end-start+2 > maxSamples) { 
        let deleteCount = end-start-maxSamples+2;
        buf = Buffer.concat([buf.slice(0,start),buf.slice(start+deleteCount)]);

        // Move fencepost
        i -= deleteCount;
      }
      end = null;
    }
  }
  return buf;
}

// Callback from conversations
function startConversation(conversation, conversationCounter, user, buf, format, continued, broadcastAudioResponse) {
  conversation
    // Response: 'response'
    .on('response', (text) => {
      if (text) {
        logger.info(`Text response from Google Assistant.`,{"conversationCounter": conversationCounter,
                                                            "text": text});
        // If we're not expecting audio to supercede text (e.g. jokes)
        if (!broadcastAudioResponse) {
          logger.info(`Broadcasting content of text response`);
          sendTextInput(`broadcast ${text}`, user);
        }
      }
    })
    // Response: 'end-of-utterance'
    .on('end-of-utterance', () => {logger.debug(`Received end-of-utterance.`,{"conversationCounter": conversationCounter});})
    // Response: 'transcription' for speech to text - Unhandled as we're not issuing voice commands
    .on('transcription', (transcriptionResult) => {
      if (transcriptionResult.done) {
        logger.debug(`Received completed transcription.`,{"conversationCounter": conversationCounter,
                                                          "transcriptionResult" : transcriptionResult});
      }
      else { // Not done
        logger.silly(`Received intermediate transcription.`,{"conversationCounter": conversationCounter,
                                                             "transcriptionResult" : transcriptionResult});
      }
    })
    // Response: 'audio-data' - concatenate frames
    .on('audio-data', (audioData) => {
      // We only care about audio-data content if we're saving the audio.
      logger.silly(`Receiving audio-data frame`,{"conversationCounter": conversationCounter, "audioDataFrameLength": audioData.length});
      if (!audioBuffers.hasOwnProperty(conversationCounter)) {
        logger.debug(`First frame of audio data - Initializing.`,{"conversationCounter": conversationCounter});
        audioBuffers[conversationCounter] = audioData;
      }
      else {
        logger.silly(`Continuing audio-data`,{"conversationCounter": conversationCounter, "audioDataFrameLength": audioData.length});
        audioBuffers[conversationCounter] = Buffer.concat([audioBuffers[conversationCounter],audioData]);
      }
      logger.silly(`Received audio-data frame.`,{"conversationCounter": conversationCounter, "audioDataFrameLength": audioData.length,
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
        if (audioBuffers.hasOwnProperty(conversationCounter)) { // We are ending a conversation that included audio
          if (config.saveAudioFiles) {
            logger.info(`Conversation ended with audio content; flushing to disk.`,{"conversationCounter":conversationCounter});
            try {
              fs.writeFileSync(`./audio-${conversationCounter}.lpcm16`, audioBuffers[conversationCounter]);
            }
            catch (err) {
              logger.error(`Unable to save audio response file.`,{"conversationCounter": conversationCounter,
                                                                            "path": `./audio-${conversationCounter}.lpcm16`,
                                                                            "error": err});
            }
          }
          if (broadcastAudioResponse) {
            logger.info(`Conversation ended with audio content; broadcasting.`,{"conversationCounter":conversationCounter});
            // TODO let bufs = chunkBuffer(audioBuffers[conversationCounter],16000,100000,10);
            let audioBuffer = truncateSilences(audioBuffers[conversationCounter],MAX_SILENCE_LENGTH,SILENCE_THRESHOLD);

            sendBroadcastAudioBuffer(audioBuffer,user,AUDIO_OUT_LINEAR16);
          }
          delete audioBuffers[conversationCounter];
        }
        if (continueConversation) {
          logger.debug(`Conversation ended with invitation to continue.`,{"conversationCounter": conversationCounter});
          if (buf) {
            logger.debug(`Have audio buffer to continue conversation; sending.`,{"conversationCounter": conversationCounter});
            assistants[user].start({"audio":{"encodingOut": AUDIO_OUT_LINEAR16,
                                             "sampleRateOut": 16000,
                                             "encodingIn": format}},
                          (conversation) => startConversation(conversation,conversationCounter,user,buf,format,true));
          }
        }
        else {
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
    if (buf && continued) {
      logger.info(`Sending audio in response to continued conversation.`,{"conversationCounter": conversationCounter,
                                                                          "audioDataTotalLength": buf.length});
      let i;
      for (let i = 0; i < buf.length; i+= 16000) {
        logger.silly(`Sending frame; indexes ${i} to ${i+16000 < buf.length ? i+16000 : buf.length} of ${buf.length}`,
                     {"conversationCounter": conversationCounter});
        conversation.write(buf.slice(i,i+16000 < buf.length ? i+16000 : buf.length));
      }
      logger.debug(`Sent ${buf.length} bytes.`,{"conversationCounter": conversationCounter,
                                                  "audioDataTotalLength": buf.length});
      // Write a bunch of silence
      conversation.write(silence);
  }
}

// Our primary method of interacting with Google Assistant
function sendTextInput(text, user, broadcastAudioResponse) {
  if (!config.users.hasOwnProperty(user)) {
    logger.error(`User ${user} not found, aborting request ${text}.`);
  } 
  else {
    logger.info(`Received request "${text}"" for user ${user}.`);
    let assistant = assistants[user];
    assistant.start({"textQuery":text,"language":config.language,
                    "audio": {"encodingOut": AUDIO_OUT_LINEAR16,
                              "sampleRateOut": 16000}},
                    (conversation) => startConversation(conversation,conversationCounter++,user,null,null,false,broadcastAudioResponse));
  }
}

function sendBroadcastAudio(path,user,format) {
  let buf;
  logger.info(`Received request to broadcast ${path} in format ${format} for user ${user}.`);
  logger.debug(`Opening audio file ${path}`)
  try {
    buf = new fs.readFileSync(path);
  }
  catch (err) {logger.error(`Unable to load file ${path}`, err);};    
  sendBroadcastAudioBuffer(buf,user,format);
}

// For broadcasting audio files
function sendBroadcastAudioBuffer(buf,user,format) {
  if (!config.users.hasOwnProperty(user)) {
    logger.error(`User ${user} not found, aborting request ${text}.`);
  }
  else if (buf.length > MAX_BUFFER_LENGTH) {
    logger.warn(`Audio buffer has length ${buf.length}, which is too long. Aborting.`);
  }
  else {
    let assistant = assistants[user];

    logger.debug(`Sending initial "broadcast" message to preface audio`);
    assistant.start({"textQuery": "broadcast","language":config.language,
                     "audio":{"encodingOut": AUDIO_OUT_LINEAR16},
                              "sampleRateIn": 16000},
                    (conversation) => startConversation(conversation,conversationCounter++,user,buf,format));
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
  staticApp.set('case sensitive routing', true);
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