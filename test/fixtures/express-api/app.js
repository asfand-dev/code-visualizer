const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('node:crypto');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use((req, res, next) => {
  req.id = randomUUID();
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api', require('./routes'));

app.use(errorHandler);

module.exports = app;
