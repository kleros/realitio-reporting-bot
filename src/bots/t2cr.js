const fs = require('fs')
const axios = require('axios')
const { BitlyClient } = require('bitly')
const delay = require('delay')

const _t2cr = require('../contracts/t2cr.json')
const _address = require('../contracts/address.json')
const _athena = require('../contracts/athena.json')

const T2CR_MONGO_COLLECTION = 'tokens'
const IPFS_URL = 'https://ipfs.kleros.io'

module.exports = async (web3, twitterClient, mongoClient) => {
  // Instantiate the contracts.
  const t2crInstance = new web3.eth.Contract(
    _t2cr.abi,
    process.env.T2CR_CONTRACT_ADDRESS
  )
  const badgeInstance = new web3.eth.Contract(
    _address.abi,
    process.env.BADGE_CONTRACT_ADDRESS
  )
  const athenaInstance = new web3.eth.Contract(
    _athena.abi,
    process.env.ARBITRATOR_CONTRACT_ADDRESS
  )

  const prettyWeiToEth = (weiAmount) => {
    const ethString = web3.utils.fromWei(weiAmount)
    // only show up to 4 decimal places worth
    const splitAmounts = ethString.split('.')
    return splitAmounts[0] + '.' + (splitAmounts[1] ? splitAmounts[1].substr(0,2) : '')
  }

  // connect to the right collection
  await mongoClient.createCollection(T2CR_MONGO_COLLECTION)
  const db = mongoClient.collection(T2CR_MONGO_COLLECTION)

  // get our starting point
  let lastBlock
  const appState = await db.findOne({'tokenID': '0x0'})
  if (appState) {
    lastBlock = appState.lastBlock
  }
  else {
    // if starting from scratch we can go from current block. No need to tweet history
    lastBlock = await web3.eth.getBlockNumber()
    await db.insertOne({'tokenID': '0x0', 'lastBlock': lastBlock})
  }

  // bitly link shortening
  const bitly = new BitlyClient(process.env.BITLY_TOKEN, {})
  while (true) {
    await delay(process.env.DELAY_AMOUNT)
    currentBlock = await web3.eth.getBlockNumber()
    t2ctEvents = await t2crInstance.getPastEvents('allEvents', {
      fromBlock: lastBlock,
      toBlock: currentBlock
    })
    badgeEvents = await badgeInstance.getPastEvents('allEvents', {
      fromBlock: lastBlock,
      toBlock: currentBlock
    })
    athenaEvents = await athenaInstance.getPastEvents('AppealPossible', {
      fromBlock: lastBlock,
      toBlock: currentBlock
    })

    // Token Events
    for (const eventLog of t2ctEvents) {
      let tweet
      let in_reply_to_status_id
      let tokenID
      let tweetID

      try {
        if (eventLog.event === 'TokenStatusChange') {
          // get base deposits
          const extraData = await t2crInstance.methods.arbitratorExtraData().call()
          const arbitrationCost = await athenaInstance.methods.arbitrationCost(extraData).call()
          const divisor = await t2crInstance.methods.MULTIPLIER_DIVISOR().call()
          const sharedStakeMultiplier = await t2crInstance.methods.sharedStakeMultiplier().call()
          const challengerBaseDeposit = await t2crInstance.methods.challengerBaseDeposit().call()
          const requesterBaseDeposit = await t2crInstance.methods.requesterBaseDeposit().call()
          const sharedDepositBase = web3.utils.toBN(arbitrationCost).mul(web3.utils.toBN(sharedStakeMultiplier)).div(web3.utils.toBN(divisor))
          const challengerWinnableDeposit = sharedDepositBase.add(web3.utils.toBN(challengerBaseDeposit))
          const requesterWinnableDeposit = sharedDepositBase.add(web3.utils.toBN(requesterBaseDeposit))

          tokenID = eventLog.returnValues._tokenID
          const token = await t2crInstance.methods.tokens(tokenID).call()

          const shortenedLink = await bitly.shorten(`https://tokens.kleros.io/token/${tokenID}`)
          // look up to see if this token_id already has a thread
          const tokenThread = await db.findOne({tokenID})
        if (tokenThread)
          in_reply_to_status_id = await tokenThread.lastTweetID
          if (eventLog.returnValues._status === "0") {
            const tokenInfo = await t2crInstance.methods.getTokenInfo(tokenID).call()
            tweet = await twitterClient.post('statuses/update', {
              status: `${token.name} $${token.ticker} has been ${Number(tokenInfo.numberOfRequests) > 1 ? 'removed' : 'rejected'} from the list. ${
                eventLog.returnValues._disputed ?
                `The challenger has won the deposit of ${prettyWeiToEth(requesterWinnableDeposit)} ETH`
                : ''
              }`,
              in_reply_to_status_id,
              auto_populate_reply_metadata: true
            })
            tweetID = tweet.data.id_str
          }
          else if (eventLog.returnValues._status == "1") {
            tweet = await twitterClient.post('statuses/update', {
              status: `${token.name} $${token.ticker} has been accepted into the list. ${
                eventLog.returnValues._disputed ?
                `The submitter has taken the challengers deposit of ${prettyWeiToEth(challengerWinnableDeposit)} ETH`
                : ''
              }`,
              in_reply_to_status_id,
              auto_populate_reply_metadata: true
            })
            tweetID = tweet.data.id_str
          }
          else {
            if (eventLog.returnValues._disputed && !eventLog.returnValues._appealed) {
              tweet = await twitterClient.post('statuses/update', {
                status: `Token Challenged! ${token.name} $${token.ticker} is headed to court ${shortenedLink.url}`,
                in_reply_to_status_id,
                auto_populate_reply_metadata: true
              })
              tweetID = tweet.data.id_str
            }
            else if (eventLog.returnValues._disputed && eventLog.returnValues._appealed) {
              tweet = await twitterClient.post('statuses/update', {
                status: `The ruling on ${token.name} $${token.ticker} has been appealed ${shortenedLink.url}`,
                in_reply_to_status_id,
                auto_populate_reply_metadata: true
              })
              tweetID = tweet.data.id_str
            }
            else {
              if (eventLog.returnValues._status === "2") {
                // have to hack it to get the file in the right type. RIP
                const image = await axios.get(
                  (token.symbolMultihash[0] === '/' ? `${IPFS_URL}` : `${process.env.FILE_BASE_URL}/`)
                  + token.symbolMultihash,
                  {responseType: 'arraybuffer'}
                )
                filePath = `./tmp/test.${image.headers['content-type'].split('/')[1]}`
                // fileBuffer = new Buffer(image.data, 'binary')
                fs.writeFileSync(filePath, image.data)
                const file = fs.readFileSync(filePath, { encoding: 'base64' })
                const media = await twitterClient.post('media/upload', {
                  media_data: file
                })
                fs.unlinkSync(filePath)

                const shortenedTokenLink = await bitly.shorten(`https://etherscan.io/token/${token.addr}`)

                tweet = await twitterClient.post('statuses/update', {
                  status: `${token.name} $${token.ticker} has requested to be added to the list. Verify that the token listing is correct. If you challenge and win you will take the deposit of ${prettyWeiToEth(requesterWinnableDeposit)} ETH
                  \nToken Address: ${shortenedTokenLink.url}
                  \nSee the listing here: ${shortenedLink.url}`,
                  in_reply_to_status_id,
                  auto_populate_reply_metadata: true,
                  media_ids: [media.data.media_id_string]
                })
                tweetID = tweet.data.id_str
              }
              else {
                tweet = await twitterClient.post('statuses/update', {
                  status: `Someone requested to remove ${token.name} $${token.ticker} from the list with a deposit of ${prettyWeiToEth(requesterWinnableDeposit)} ETH. If you challenge the removal and win you will take the deposit
                  \nSee the listing here: ${shortenedLink.url}`,
                  in_reply_to_status_id,
                  auto_populate_reply_metadata: true
                })
                tweetID = tweet.data.id_str
              }
            }
          }
        }
        else if (eventLog.event === 'Evidence') {
          const tx = await web3.eth.getTransaction(eventLog.transactionHash)
          tokenID = '0x' + tx.input.substr(10,64)
          const token = await t2crInstance.methods.tokens(tokenID).call()

          const tokenThread = await db.findOne({tokenID})
          if (tokenThread)
            in_reply_to_status_id = await tokenThread.lastTweetID

          const evidenceURI = eventLog.returnValues._evidence[0] === '/' ? `${IPFS_URL}${eventLog.returnValues._evidence}` : eventLog.returnValues._evidence
          const evidence = await axios.get(evidenceURI)
          const evidenceJSON = evidence.data

          let shortenedLink

          if (evidenceJSON.fileURI) {
            const linkURI = evidenceJSON.fileURI[0] === "/" ? `${IPFS_URL}${evidenceJSON.fileURI}` : evidenceJSON.fileURI
            shortenedLink = await bitly.shorten(linkURI)
          }
          const evidenceTitle = evidenceJSON.title || evidenceJSON.name || ''
          evidenceJSON.name = evidenceTitle
          const evidenceDescription = evidenceJSON.description || ''

          if (evidenceTitle.length + evidenceDescription.length > 130) {
            if (evidenceTitle.length > 20) evidenceJSON.name = evidenceTitle.substr(0,17) + '...'
            if (evidenceDescription.length > 110) evidenceJSON.description = evidenceDescription.substr(0,107) + '...'
          }

          const shortenedTokenLink = await bitly.shorten(`https://tokens.kleros.io/token/${tokenID}`)

          tweet = await twitterClient.post('statuses/update', {
            status: `New Evidence for ${token.name}: ${evidenceJSON.name || ''}
            ${evidenceJSON.description ? `\n${evidenceJSON.description}`: ''}
            \n${shortenedLink ? `\nLink: ${shortenedLink.url}` : ''}
            \n\nSee Full Evidence: ${shortenedTokenLink.url}`,
            in_reply_to_status_id,
            auto_populate_reply_metadata: true,
          })
          tweetID = tweet.data.id_str
        }
      } catch (err) {
        // duplicate tweet. just move on
        console.error(err)
        continue
      }

      // update thread id
      if (tweetID)
        await db.findOneAndUpdate({tokenID}, {$set: {lastTweetID: tweetID}}, { upsert: true })
    }

    // BADGES
    for (const eventLog of badgeEvents) {
      let tweet
      let in_reply_to_status_id
      let tokenID
      let tweetID

      try {
        if (eventLog.event === 'AddressStatusChange') {
          // get base deposits
          const extraData = await badgeInstance.methods.arbitratorExtraData().call()
          const arbitrationCost = await athenaInstance.methods.arbitrationCost(extraData).call()
          const divisor = await badgeInstance.methods.MULTIPLIER_DIVISOR().call()
          const sharedStakeMultiplier = await badgeInstance.methods.sharedStakeMultiplier().call()
          const challengerBaseDeposit = await badgeInstance.methods.challengerBaseDeposit().call()
          const requesterBaseDeposit = await badgeInstance.methods.requesterBaseDeposit().call()
          const sharedDepositBase = web3.utils.toBN(arbitrationCost).mul(web3.utils.toBN(sharedStakeMultiplier)).div(web3.utils.toBN(divisor))
          const challengerWinnableDeposit = sharedDepositBase.add(web3.utils.toBN(challengerBaseDeposit))
          const requesterWinnableDeposit = sharedDepositBase.add(web3.utils.toBN(requesterBaseDeposit))
          address = eventLog.returnValues._address

          const tokenQuery = await t2crInstance.methods.queryTokens('0x0000000000000000000000000000000000000000000000000000000000000000', 1, [false,true,false,false,false,false,false,false], true, address).call()
          tokenID = tokenQuery.values[0]
          const token = await t2crInstance.methods.tokens(tokenID).call()

          const shortenedLink = await bitly.shorten(`https://tokens.kleros.io/badge/${process.env.ETHFINEX_BADGE_ID}/${address}`)
          // look up to see if this token_id already has a thread
          const tokenThread = await db.findOne({tokenID})
          if (tokenThread)
            in_reply_to_status_id = await tokenThread.lastTweetID
          if (eventLog.returnValues._status === "0") {
            tweet = await twitterClient.post('statuses/update', {
              status: `${token.name} has been denied the Ethfinex Compliant Badge. ${
                eventLog.returnValues._disputed ?
                `The challenger has won the deposit of ${prettyWeiToEth(requesterWinnableDeposit)} ETH`
                : ''
              }`,
              in_reply_to_status_id,
              auto_populate_reply_metadata: true
            })
            tweetID = tweet.data.id_str
          }
          else if (eventLog.returnValues._status == "1") {
            if (in_reply_to_status_id) {
              tweet = await twitterClient.post('statuses/update', {
                status: `${token.name} has been awarded the Ethfinex Compliant Badge. ${
                  eventLog.returnValues._disputed ?
                  `The submitter has taken the challengers deposit of ${prettyWeiToEth(challengerWinnableDeposit)} ETH`
                  : ''
                }`,
                in_reply_to_status_id,
                auto_populate_reply_metadata: true
              })
            }
            tweetID = tweet.data.id_str
          }
          else {
            if (eventLog.returnValues._disputed && !eventLog.returnValues._appealed) {
              tweet = await twitterClient.post('statuses/update', {
                status: `Ethfinex Compliant Badge Challenged! ${token.name} is headed to court`,
                in_reply_to_status_id,
                auto_populate_reply_metadata: true
              })
              tweetID = tweet.data.id_str
            }
            else if (eventLog.returnValues._disputed && eventLog.returnValues._appealed) {
              tweet = await twitterClient.post('statuses/update', {
                status: `The ruling on the Ethfinex Compliant Badge for ${token.name} has been appealed.`,
                in_reply_to_status_id,
                auto_populate_reply_metadata: true
              })
              tweetID = tweet.data.id_str
            }
            else {
              if (eventLog.returnValues._status === "2") {

                const file = fs.readFileSync('./assets/ethfinex.jpg', { encoding: 'base64' })
                const media = await twitterClient.post('media/upload', {
                  media_data: file
                })

                const shortenedTokenLink = await bitly.shorten(`https://etherscan.io/token/${token.addr}`)
                const shortenedGuidlines = await bitly.shorten(`https://ipfs.kleros.io/ipfs/QmVzwEBpGsbFY3UgyjA3SxgGXx3r5gFGynNpaoXkp6jenu/Ethfinex%20Court%20Policy.pdf`)
                tweet = await twitterClient.post('statuses/update', {
                  status: `${token.name} has requested an Ethfinex Compliant Badge. Verify that the token meets the criteria. If you challenge and win, you will take the deposit of ${prettyWeiToEth(requesterWinnableDeposit)} ETH. \n\nSee the listing here: ${shortenedLink.url}`,
                  in_reply_to_status_id,
                  auto_populate_reply_metadata: true,
                  media_ids: [media.data.media_id_string]
                })
                tweetID = tweet.data.id_str
              }
              else {
                tweet = await twitterClient.post('statuses/update', {
                  status: `Someone requested to remove an Ethfinex Compliant Badge from ${token.name} with a deposit of ${prettyWeiToEth(requesterWinnableDeposit)} ETH. If you challenge the removal and win, you will take the deposit. \n\nSee the listing here: ${shortenedLink.url}`,
                  in_reply_to_status_id,
                  auto_populate_reply_metadata: true
                })
                tweetID = tweet.data.id_str
              }
            }
          }
        }
        else if (eventLog.event === 'Evidence') {
          const tx = await web3.eth.getTransaction(eventLog.transactionHash)
          address = '0x' + tx.input.substr(34,40)

          const tokenQuery = await t2crInstance.methods.queryTokens('0x0000000000000000000000000000000000000000000000000000000000000000', 1, [false,true,false,false,false,false,false,false], true, address).call()
          tokenID = tokenQuery.values[0]
          const token = await t2crInstance.methods.tokens(tokenID).call()

          const tokenThread = await db.findOne({tokenID})
          if (tokenThread)
            in_reply_to_status_id = await tokenThread.lastTweetID

          const evidenceURI = eventLog.returnValues._evidence[0] === '/' ? `${IPFS_URL}${eventLog.returnValues._evidence}` : eventLog.returnValues._evidence
          const evidence = await axios.get(evidenceURI)
          const evidenceJSON = evidence.data

          let shortenedLink

          if (evidenceJSON.fileURI) {
            const linkURI = evidenceJSON.fileURI[0] === "/" ? `${IPFS_URL}${evidenceJSON.fileURI}` : evidenceJSON.fileURI
            shortenedLink = await bitly.shorten(linkURI)
          }
          const evidenceTitle = evidenceJSON.title || evidenceJSON.name || ''
          evidenceJSON.name = evidenceTitle
          const evidenceDescription = evidenceJSON.description || ''

          if (evidenceTitle.length + evidenceDescription.length > 130) {
            if (evidenceTitle.length > 20) evidenceJSON.name = evidenceTitle.substr(0,17) + '...'
            if (evidenceDescription.length > 110) evidenceJSON.description = evidenceDescription.substr(0,107) + '...'
          }

          const shortenedTokenLink = await bitly.shorten(`https://tokens.kleros.io/badge/${process.env.ETHFINEX_BADGE_ID}/${address}`)

          tweet = await twitterClient.post('statuses/update', {
            status: `New Evidence for ${token.name}'s Ethfinex Compliant Badge: ${evidenceJSON.name}
            ${evidenceJSON.description ? `\n${evidenceJSON.description}` : ''}
            \n${shortenedLink ? `\nLink: ${shortenedLink.url}` : ''}
            \n\nSee Full Evidence: ${shortenedTokenLink.url}`,
            in_reply_to_status_id,
            auto_populate_reply_metadata: true,
          })
          tweetID = tweet.data.id_str
        }
      } catch (err) {
        // duplicate tweet. just move on
        console.error(err)
        continue
      }
      // update thread id
      if (tweetID)
        await db.findOneAndUpdate({tokenID}, {$set: {lastTweetID: tweetID}}, { upsert: true })
    }

    // RULINGS
    for (const eventLog of athenaEvents) {
      let tweetID
      let in_reply_to_status_id
      try {
        if (eventLog.returnValues._arbitrable === process.env.T2CR_CONTRACT_ADDRESS) {
          tokenID = await t2crInstance.methods.arbitratorDisputeIDToTokenID(process.env.ARBITRATOR_CONTRACT_ADDRESS, eventLog.returnValues._disputeID).call()
          const token = await t2crInstance.methods.tokens(tokenID).call()

          const tokenThread = await db.findOne({tokenID})
          if (tokenThread)
            in_reply_to_status_id = await tokenThread.lastTweetID

          const currentRuling = await athenaInstance.methods.currentRuling(eventLog.returnValues._disputeID).call()
          if (currentRuling === '0')
            continue

          const extraData = await t2crInstance.methods.arbitratorExtraData().call()
          const appealCost = await athenaInstance.methods.appealCost(eventLog.returnValues._disputeID, extraData).call()
          const winnerStakeMultiplier = await t2crInstance.methods.winnerStakeMultiplier().call()

          const divisor = await t2crInstance.methods.MULTIPLIER_DIVISOR().call()

          const maxFee = web3.utils.toBN(appealCost).mul(web3.utils.toBN(winnerStakeMultiplier)).div(web3.utils.toBN(divisor)).toString()

          const shortenedLink = await bitly.shorten(`https://tokens.kleros.io/token/${tokenID}`)

          tweet = await twitterClient.post('statuses/update', {
            status: `Jurors have ruled ${currentRuling === '1' ? 'for' : 'against'} listing ${token.name}. Think they are wrong? Fund an appeal for the chance to win up to ${prettyWeiToEth(maxFee)} ETH.
            \nSee the listing here: ${shortenedLink.url}`,
            in_reply_to_status_id,
            auto_populate_reply_metadata: true
          })
          tweetID = tweet.data.id_str
        }
        if (eventLog.returnValues._arbitrable === process.env.BADGE_CONTRACT_ADDRESS) {
          const address = await badgeInstance.methods.arbitratorDisputeIDToAddress(process.env.ARBITRATOR_CONTRACT_ADDRESS, eventLog.returnValues._disputeID).call()

          const tokenQuery = await t2crInstance.methods.queryTokens('0x0000000000000000000000000000000000000000000000000000000000000000', 1, [false,true,false,false,false,false,false,false], true, address).call()
          tokenID = tokenQuery.values[0]
          const token = await t2crInstance.methods.tokens(tokenID).call()

          const tokenThread = await db.findOne({tokenID})
          if (tokenThread)
            in_reply_to_status_id = await tokenThread.lastTweetID

          const currentRuling = await athenaInstance.methods.currentRuling(eventLog.returnValues._disputeID).call()
          if (currentRuling === '0')
            continue

          const extraData = await badgeInstance.methods.arbitratorExtraData().call()
          const appealCost = await athenaInstance.methods.appealCost(eventLog.returnValues._disputeID, extraData).call()
          const winnerStakeMultiplier = await badgeInstance.methods.winnerStakeMultiplier().call()
          const divisor = await badgeInstance.methods.MULTIPLIER_DIVISOR().call()

          const maxFee = web3.utils.toBN(appealCost).mul(web3.utils.toBN(winnerStakeMultiplier)).div(web3.utils.toBN(divisor)).toString()

          const shortenedLink = await bitly.shorten(`https://tokens.kleros.io/badge/${process.env.ETHFINEX_BADGE_ID}/${address}`)

          tweet = await twitterClient.post('statuses/update', {
            status: `Jurors have ruled ${currentRuling === '1' ? 'for' : 'against'} giving ${token.name} the Ethfinex Compliant Badge. Think they are wrong? Fund an appeal for the chance to win up to ${prettyWeiToEth(maxFee)} ETH.
            \nSee the listing here: ${shortenedLink.url}`,
            in_reply_to_status_id,
            auto_populate_reply_metadata: true
          })
          tweetID = tweet.data.id_str
        }
      } catch (err) {
        // duplicate tweet. just move on
        console.error(err)
        continue
      }

      // update thread id
      if (tweetID)
        await db.findOneAndUpdate({tokenID}, {$set: {lastTweetID: tweetID}}, { upsert: true })
    }

    db.findOneAndUpdate({'tokenID': '0x0'}, {$set: {lastBlock: currentBlock}}, { upsert: true })
    lastBlock=currentBlock+1
  }
}
