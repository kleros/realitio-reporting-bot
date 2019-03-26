const MongoClient = require('mongodb')

module.exports = async () => {
  const mongoClient = await MongoClient.connect(process.env.MONGO_URI)
  return mongoClient.db(process.env.MONGO_DB_NAME)
}
