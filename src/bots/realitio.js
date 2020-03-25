const fs = require('fs')
const axios = require('axios')
const { BitlyClient } = require('bitly')
const delay = require('delay')

const _realitio = require('../contracts/realitio.json')
const _proxy = require('../contracts/proxy.json')

const REALITIO_MONGO_COLLECTION = 'questions'
const IPFS_URL = 'https://ipfs.kleros.io'

module.exports = async (web3, mongoClient, realitioAddress, proxyAddress) => {
  // Instantiate the contracts.
  const realitioInstance = new web3.eth.Contract(
    _realitio.abi,
    realitioAddress
  )
  const proxyInstance = new web3.eth.Contract(
    _proxy.abi,
    proxyAddress
  )

  // connect to the right collection
  await mongoClient.createCollection(REALITIO_MONGO_COLLECTION)
  const db = mongoClient.collection(REALITIO_MONGO_COLLECTION)

  // get our starting point
  let lastBlock = 0
  let appState = await db.findOne({'proxyAddress': proxyAddress})
  if (appState) {
    lastBlock = appState.lastBlock
  }
  else {
    // if starting from scratch we can go from 0
    await db.insertOne({'proxyAddress': proxyAddress, 'lastBlock': 0})
  }

  while (true) {
    await delay(process.env.DELAY_AMOUNT)
    currentBlock = await web3.eth.getBlockNumber()
    // console.log(lastBlock)
    ruleEvents = await proxyInstance.getPastEvents('Ruling', {
      fromBlock: lastBlock,
      toBlock: 'latest'
    })
    // console.log(ruleEvents.length)

    // A Ruling was made
    for (const eventLog of ruleEvents) {
      const _disputeID = eventLog.returnValues._disputeID

      const questionIDEvent = await proxyInstance.getPastEvents('DisputeIDToQuestionID', {
        filter: {
          _disputeID
        },
        fromBlock: 0,
        toBlock: 'latest'
      })

      if (questionIDEvent.length < 1) continue

      const questionID = questionIDEvent[0].returnValues._questionID
      const question = await realitioInstance.methods.questions(questionID).call()
      const bestAnswer = question.best_answer
      const bond = question.bond

      const answerEvents = await realitioInstance.getPastEvents('LogNewAnswer', {
        fromBlock: 0,
        filter: {
          question_id: questionID
        }
      })

      // Only 1 answer
      let historyHash = '0x0000000000000000000000000000000000000000000000000000000000000000'
      if (answerEvents.length > 1) {
        historyHash = answerEvents[answerEvents.length - 2].returnValues.history_hash
      }
      const answerer = answerEvents[answerEvents.length - 1].returnValues.user

      // DEBUG
      // console.log('Reporting answer for disputeID ' + _disputeID)
      // console.log(`questionID: ${questionID}`)
      // console.log(`historyHash: ${historyHash}`)
      // console.log(`bestAnswer: ${bestAnswer}`)
      // console.log(`bond: ${bond}`)
      // console.log(`answerer: ${answerer}`)
      const txHash = await proxyInstance.methods.reportAnswer(
        questionID,
        historyHash,
        bestAnswer,
        bond,
        answerer,
        false
      ).send({
        from: web3.eth.accounts.wallet[0].address,
        gas: process.env.GAS_LIMIT
      })
    }
    db.findOneAndUpdate({'proxyAddress': proxyAddress}, {$set: {lastBlock: currentBlock}}, { upsert: true })
    lastBlock=currentBlock+1
  }
}
