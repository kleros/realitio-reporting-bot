const delay = require('delay')
const Web3 = require('web3')
const ZeroClientProvider = require('web3-provider-engine/zero')

const _mongoClient = require('./mongo-client')
const bots = [require('./bots/realitio')]

// Run bots and restart them on failures.
const run = async bot => {
  // Create an instance of `web3` for each bot.
  const web3 = new Web3(process.env.WEB3_PROVIDER_URL)
  const privateKey = process.env.PRIVATE_KEY
  const account = web3.eth.accounts.privateKeyToAccount(privateKey)
  web3.eth.accounts.wallet.add(account)
  console.log(web3.eth.accounts.wallet[0].address)

  const mongoClient = await _mongoClient()

  while (true) {
    try {
      await bot(web3, mongoClient)
    } catch (err) {
      console.error('Bot error: ', err)
    }
    await delay(10000) // Wait 10 seconds before restarting failed bot.
  }
}
bots.forEach(run)
