// connection.js
const { MongoClient } = require("mongodb");

let client;
let db;

async function connect() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI environment variable not set!");
  }

  try {
    client = await MongoClient.connect(process.env.MONGO_URI);

    db = client.db("readora"); // your database name
    console.log("Connected to database successfully");
    return db;
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1); // stop the server if DB fails
  }
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