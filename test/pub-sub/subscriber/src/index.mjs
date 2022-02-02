/**
Module that runs up as a subscriber
*/
import logger from 'common-files/utils/logger.mjs';
import config from 'config';
import { device } from 'aws-iot-device-sdk';
import axios from 'axios';
import Nf3 from '../../../../cli/lib/nf3.mjs';

const {
  optimistWsUrl,
  web3WsUrl,
  clientBaseUrl,
  optimistBaseUrl,
  userEthereumSigningKey,
  zkpMnemonic,
} = config;

const Topic = 'Nightfall-Publisher';

let client;
let iotTopic;
let nRxBlocks = 0;

const onConnect = () => {
  client.subscribe(iotTopic);
  logger.info('Connected');
};

const onMessage = (topic, message) => {
  nRxBlocks += 1;
  logger.info(`Message[${topic}]: ${message}`);
};

const onError = () => {};
const onReconnect = () => {};
const onOffline = () => {};

const onClose = () => {
  logger.info('Connection failed');
};

const IoT = {
  connect: (topic, iotEndpoint, region, accessKey, secretKey, sessionToken) => {
    console.log('Rx', topic, iotEndpoint);
    iotTopic = topic;

    client = device({
      region,
      protocol: 'wss',
      accessKeyId: accessKey,
      secretKey,
      sessionToken,
      port: 443,
      host: iotEndpoint,
    });

    client.on('connect', onConnect);
    client.on('message', onMessage);
    client.on('error', onError);
    client.on('reconnect', onReconnect);
    client.on('offline', onOffline);
    client.on('close', onClose);
  },

  send: message => {
    client.publish(iotTopic, message);
  },
};

async function getKeys() {
  const res = await axios.get(process.env.PUBLISHER_KEYS_URL);
  return res.data;
}

/**
Does the preliminary setup and starts listening on the websocket
*/
async function subscriberTest() {
  logger.info(`Connecting subscriber to IOT service...`);
  logger.info(`Retrieving Keys from ${process.env.PUBLISHER_KEYS_URL}...`);
  const keys = await getKeys();
  logger.info(`Keys: ${JSON.stringify(keys)}`);
  IoT.connect(
    Topic,
    keys.iotEndpoint,
    keys.region,
    keys.accessKey,
    keys.secretKey,
    keys.sessionToken,
  );

  const nf3 = new Nf3(web3WsUrl, userEthereumSigningKey, {
    clientApiUrl: clientBaseUrl,
    optimistApiUrl: optimistBaseUrl,
    optimistWsUrl,
  });
  await nf3.init(zkpMnemonic);
  if (await nf3.healthcheck('client')) logger.info('Healthcheck passed');
  else throw new Error('Healthcheck failed');
  let retries = 0;
  while (retries < 1) {
    retries += 1;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 30000));
  }

  if (nRxBlocks > 0) {
    logger.info('Test passed');
  } else {
    logger.info('Test failed');
  }
  nf3.close();
}

subscriberTest();
