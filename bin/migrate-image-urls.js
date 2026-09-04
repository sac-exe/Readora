require("dotenv").config();

const { MongoClient } = require("mongodb");

const OLD_PREFIX = "../public/images/";
const NEW_PREFIX = "/images/";

async function migrate(collection, field) {
  const result = await collection.updateMany(
    { [field]: { $regex: "^\\.\\./public/images/" } },
    [
      {
        $set: {
          [field]: {
            $replaceOne: { input: `$${field}`, find: OLD_PREFIX, replacement: NEW_PREFIX }
          }
        }
      }
    ]
  );
  return result.modifiedCount;
}

async function main() {
  const client = await MongoClient.connect(process.env.MONGO_URI);
  try {
    const database = client.db("readora");
    const [userProfiles, staffProfiles, novelCovers] = await Promise.all([
      migrate(database.collection("user"), "profileImage"),
      migrate(database.collection("staff"), "profileImage"),
      migrate(database.collection("novels"), "imageUrl")
    ]);
    console.log(`Updated ${userProfiles} user profiles, ${staffProfiles} staff profiles, and ${novelCovers} novel covers.`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("Image URL migration failed:", error.message);
  process.exitCode = 1;
});
