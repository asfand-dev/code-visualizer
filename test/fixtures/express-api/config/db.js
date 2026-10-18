const mongoose = require('mongoose');

async function connectDb(uri = process.env.MONGO_URL) {
  mongoose.set('strictQuery', true);
  // FIXME: add retry with backoff for flaky container start-up
  await mongoose.connect(uri);
  return mongoose.connection;
}

module.exports = { connectDb };
