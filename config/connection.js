// connection.js
const { MongoClient } = require("mongodb");

let client;
let db;

async function connect() {
  client = await MongoClient.connect(process.env.MONGO_URI);
  db = client.db("readora");
  console.log("Connected to database successfully");
  return db;
}

function get() {
  if (!db) throw new Error("Database not connected!");
  return db;
}

function getClient() {
  if (!client) throw new Error("Database client not connected!");
  return client;
}

module.exports = { connect, get, getClient };
