import logger from 'common-files/utils/logger.mjs';
import app from './app.mjs';
import {
  startEventQueue,
  subscribeToBlockAssembledWebSocketConnection,
  subscribeToChallengeWebSocketConnection,
  eventHandlers,
} from './event-handlers/index.mjs';
import Proposer from './classes/proposer.mjs';
import {
  conditionalMakeBlock,
  setBlockAssembledWebSocketConnection,
} from './services/block-assembler.mjs';
import { setChallengeWebSocketConnection } from './services/challenges.mjs';
import initialBlockSync from './services/state-sync.mjs';
import { queueManager } from './services/event-queue.mjs';

const main = async () => {
  try {
    const proposer = new Proposer();
    // subscribe to WebSocket events first
    await subscribeToBlockAssembledWebSocketConnection(setBlockAssembledWebSocketConnection);
    await subscribeToChallengeWebSocketConnection(setChallengeWebSocketConnection);
    // try to sync any missing blockchain state
    // only then start making blocks and listening to new proposers
    initialBlockSync(proposer).then(() => {
      startEventQueue(queueManager, eventHandlers, proposer);
      conditionalMakeBlock(proposer);
    });
    app.listen(80);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
};

main();
