const delay = require('delay')
const Web3 = require('web3')
const ZeroClientProvider = require('web3-provider-engine/zero')

const _mongoClient = require('./mongo-client')
const bots = [require('./bots/realitio_v2.0'), require('./bots/realitio_v2.1')]

// Run bots and restart them on failures.
const run = async bot => {
  // Create an instance of `web3` for each bot.
  const web3 = new Web3(process.env.WEB3_PROVIDER_URL)
  const privateKey = process.env.PRIVATE_KEY
  const account = web3.eth.accounts.privateKeyToAccount(privateKey)
  web3.eth.accounts.wallet.add(account)
  console.log(web3.eth.accounts.wallet[0].address)

  const mongoClient = await _mongoClient()
  const realitioAddresses = [
    process.env.REALITIO_CONTRACT_ADDRESS,
    process.env.REALITIO_V2_1,
  ]
  const proxyAddresses = [
    process.env.PROXY_CONTRACT_ADDRESS,
    process.env.PROXY_V2_1,
  ]

  let bots = []
  while (true) {
    try {
      for (let i=0; i<realitioAddresses.length; i++) {
        bots.push(bot(web3, mongoClient, realitioAddresses[i], proxyAddresses[i]))
      }
      await Promise.all(bots)
    } catch (err) {
      console.error('Bot error: ', err)
    }
    await delay(10000) // Wait 10 seconds before restarting failed bot.
  }
}
bots.forEach(run)
