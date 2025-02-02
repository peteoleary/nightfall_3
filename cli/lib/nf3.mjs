import axios from 'axios';
import Queue from 'queue';
import Web3 from 'web3';
import WebSocket from 'ws';
import ReconnectingWebSocket from 'reconnecting-websocket';
import EventEmitter from 'events';
import logger from '../../common-files/utils/logger.mjs';
import { approve } from './tokens.mjs';
import erc20 from './abis/ERC20.mjs';
import erc721 from './abis/ERC721.mjs';
import erc1155 from './abis/ERC1155.mjs';

import {
  DEFAULT_BLOCK_STAKE,
  DEFAULT_PROPOSER_BOND,
  DEFAULT_FEE,
  WEBSOCKET_PING_TIME,
  GAS_MULTIPLIER,
  GAS,
  GAS_PRICE,
  GAS_PRICE_MULTIPLIER,
  GAS_ESTIMATE_ENDPOINT,
} from './constants.mjs';

// TODO when SDK is refactored such that these functions are split by user, proposer and challenger,
// then there will only be one queue here. The constructor does not need to initialise clientBaseUrl
// for proposer/liquidityProvider/challenger and optimistBaseUrl, optimistWsUrl for a user etc
const userQueue = new Queue({ autostart: true, concurrency: 1 });
const proposerQueue = new Queue({ autostart: true, concurrency: 1 });
const challengerQueue = new Queue({ autostart: true, concurrency: 1 });
const liquidityProviderQueue = new Queue({ autostart: true, concurrency: 1 });

/**
@class
Creates a new Nightfall_3 library instance.
@param {string} clientBaseUrl - The base url for nightfall-client
@param {string} optimistBaseUrl - The base url for nightfall-optimist
@param {string} optimistWsUrl - The webscocket url for nightfall-optimist
@param {string} web3WsUrl - The websocket url for the web3js client
@param {string} ethereumSigningKey - the Ethereum siging key to be used for transactions (hex string).
@param {object} zkpKeys - An object containing the zkp keys to use.  These will be auto-generated if left undefined.
*/
class Nf3 {
  clientBaseUrl;

  optimistBaseUrl;

  optimistWsUrl;

  web3WsUrl;

  web3;

  websockets = [];

  intervalIDs = [];

  shieldContractAddress;

  proposersContractAddress;

  challengesContractAddress;

  stateContractAddress;

  ethereumSigningKey;

  ethereumAddress;

  zkpKeys;

  defaultFee = DEFAULT_FEE;

  PROPOSER_BOND = DEFAULT_PROPOSER_BOND;

  BLOCK_STAKE = DEFAULT_BLOCK_STAKE;

  // nonce = 0;

  latestWithdrawHash;

  mnemonic = {};

  contracts = { ERC20: erc20, ERC721: erc721, ERC1155: erc1155 };

  currentEnvironment;

  constructor(
    ethereumSigningKey,
    environment = {
      clientApiUrl: 'http://localhost:8080',
      optimistApiUrl: 'http://localhost:8081',
      optimistWsUrl: 'ws://localhost:8082',
      web3WsUrl: 'ws://localhost:8546',
    },
    zkpKeys,
  ) {
    this.clientBaseUrl = environment.clientApiUrl;
    this.optimistBaseUrl = environment.optimistApiUrl;
    this.optimistWsUrl = environment.optimistWsUrl;
    this.web3WsUrl = environment.web3WsUrl;
    this.ethereumSigningKey = ethereumSigningKey;
    this.zkpKeys = zkpKeys;
    this.currentEnvironment = environment;
  }

  /**
    Initialises the Nf_3 object so that it can communicate with Nightfall_3 and the
    blockchain.
    @returns {Promise}
    */
  async init(mnemonic, contractAddressProvider) {
    await this.setWeb3Provider();
    logger.debug(
      `Initialising NF3 with mnemonic: ${mnemonic} and contractAddressProvider: ${contractAddressProvider}`,
    );
    // this code will call client to get contract addresses, or optimist if client isn't deployed
    switch (contractAddressProvider) {
      case undefined:
        this.contractGetter = this.getContractAddress;
        break;
      case 'client':
        this.contractGetter = this.getContractAddress;
        break;
      case 'optimist':
        this.contractGetter = this.getContractAddressOptimist;
        break;
      default:
        throw new Error('Unknown contract address server');
    }
    logger.debug(`Using this.contractGetter: ${contractAddressProvider}`);
    // once we know where to ask, we can get the contract addresses
    this.shieldContractAddress = await this.contractGetter('Shield');
    this.proposersContractAddress = await this.contractGetter('Proposers');
    this.challengesContractAddress = await this.contractGetter('Challenges');
    this.stateContractAddress = await this.contractGetter('State');
    // set the ethereumAddress iff we have a signing key
    if (typeof this.ethereumSigningKey === 'string') {
      this.ethereumAddress = await this.getAccounts();
    }
    // set zkp keys from mnemonic if provided
    if (typeof mnemonic !== 'undefined') {
      await this.setzkpKeysFromMnemonic(mnemonic, 0);
    }
  }

  /**
    Setter for the ethereum private key, in case it wasn't known at build time.
    This will also update the corresponding Ethereum address that Nf_3 uses.
    @method
    @param {string} key - the ethereum private key as a hex string.
    */
  async setEthereumSigningKey(key) {
    this.ethereumSigningKey = key;
    this.ethereumAddress = await this.getAccounts();
    // clear the nonce as we're using a fresh account
    // this.nonce = 0;
  }

  /**
    Setter for the zkp keys, in case it wasn't known at build time and we don't
    want to use autogenerated ones.
    @method
    @param {object} keys - The zkp keys object.
    */
  setzkpKeys(keys) {
    this.zkpKeys = keys;
    return this.subscribeToIncomingViewingKeys();
  }

  /**
    Setter for the zkp keys by mnemonic, in case it wasn't known at build time and we don't
    want to use autogenerated ones.
    @method
    @param {string} mnemonic - 12 word phrase
    @param {number} addressIndex - Index used to generate keys combined with mnemonic
    */
  async setzkpKeysFromMnemonic(mnemonic, addressIndex) {
    if (mnemonic !== '') {
      this.mnemonic.phrase = mnemonic;
    }
    this.mnemonic.addressIndex = addressIndex.toString();
    this.zkpKeys = (
      await axios.post(`${this.clientBaseUrl}/generate-keys`, {
        mnemonic: this.mnemonic.phrase,
        path: `m/44'/60'/0'/${this.mnemonic.addressIndex}`,
      })
    ).data;
    return this.subscribeToIncomingViewingKeys();
  }

  /**
    Gets the number of unprocessed transactions on the optimist
    @method
    @async
    */

  async unprocessedTransactionCount() {
    const { result: mempool } = (await axios.get(`${this.optimistBaseUrl}/proposer/mempool`)).data;
    return mempool.filter(e => e.mempool).length;
  }

  /**
  Forces optimist to make a block with whatever transactions it has to hand i.e. it won't wait
  until it has TRANSACTIONS_PER_BLOCK of them
  @method
  @async
  */
  async makeBlockNow() {
    return axios.get(`${this.optimistBaseUrl}/block/make-now`);
  }

  async estimateGas(contractAddress, unsignedTransaction) {
    let gasLimit;
    try {
      // eslint-disable-next-line no-await-in-loop
      gasLimit = await this.web3.eth.estimateGas({
        from: this.ethereumAddress,
        to: contractAddress,
        data: unsignedTransaction,
      });
    } catch (error) {
      logger.warn(`estimateGas failed. Falling back to constant value`);
      gasLimit = GAS; // backup if estimateGas failed
    }
    return Math.ceil(Number(gasLimit) * GAS_MULTIPLIER); // 50% seems a more than reasonable buffer.
  }

  async estimateGasPrice() {
    let proposedGasPrice;
    try {
      // Call the endpoint to estimate the gas fee.
      const res = (await axios.get(GAS_ESTIMATE_ENDPOINT)).data.result;
      proposedGasPrice = Number(res?.ProposeGasPrice) * 10 ** 9;
    } catch (error) {
      logger.warn('Gas Estimation Failed, using previous block gasPrice');
      try {
        proposedGasPrice = Number(await this.web3.eth.getGasPrice());
      } catch (err) {
        logger.warn('Failed to get previous block gasprice.  Falling back to default');
        proposedGasPrice = GAS_PRICE;
      }
    }
    return Math.ceil(proposedGasPrice * GAS_PRICE_MULTIPLIER);
  }

  /**
  Method for signing and submitting an Ethereum transaction to the
  blockchain.
  @method
  @async
  @param {object} unsignedTransaction - An unsigned web3js transaction object.
  @param {string} shieldContractAddress - The address of the Nightfall_3 shield address.
  @param {number} fee - the value of the transaction.
  This can be found using the getContractAddress convenience function.
  @returns {Promise} This will resolve into a transaction receipt.
  */
  async submitTransaction(
    unsignedTransaction,
    contractAddress = this.shieldContractAddress,
    fee = this.defaultFee,
  ) {
    // estimate the gasPrice
    const gasPrice = await this.estimateGasPrice();
    // Estimate the gasLimit
    const gas = await this.estimateGas(contractAddress, unsignedTransaction);
    logger.debug(
      `Transaction gasPrice was set at ${Math.ceil(
        gasPrice / 10 ** 9,
      )} GWei, gas limit was set at ${gas}`,
    );
    const tx = {
      from: this.ethereumAddress,
      to: contractAddress,
      data: unsignedTransaction,
      value: fee,
      gas,
      gasPrice,
    };

    // logger.debug(`The nonce for the unsigned transaction ${tx.data} is ${this.nonce}`);
    // this.nonce++;
    if (this.ethereumSigningKey) {
      const signed = await this.web3.eth.accounts.signTransaction(tx, this.ethereumSigningKey);
      const promiseTest = new Promise((resolve, reject) => {
        this.web3.eth
          .sendSignedTransaction(signed.rawTransaction)
          .once('receipt', receipt => {
            logger.debug(`Transaction ${receipt.transactionHash} has been received.`);
            resolve(receipt);
          })
          .on('error', err => {
            reject(err);
          });
      });
      return promiseTest;
    }
    return this.web3.eth.sendTransaction(tx);
  }

  /**
    Determines if a Nightfall_3 server is running and healthy.
    @method
    @async
    @param {string} server - The name of the server being checked ['client', 'optimist']
    @returns {Promise} This will resolve into a boolean - true if the healthcheck passed.
    */
  async healthcheck(server) {
    let url;
    switch (server) {
      case 'client':
        url = this.clientBaseUrl;
        break;
      case 'optimist':
        url = this.optimistBaseUrl;
        break;
      default:
        throw new Error('Unknown server name');
    }
    let res;
    try {
      res = await axios.get(`${url}/healthcheck`);
      if (res.status !== 200) return false;
    } catch (err) {
      return false;
    }
    return true;
  }

  /**
    Returns the address of a Nightfall_3 contract calling the client.
    @method
    @async
    @param {string} contractName - the name of the smart contract in question. Possible
    values are 'Shield', 'State', 'Proposers', 'Challengers'.
    @returns {Promise} Resolves into the Ethereum address of the contract
    */
  async getContractAddress(contractName) {
    const res = await axios.get(`${this.clientBaseUrl}/contract-address/${contractName}`);
    return res.data.address.toLowerCase();
  }

  /**
    Returns the address of a Nightfall_3 contract calling the optimist.
    @method
    @async
    @param {string} contractName - the name of the smart contract in question. Possible
    values are 'Shield', 'State', 'Proposers', 'Challengers'.
    @returns {Promise} Resolves into the Ethereum address of the contract
    */
  async getContractAddressOptimist(contractName) {
    const res = await axios.get(`${this.optimistBaseUrl}/contract-address/${contractName}`);
    return res.data.address;
  }

  /**
    Deposits a Layer 1 token into Layer 2, so that it can be transacted
    privately.
    @method
    @async
    @param {number} fee - The amount (Wei) to pay a proposer for the transaction
    @param {string} ercAddress - The address of the ERCx contract from which the token
    is being taken.  Note that the Nightfall_3 State.sol contract must be approved
    by the token's owner to be able to withdraw the token.
    @param {string} tokenType - The type of token to deposit. Possible values are
    'ERC20', 'ERC721', 'ERC1155'.
    @param {number} value - The value of the token, in the case of an ERC20 or ERC1155
    token.  For ERC721 this should be set to zero.
    @param {string} tokenId - The ID of an ERC721 or ERC1155 token.  In the case of
    an 'ERC20' coin, this should be set to '0x00'.
    @param {object} keys - The ZKP private key set.
    @returns {Promise} Resolves into the Ethereum transaction receipt.
    */
  async deposit(ercAddress, tokenType, value, tokenId, fee = this.defaultFee) {
    let txDataToSign;
    try {
      txDataToSign = await approve(
        ercAddress,
        this.ethereumAddress,
        this.shieldContractAddress,
        tokenType,
        value,
        this.web3,
        !!this.ethereumSigningKey,
      );
    } catch (err) {
      throw new Error(err);
    }
    if (txDataToSign) {
      userQueue.push(() => {
        return this.submitTransaction(txDataToSign, ercAddress, 0);
      });
    }
    const res = await axios.post(`${this.clientBaseUrl}/deposit`, {
      ercAddress,
      tokenId,
      tokenType,
      value,
      pkd: this.zkpKeys.pkd,
      nsk: this.zkpKeys.nsk,
      fee,
    });
    return new Promise((resolve, reject) => {
      userQueue.push(async () => {
        try {
          const receipt = await this.submitTransaction(
            res.data.txDataToSign,
            this.shieldContractAddress,
            fee,
          );
          resolve(receipt);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
    Transfers a token within Layer 2.
    @method
    @async
    @param {number} fee - The amount (Wei) to pay a proposer for the transaction
    @param {string} ercAddress - The address of the ERCx contract from which the token
    is being taken.  Note that the Nightfall_3 State.sol contract must be approved
    by the token's owner to be able to withdraw the token.
    @param {string} tokenType - The type of token to deposit. Possible values are
    'ERC20', 'ERC721', 'ERC1155'.
    @param {number} value - The value of the token, in the case of an ERC20 or ERC1155
    token.  For ERC721 this should be set to zero.
    @param {string} tokenId - The ID of an ERC721 or ERC1155 token.  In the case of
    an 'ERC20' coin, this should be set to '0x00'.
    @param {object} keys - The ZKP private key set of the sender.
    @param {string} compressedPkd - The compressed transmission key of the recipient
    @returns {Promise} Resolves into the Ethereum transaction receipt.
    */
  async transfer(
    offchain = false,
    ercAddress,
    tokenType,
    value,
    tokenId,
    compressedPkd,
    fee = this.defaultFee,
  ) {
    const res = await axios.post(`${this.clientBaseUrl}/transfer`, {
      offchain,
      ercAddress,
      tokenId,
      recipientData: {
        values: [value],
        recipientCompressedPkds: [compressedPkd],
      },
      nsk: this.zkpKeys.nsk,
      ask: this.zkpKeys.ask,
      fee,
    });
    if (res.data.error && res.data.error === 'No suitable commitments') {
      throw new Error('No suitable commitments');
    }
    if (!offchain) {
      return new Promise((resolve, reject) => {
        userQueue.push(async () => {
          try {
            const receipt = await this.submitTransaction(
              res.data.txDataToSign,
              this.shieldContractAddress,
              fee,
            );
            resolve(receipt);
          } catch (err) {
            reject(err);
          }
        });
      });
    }
    return res.status;
  }

  /**
    Withdraws a token from Layer 2 back to Layer 1. It can then be withdrawn from
    the Shield contract's account by the owner in Layer 1.
    @method
    @async
    @param {number} fee - The amount (Wei) to pay a proposer for the transaction
    @param {string} ercAddress - The address of the ERCx contract from which the token
    is being taken.  Note that the Nightfall_3 State.sol contract must be approved
    by the token's owner to be able to withdraw the token.
    @param {string} tokenType - The type of token to deposit. Possible values are
    'ERC20', 'ERC721', 'ERC1155'.
    @param {number} value - The value of the token, in the case of an ERC20 or ERC1155
    token.  For ERC721 this should be set to zero.
    @param {string} tokenId - The ID of an ERC721 or ERC1155 token.  In the case of
    an 'ERC20' coin, this should be set to '0x00'.
    @param {object} keys - The ZKP private key set of the sender.
    @param {string} recipientAddress - The Ethereum address to where the withdrawn tokens
    should be deposited.
    @returns {Promise} Resolves into the Ethereum transaction receipt.
    */
  async withdraw(
    offchain = false,
    ercAddress,
    tokenType,
    value,
    tokenId,
    recipientAddress,
    fee = this.defaultFee,
  ) {
    const res = await axios.post(`${this.clientBaseUrl}/withdraw`, {
      offchain,
      ercAddress,
      tokenId,
      tokenType,
      value,
      recipientAddress,
      nsk: this.zkpKeys.nsk,
      ask: this.zkpKeys.ask,
      fee,
    });
    this.latestWithdrawHash = res.data.transaction.transactionHash;
    if (!offchain) {
      return new Promise((resolve, reject) => {
        userQueue.push(async () => {
          try {
            const receipt = await this.submitTransaction(
              res.data.txDataToSign,
              this.shieldContractAddress,
              fee,
            );
            resolve(receipt);
          } catch (err) {
            reject(err);
          }
        });
      });
    }
    return res.status;
  }

  /**
    Enables someone with a valid withdraw transaction in flight to finalise the
    withdrawal of funds to L1 (only relevant for ERC20).
    @method
    @async
    @param {string} withdrawTransactionHash - the hash of the Layer 2 transaction in question
    */
  async finaliseWithdrawal(withdrawTransactionHash) {
    // find the L2 block containing the L2 transaction hash
    const res = await axios.post(`${this.clientBaseUrl}/finalise-withdrawal`, {
      transactionHash: withdrawTransactionHash,
    });
    return new Promise((resolve, reject) => {
      userQueue.push(async () => {
        try {
          const receipt = await this.submitTransaction(
            res.data.txDataToSign,
            this.shieldContractAddress,
            0,
          );
          resolve(receipt);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
    Enables someone with a valid withdraw transaction in flight to request instant
    withdrawal of funds (only relevant for ERC20).
    @method
    @async
    @param {string} withdrawTransactionHash - the hash of the Layer 2 transaction in question
    @param {number} fee - the amount being paid for the instant withdrawal service
    */
  async requestInstantWithdrawal(withdrawTransactionHash, fee) {
    try {
      // set the instant withdrawal fee
      const res = await axios.post(`${this.clientBaseUrl}/set-instant-withdrawal`, {
        transactionHash: withdrawTransactionHash,
      });
      return new Promise((resolve, reject) => {
        userQueue.push(async () => {
          try {
            const receipt = await this.submitTransaction(
              res.data.txDataToSign,
              this.shieldContractAddress,
              fee,
            );
            resolve(receipt);
          } catch (err) {
            reject(err);
          }
        });
      });
    } catch {
      return null;
    }
  }

  /**
    Enables someone to service a request for an instant withdrawal
    @method
    @async
    @param {string} withdrawTransactionHash - the hash of the Layer 2 transaction in question
    */
  async advanceInstantWithdrawal(withdrawTransactionHash) {
    const res = await axios.post(`${this.optimistBaseUrl}/transaction/advanceWithdrawal`, {
      transactionHash: withdrawTransactionHash,
    });
    return new Promise((resolve, reject) => {
      liquidityProviderQueue.push(async () => {
        try {
          const receipt = await this.submitTransaction(
            res.data.txDataToSign,
            this.shieldContractAddress,
            0,
          );
          resolve(receipt);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
    Gets the hash of the last withdraw transaction - sometimes useful for instant transfers
    @method
    @returns {string} - the transactionHash of the last transaction
    */
  getLatestWithdrawHash() {
    return this.latestWithdrawHash;
  }

  /**
    Returns an event emitter that fires each time an InstantWithdrawalRequested
    event is detected on the blockchain
    */
  async getInstantWithdrawalRequestedEmitter() {
    const emitter = new EventEmitter();
    const connection = new ReconnectingWebSocket(this.optimistWsUrl, [], { WebSocket });
    this.websockets.push(connection); // save so we can close it properly later
    connection.onopen = () => {
      // setup a ping every 15s
      this.intervalIDs.push(
        setInterval(() => {
          connection._ws.ping();
          // logger.debug('sent websocket ping');
        }, WEBSOCKET_PING_TIME),
      );
      // and a listener for the pong
      // connection._ws.on('pong', () => logger.debug('websocket received pong'));
      logger.debug('websocket connection opened');
      connection.send('instant');
    };
    connection.onmessage = async message => {
      const msg = JSON.parse(message.data);
      const { type, withdrawTransactionHash, paidBy, amount } = msg;
      if (type === 'instant') {
        emitter.emit('data', withdrawTransactionHash, paidBy, amount);
      }
    };
    return emitter;
  }

  /**
    Provides nightfall-client with a set of viewing keys.  Without these,
    it won't listen for BlockProposed events and so won't update its transaction collection
    with information about which are on-line.
    @method
    @async
    @param {object} keys - Object containing the ZKP key set (this may be generated
    with the makeKeys function).
    */
  async subscribeToIncomingViewingKeys() {
    return axios.post(`${this.clientBaseUrl}/incoming-viewing-key`, {
      ivks: [this.zkpKeys.ivk],
      nsks: [this.zkpKeys.nsk],
    });
  }

  /**
    Closes the Nf3 connection to the blockchain and any open websockets to NF_3
    @method
    */
  close() {
    this.intervalIDs.forEach(intervalID => clearInterval(intervalID));
    this.web3.currentProvider.connection.close();
    this.websockets.forEach(websocket => websocket.close());
  }

  /**
    Registers a new proposer and pays the Bond required to register.
    It will use the address of the Ethereum Signing key that is holds to register
    the proposer.
    @method
    @async
    @param {string} Proposer REST API URL with format https://xxxx.xxx.xx
    @returns {Promise} A promise that resolves to the Ethereum transaction receipt.
    */
  async registerProposer(url) {
    const resUrl = `${this.optimistBaseUrl}/proposer/register`;
    logger.debug(`register proposer ${resUrl}`);

    const res = await axios.post(resUrl, {
      address: this.ethereumAddress,
      url,
    });
    if (res.data.txDataToSign === '') return false; // already registered
    return new Promise((resolve, reject) => {
      proposerQueue.push(async () => {
        try {
          const receipt = await this.submitTransaction(
            res.data.txDataToSign,
            this.proposersContractAddress,
            this.PROPOSER_BOND,
          );
          resolve(receipt);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
    Registers a proposer locally with the Optimist instance only.  This will cause
    Optimist to make blocks when this proposer is current but these will revert if
    the proposer isn't registered on the blockchain too.  This method is useful only
    if the proposer is already registered on the blockchain (has paid their bond) and
    for some reason the Optimist instance does not know about them, e.g. a new instance
    has been created. The method 'registerProposer' will both register the proposer
    with the blockchain and register locally with the optimist instance. So, if
    that method has been used successfully, there is no need to also call this method
    @method
    @async
    @returns {Promise} A promise that resolves to the Ethereum transaction receipt.
    */
  async registerProposerLocally() {
    return axios.post(`${this.optimistBaseUrl}/proposer/registerlocally`, {
      address: this.ethereumAddress,
    });
  }

  /**
    De-registers an existing proposer.
    It will use the address of the Ethereum Signing key that is holds to de-register
    the proposer.
    @method
    @async
    @returns {Promise} A promise that resolves to the Ethereum transaction receipt.
    */
  async deregisterProposer() {
    const res = await axios.post(`${this.optimistBaseUrl}/proposer/de-register`, {
      address: this.ethereumAddress,
    });
    return new Promise((resolve, reject) => {
      proposerQueue.push(async () => {
        try {
          const receipt = await this.submitTransaction(
            res.data.txDataToSign,
            this.proposersContractAddress,
            0,
          );
          resolve(receipt);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
    Change current proposer.
    It will use the address of the Ethereum Signing key that is holds to change the current
    proposer.
    @method
    @async
    @returns {Promise} A promise that resolves to the Ethereum transaction receipt.
    */
  async changeCurrentProposer() {
    const res = await axios.get(`${this.optimistBaseUrl}/proposer/change`, {
      address: this.ethereumAddress,
    });
    return new Promise((resolve, reject) => {
      proposerQueue.push(async () => {
        try {
          const receipt = await this.submitTransaction(
            res.data.txDataToSign,
            this.proposersContractAddress,
            0,
          );
          resolve(receipt);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
    Withdraw the bond left by the proposer.
    It will use the address of the Ethereum Signing key that is holds to withdraw the bond.
    @method
    @async
    @returns {Promise} A promise that resolves to the Ethereum transaction receipt.
    */
  async withdrawBond() {
    const res = await axios.post(`${this.optimistBaseUrl}/proposer/withdrawBond`, {
      address: this.ethereumAddress,
    });
    return new Promise((resolve, reject) => {
      proposerQueue.push(async () => {
        try {
          const receipt = await this.submitTransaction(
            res.data.txDataToSign,
            this.proposersContractAddress,
            0,
          );
          resolve(receipt);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
    Get current proposer
    @method
    @async
    @returns {array} A promise that resolves to the Ethereum transaction receipt.
    */
  async getCurrentProposer() {
    const res = await axios.get(`${this.optimistBaseUrl}/proposer/current-proposer`);
    return res.data.currentProposer;
  }

  /**
    Get all the list of existing proposers.
    @method
    @async
    @returns {array} A promise that resolves to the Ethereum transaction receipt.
    */
  async getProposers() {
    const res = await axios.get(`${this.optimistBaseUrl}/proposer/proposers`);
    return res.data;
  }

  /**
    Update Proposers URL
    @method
    @async
    @param {string} Proposer REST API URL with format https://xxxx.xxx.xx
    @returns {array} A promise that resolves to the Ethereum transaction receipt.
    */
  async updateProposer(url) {
    const res = await axios.post(`${this.optimistBaseUrl}/proposer/update`, {
      address: this.ethereumAddress,
      url,
    });
    logger.debug(`Proposer with address ${this.ethereumAddress} updated to URL ${url}`);
    return new Promise((resolve, reject) => {
      proposerQueue.push(async () => {
        try {
          const receipt = await this.submitTransaction(
            res.data.txDataToSign,
            this.proposersContractAddress,
            0,
          );
          resolve(receipt);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
    Starts a Proposer that listens for blocks and submits block proposal
    transactions to the blockchain.
    @method
    @async
    */
  async startProposer() {
    console.log(`Starting Proposer with address ${this.optimistWsUrl}`);
    const blockProposeEmitter = new EventEmitter();
    const connection = new ReconnectingWebSocket(this.optimistWsUrl, [], { WebSocket });
    this.websockets.push(connection); // save so we can close it properly later
    // we can't setup up a ping until the connection is made because the ping function
    // only exists in the underlying 'ws' object (_ws) and that is undefined until the
    // websocket is opened, it seems. Hence, we put all this code inside the onopen.
    connection.onopen = () => {
      // setup a ping every 15s
      this.intervalIDs.push(
        setInterval(() => {
          connection._ws.ping();
          // logger.debug('sent websocket ping');
        }, WEBSOCKET_PING_TIME),
      );
      // and a listener for the pong
      // connection._ws.on('pong', () => logger.debug('websocket received pong'));
      logger.debug('websocket connection opened');
      connection.send('blocks');
    };
    connection.onmessage = async message => {
      const msg = JSON.parse(message.data);
      const { type, txDataToSign, block, transactions } = msg;
      logger.debug(`Proposer received websocket message of type ${type}`);
      if (type === 'block') {
        proposerQueue.push(async () => {
          try {
            const receipt = await this.submitTransaction(
              txDataToSign,
              this.stateContractAddress,
              this.BLOCK_STAKE,
            );
            blockProposeEmitter.emit('receipt', receipt, block, transactions);
          } catch (err) {
            blockProposeEmitter.emit('error', err, block, transactions);
          }
        });
      }
      return null;
    };
    connection.onerror = () => logger.error(`websocket connection error ${this.optimistWsUrl}`);
    connection.onclosed = () => logger.warn('websocket connection closed');
    // add this proposer to the list of peers that can accept direct transfers and withdraws
    return blockProposeEmitter;
  }

  /**
    Send offchain transaction to Optimist
    @method
    @async
    @param {string} transaction
    @returns {array} A promise that resolves to the API call status
    */
  async sendOffchainTransaction(transaction) {
    const res = axios.post(
      `${this.optimistBaseUrl}/proposer/offchain-transaction`,
      { transaction },
      { timeout: 3600000 },
    );
    return res.status;
  }

  /**
    Returns an emitter, whose 'data' event fires whenever a block is
    detected, passing out the transaction needed to propose the block. This
    is a lower level method than `Nf3.startProposer` because it does not sign and
    send the transaction to the blockchain. If required, `Nf3.submitTransaction`
    can be used to do that.
    @method
    @async
    @returns {Promise} A Promise that resolves into an event emitter.
    */
  async getNewBlockEmitter() {
    const newBlockEmitter = new EventEmitter();
    const connection = new ReconnectingWebSocket(this.optimistWsUrl, [], { WebSocket });
    this.websockets.push(connection); // save so we can close it properly later
    connection.onopen = () => {
      // setup a ping every 15s
      this.intervalIDs.push(
        setInterval(() => {
          connection._ws.ping();
          // logger.debug('sent websocket ping');
        }, WEBSOCKET_PING_TIME),
      );
      // and a listener for the pong
      // connection._ws.on('pong', () => logger.debug('websocket received pong'));
      logger.debug('websocket connection opened');
      connection.send('blocks');
    };
    connection.onmessage = async message => {
      const msg = JSON.parse(message.data);
      const { type, txDataToSign } = msg;
      if (type === 'block') {
        newBlockEmitter.emit('data', txDataToSign);
      }
    };
    return newBlockEmitter;
  }

  /**
    Registers our address as a challenger address with the optimist container.
    This is so that the optimist container can tell when a challenge that we have
    committed to has appeared on chain.
    @method
    @async
    @return {Promise} A promise that resolves to an axios response.
    */
  async registerChallenger() {
    console.log(
      `Registering challenger ${this.optimistBaseUrl}/challenger/add address ${this.ethereumAddress}`,
    );
    return axios.post(`${this.optimistBaseUrl}/challenger/add`, { address: this.ethereumAddress });
  }

  /**
    De-registers our address as a challenger address with the optimist container.
    @method
    @async
    @return {Promise} A promise that resolves to an axios response.
    */
  async deregisterChallenger() {
    return axios.post(`${this.optimistBaseUrl}/challenger/remove`, {
      address: this.ethereumAddress,
    });
  }

  /**
    Starts a Challenger that listens for challengable blocks and submits challenge
    transactions to the blockchain to challenge the block.
    @method
    @async
    */
  async startChallenger() {
    const connection = new ReconnectingWebSocket(this.optimistWsUrl, [], { WebSocket });
    this.websockets.push(connection); // save so we can close it properly later
    connection.onopen = () => {
      // setup a ping every 15s
      this.intervalIDs.push(
        setInterval(() => {
          connection._ws.ping();
          // logger.debug('sent websocket ping');
        }, WEBSOCKET_PING_TIME),
      );
      // and a listener for the pong
      // connection._ws.on('pong', () => logger.debug('websocket received pong'));
      logger.debug('websocket connection opened');
      connection.send('challenge');
    };
    connection.onmessage = async message => {
      const msg = JSON.parse(message.data);
      const { type, txDataToSign } = msg;
      if (type === 'commit' || type === 'challenge') {
        return new Promise((resolve, reject) => {
          challengerQueue.push(async () => {
            try {
              const receipt = await this.submitTransaction(
                txDataToSign,
                this.challengesContractAddress,
                0,
              );
              resolve(receipt);
            } catch (err) {
              reject(err);
            }
          });
        });
      }
      return null;
    };
  }

  /**
    Returns an emitter, whose 'data' event fires whenever a challengeable block is
    detected, passing out the transaction needed to raise the challenge. This
    is a lower level method than `Nf3.startChallenger` because it does not sign and
    send the transaction to the blockchain. If required, `Nf3.submitTransaction`
    can be used to do that.
    @method
    @async
    @returns {Promise} A Promise that resolves into an event emitter.
    */
  async getChallengeEmitter() {
    const newChallengeEmitter = new EventEmitter();
    const connection = new ReconnectingWebSocket(this.optimistWsUrl, [], { WebSocket });
    this.websockets.push(connection); // save so we can close it properly later
    connection.onopen = () => {
      // setup a ping every 15s
      this.intervalIDs.push(
        setInterval(() => {
          connection._ws.ping();
          // logger.debug('sent websocket ping');
        }, WEBSOCKET_PING_TIME),
      );
      // and a listener for the pong
      // connection._ws.on('pong', () => logger.debug('websocket received pong'));
      logger.debug('websocket connection opened');
      connection.send('challenge');
    };
    connection.onmessage = async message => {
      const msg = JSON.parse(message.data);
      const { type, txDataToSign } = msg;
      if (type === 'challenge') {
        newChallengeEmitter.emit('data', txDataToSign);
      }
    };
    return newChallengeEmitter;
  }

  /**
    Returns the balance of tokens held in layer 2
    @method
    @async
    @param {Array} ercList - list of erc contract addresses to filter.
    @returns {Promise} This promise resolves into an object whose properties are the
    addresses of the ERC contracts of the tokens held by this account in Layer 2. The
    value of each propery is the number of tokens originating from that contract.
    */
  async getLayer2Balances({ ercList } = {}) {
    const res = await axios.get(`${this.clientBaseUrl}/commitment/balance`, {
      params: {
        compressedPkd: this.zkpKeys.compressedPkd,
        ercList,
      },
    });
    return res.data.balance;
  }

  async getLayer2BalancesUnfiltered({ ercList } = {}) {
    const res = await axios.get(`${this.clientBaseUrl}/commitment/balance`, {
      params: {
        compressedPkd: ercList,
      },
    });
    return res.data.balance;
  }

  /**
    Returns the balance of tokens held in layer 2
    @method
    @async
    @param {Array} ercList - list of erc contract addresses to filter.
    @param {Boolean} filterByCompressedPkd - flag to indicate if request is filtered
    ones compressed pkd
    @returns {Promise} This promise resolves into an object whose properties are the
    addresses of the ERC contracts of the tokens held by this account in Layer 2. The
    value of each propery is the number of tokens pending deposit from that contract.
    */
  async getLayer2PendingDepositBalances(ercList, filterByCompressedPkd) {
    const res = await axios.get(`${this.clientBaseUrl}/commitment/pending-deposit`, {
      params: {
        compressedPkd: filterByCompressedPkd === true ? this.zkpKeys.compressedPkd : null,
        ercList,
      },
    });
    return res.data.balance;
  }

  /**
    Returns the balance of tokens held in layer 2
    @method
    @async
    @param {Array} ercList - list of erc contract addresses to filter.
    @param {Boolean} filterByCompressedPkd - flag to indicate if request is filtered
    ones compressed pkd
    @returns {Promise} This promise resolves into an object whose properties are the
    addresses of the ERC contracts of the tokens held by this account in Layer 2. The
    value of each propery is the number of tokens pending spent (transfer & withdraw)
    from that contract.
    */
  async getLayer2PendingSpentBalances(ercList, filterByCompressedPkd) {
    const res = await axios.get(`${this.clientBaseUrl}/commitment/pending-spent`, {
      params: {
        compressedPkd: filterByCompressedPkd === true ? this.zkpKeys.compressedPkd : null,
        ercList,
      },
    });
    return res.data.balance;
  }

  /**
    Returns the commitments of tokens held in layer 2
    @method
    @async
    @returns {Promise} This promise resolves into an object whose properties are the
    addresses of the ERC contracts of the tokens held by this account in Layer 2. The
    value of each propery is an array of commitments originating from that contract.
    */
  async getLayer2Commitments() {
    const res = await axios.get(`${this.clientBaseUrl}/commitment/commitments`);
    return res.data.commitments;
  }

  /**
    Returns the pending withdraws commitments
    @method
    @async
    @returns {Promise} This promise resolves into an object whose properties are the
    addresses of the ERC contracts of the tokens held by this account in Layer 2. The
    value of each propery is an array of withdraw commitments originating from that contract.
    */
  async getPendingWithdraws() {
    const res = await axios.get(`${this.clientBaseUrl}/commitment/withdraws`);
    return res.data.commitments;
  }

  // /**
  //   Set a Web3 Provider URL
  //   */
  // async setWeb3Provider() {
  //   this.web3 = new Web3(this.web3WsUrl);
  //   this.web3.eth.transactionBlockTimeout = 200;
  //   this.web3.eth.transactionConfirmationBlocks = 12;
  //   if (typeof window !== 'undefined') {
  //     if (window.ethereum && this.ethereumSigningKey === '') {
  //       this.web3 = new Web3(window.ethereum);
  //       await window.ethereum.request({ method: 'eth_requestAccounts' });
  //     } else {
  //       // Metamask not available
  //       throw new Error('No Web3 provider found');
  //     }
  //   }
  // }

  /**
Set a Web3 Provider URL
*/
  async setWeb3Provider() {
    // initialization of web3 provider has been taken from common-files/utils/web3.mjs
    //  Target is to mainain web3 socker alive
    const WEB3_PROVIDER_OPTIONS = {
      clientConfig: {
        // Useful to keep a connection alive
        keepalive: true,
        keepaliveInterval: 10,
      },
      timeout: 3600000,
      reconnect: {
        auto: true,
        delay: 5000, // ms
        maxAttempts: 120,
        onTimeout: false,
      },
    };
    const provider = new Web3.providers.WebsocketProvider(this.web3WsUrl, WEB3_PROVIDER_OPTIONS);

    this.web3 = new Web3(provider);
    this.web3.eth.transactionBlockTimeout = 2000;
    this.web3.eth.transactionConfirmationBlocks = 12;
    if (typeof window !== 'undefined') {
      if (window.ethereum && this.ethereumSigningKey === '') {
        this.web3 = new Web3(window.ethereum);
        await window.ethereum.request({ method: 'eth_requestAccounts' });
      } else {
        // Metamask not available
        throw new Error('No Web3 provider found');
      }
    }

    provider.on('error', err => logger.error(`web3 error: ${err}`));
    provider.on('connect', () => logger.info('Blockchain Connected ...'));
    provider.on('end', () => logger.info('Blockchain disconnected'));

    // attempt a reconnect if the socket is down
    this.intervalIDs.push(() => {
      setInterval(() => {
        if (!this.web3.currentProvider.connected) this.web3.setProvider(provider);
      }, 2000);
    });
    // set up a pinger to ping the web3 provider. This will help to further ensure
    // that the websocket doesn't timeout. We don't use the blockNumber but we save it
    // anyway. Someone may find a use for it.
    this.intervalIDs.push(() => {
      setInterval(() => {
        this.blockNumber = this.web3.eth.getBlockNumber();
      }, WEBSOCKET_PING_TIME);
    });
  }

  /**
    Web3 provider getter
    @returns {Object} provider
    */
  getWeb3Provider() {
    return this.web3;
  }

  /**
    Get Ethereum Balance
    @param {String} address - Ethereum address of account
    @returns {String} - Ether balance in account
    */
  getL1Balance(address) {
    return this.web3.eth.getBalance(address).then(function (balanceWei) {
      return Web3.utils.fromWei(balanceWei);
    });
  }

  /**
    Get EthereumAddress available.
    @param {String} privateKey - Private Key - optional
    @returns {String} - Ether balance in account
    */
  getAccounts() {
    const account =
      this.ethereumSigningKey.length === 0
        ? this.web3.eth.getAccounts().then(address => address[0])
        : this.web3.eth.accounts.privateKeyToAccount(this.ethereumSigningKey).address;
    return account;
  }

  /**
    Signs a message with a given authenticated account
    @param {String} msg  - Message to sign
    @param {String } account - Ethereum address of account
    @returns {Promise} - string with the signature
    */
  signMessage(msg, account) {
    if (this.ethereumSigningKey) {
      return this.web3.eth.accounts.sign(msg, this.ethereumSigningKey).signature;
    }
    return this.web3.eth.personal.sign(msg, account);
  }

  /**
  Returns current network ID
  @returns {Promise} - Network Id number
  */
  getNetworkId() {
    return this.web3.eth.net.getId();
  }
}

export default Nf3;
