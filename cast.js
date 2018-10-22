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

const PLAY = "PLAY",
			PAUSE = "PAUSE",
			STOP = "STOP",
			SEEK = "SEEK";

const Client = require('castv2-client').Client,
	  DefaultMediaReceiver = require('castv2-client').DefaultMediaReceiver,
	  mdns = require('mdns'),
	  logger = require('winston');

const ResolverSequence = [
	  	mdns.rst.DNSServiceResolve(),
	  	'DNSServiceGetAddrInfo' in mdns.dns_sd ? mdns.rst.DNSServiceGetAddrInfo() : mdns.rst.getaddrinfo({ families: [4] }),
	  	mdns.rst.makeAddressesUnique()
	  ];

const chromecasts = {};
const players = {};

// Create an mDNS browser to listen for Google Chromecast advertisements
var browser = mdns.createBrowser(mdns.tcp('googlecast'),{"resolverSequence": ResolverSequence});

// Listen for Google Chromecast advertisements
browser
  // Service advertised
  .on('serviceUp', service => {
    logger.info(`Found service.`,
			    {"serviceName": service.name,
	  			 "friendlyName": service.txtRecord.fn,
	  			 "address": service.addresses[0],
	  			 "port": service.port});
    logger.info(`Adding service "${service.txtRecord.fn}".`);
	  chromecasts[service.txtRecord.fn] = {"host": service.addresses[0], "port": service.port};
	})
	// Service down
	.on('servicedown', service => {
	  logger.info('Service stopped.',
	  			   {"serviceName": service.name,
	  			    "friendlyName": service.txtRecord.fn,
	  			    "address": service.addresses[0],
	  			    "port": service.port});
	})
	// Asynchronous error
	.on('error', err => {
	  logger.error('Asynchronous error.',err)
	});

browser.start();

// Control media that is being played
// commandObj is of the form {type: "SEEK", currentTime: 60};
function control(serviceName, commandObj, cb) {
	if (!chromecasts[serviceName]) {
		logger.error(`Invalid service name, aborting.`,{"serviceName": serviceName});
	}
	else if (!players[serviceName]) {
		logger.error(`Cannot control non-existent player, aborting.`,{"serviceName": serviceName});
	}
	else {
		let player = players[serviceName];
		if (commandObj.type === PLAY) {
			logger.info(`Playing ${serviceName}.`);
			player.play((err,status) => {
				if (err) logger.error(`Problem while playing media for ${serviceName}.`,err);
				else {
					logger.info(`Status returned from ${serviceName}:`,status);
				}
			});
		}
		else if (commandObj.type === PAUSE) {
			logger.info(`Pausing ${serviceName}.`);
			player.pause((err,status) => {
				if (err) logger.error(`Problem while pausing media for ${serviceName}.`,err);
				else {
					logger.info(`Status returned from ${serviceName}:`,status);
				}
			});
		}
		else if (commandObj.type === STOP) {
			logger.info(`Stopping ${serviceName}.`);
			player.stop((err,status) => {
				if (err) logger.error(`Problem while stopping media for ${serviceName}.`,err);
				else {
					logger.info(`Status returned from ${serviceName}:`,status);
				}
			});
		}
		else if (commandObj.type === SEEK) {
			if (!commandObj.currentTime || !Number.isInteger(commandObj.currentTime) || commandObj.currentTime < 0) {
				logger.error(`Invalid seek request, missing or invalid time signature.`,commandObj)
			}
			else {
				logger.info(`Seeking ${serviceName} to ${commandObj.currentTime} seconds.`);
				player.seek(commandObj.currentTime,(err,status) => {
					if (err) logger.error(`Problem while seeking media for ${serviceName}.`,err);
					else {
						logger.info(`Status returned from ${serviceName}:`,status);
					}
				});
			}
		}
	}	
}

function cast(serviceName, mediaUrl, mediaType, cb) {
	if (!chromecasts[serviceName]) {
		logger.error(`Invalid service name, aborting.`,{"serviceName": serviceName});
		return
	}
	logger.debug(`Creating cast client for service ${serviceName}.`);
	let client = new Client();
	logger.debug(`Connecting to cast client.`,{serviceName: chromecasts[serviceName]});
	client.connect(chromecasts[serviceName], () => {
		logger.info(`Connected to service. Loading media.`,{"mediaUrl": mediaUrl});
		client.launch(DefaultMediaReceiver, (err,player) => {
			let media = {
				contentId: mediaUrl,
				contentType: mediaType,
				streamType: `BUFFERED`
			}
			players[serviceName] = player;
      player.on('status', (status) => {
      	logger.info(`Player state for ${serviceName}: ${status.playerState}`, status);
      });
      logger.info(`Playing media on ${player.session.displayName} on ${serviceName}`, media);

      // Actually play the media
      player.load(media, { autoplay: true }, (err, status) => {
      	if (err) logger.error(`Problem playing media.`,err);
      	else logger.info(`Media playing. Player state for ${serviceName}: ${status.playerState}`);
			})
		});
	});

	client.on('error', function(err) {
		logger.error(`Client returned error. Closing.`, err)
	  client.close();
	  players[serviceName] = null;
	});
};

module.exports = {cast: cast, control: control, PLAY: PLAY, PAUSE: PAUSE, STOP: STOP, SEEK: SEEK};
