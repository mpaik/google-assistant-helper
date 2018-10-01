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

function cast(serviceName, mediaUrl, mediaType, cb) {
	if (!chromecasts[serviceName]) {
		logger.error(`Invalid service name, aborting.`,{"serviceName": serviceName});
		return
	}
	logger.debug(`Creating cast client for service ${serviceName}.`);
	let client = new Client();
	logger.debug(`Created cast client. Connecting.`,{serviceName: chromecasts[serviceName]});
	client.connect(chromecasts[serviceName], () => {
		logger.info(`Connected to service. Loading media.`,{"mediaUrl": mediaUrl});
		client.launch(DefaultMediaReceiver, (err,player) => {
			let media = {
				contentId: mediaUrl,
				contentType: mediaType,
				streamType: `BUFFERED`
			}
      player.on('status', (status) => {
      	logger.info(`Player state: ${status.playerState}`, status);
      });
      logger.info(`Playing media on ${player.session.displayName}`, media);

      // Actually play the media
      player.load(media, { autoplay: true }, (err, status) => {
      	if (err) logger.error(`Problem playing media.`,err);
      	else logger.info(`Media playing. Player state: ${status.playerState}`);
			})
		});
	});

	client.on('error', function(err) {
	logger.error(`Client returned error. Closing.`, err)
	  client.close();
	});
};

module.exports = cast;