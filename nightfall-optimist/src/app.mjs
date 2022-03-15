import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import fileUpload from 'express-fileupload';
import {
  proposer,
  block,
  challenger,
  transaction,
  getContractAddress,
  getCircuitsFromAWS, // router will only have single get api, hence name prefixed with 'get'
} from './routes/index.mjs';

const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.urlencoded({ limit: '2mb', extended: true }));
app.use(
  fileUpload({
    createParentPath: true,
  }),
);

app.get('/healthcheck', (req, res) => res.sendStatus(200));
app.use('/proposer', proposer);
app.use('/block', block);
app.use('/challenger', challenger);
app.use('/transaction', transaction);
app.use('/contract-address', getContractAddress);
app.use('/browser-circuit', getCircuitsFromAWS);

export default app;
