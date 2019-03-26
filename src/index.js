const delay = require('delay')
const Web3 = require('web3')
const ZeroClientProvider = require('web3-provider-engine/zero')

const bots = [require('./bots/t2cr')]
const twitterClient = require('./twitter-client')
const _mongoClient = require('./mongo-client')

// Run bots and restart them on failures.
const run = async bot => {
  // Create an instance of `web3` and `batched-send` for each bot.
  const web3 = new Web3(process.env.WEB3_PROVIDER_URL)
  const mongoClient = await _mongoClient()

  while (true) {
    try {
      await bot(web3, twitterClient, mongoClient)
    } catch (err) {
      console.error('Bot error: ', err)
    }
    await delay(10000) // Wait 10 seconds before restarting failed bot.
  }
}
bots.forEach(run)
