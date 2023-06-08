const fs = require("fs")
const https = require("https")
const express = require("express")
const expressWs = require("express-ws")
const morgan = require("morgan")
const bodyParser = require("body-parser")
// const mysql = require("mysql")

const twilio = require("twilio")
const MessagingResponse = twilio.twiml.MessagingResponse
const VoiceResponse = twilio.twiml.VoiceResponse
const speech = require("@google-cloud/speech")
const textToSpeech = require("@google-cloud/text-to-speech")

const { Configuration, OpenAIApi } = require("openai")
const configuration = new Configuration({
    apiKey: fs.readFileSync("secret/openai_api_key").toString()
})
const openai = new OpenAIApi(configuration)

const isProduction = !!process.env.PRODUCTION

function log(...args) {
    if (isProduction) return
    console.log(...args)
}

log("is production:", isProduction)
const app = express()
expressWs(app)

app.use(morgan("dev"))

app.use(bodyParser({ extended: false }))

let appUrl = "https://4c0e-3-17-57-219.ngrok-free.app"

const conversations = {}
const charCount = {}
const pendingText = {}
const speechStreams = {}
const callSidMap = {}
const streamIdMap = {}
const lastActionTime = {}
const callIds = {}
const isPending = {}
const pendingQueries = {}

let id = 0

// const pool = mysql.createPool({
//     host: "localhost",
//     user: "Gimple",
//     password: "Gimple@3030",
//     database: "Gimple"
// })

// function queryDatabase(connection, sql, params) {
//     return new Promise((resolve, reject) => {
//         connection.query(sql, params, (error, results) => {
//             if (error) reject(error)
//             else resolve(results)
//         })
//     })
// }

// function getConnection() {
//     return new Promise((resolve, reject) => {
//         pool.getConnection((error, connection) => {
//             if (error) reject(error)
//             else resolve(connection)
//         })
//     })
// }

function getResponseFromGPT(callSid, n = 5) {
    return new Promise((resolve, reject) => {
        if (n <= 0)
            return reject(new Error("Couldn't get response from ChatGPT"))
        openai
            .createChatCompletion({
                model: "gpt-3.5-turbo",
                messages: conversations[callSid]
            })
            .then((ans) => {
                log("ans:", ans)
                let currentResponse = ""
                log(ans.data.choices)
                for (const c of ans.data.choices)
                    currentResponse += c.message.content
                charCount[callSid] += currentResponse.length
                conversations[callSid].push({
                    role: "assistant",
                    content: currentResponse
                })
                log(conversations[callSid].join("\n\n"))
                while (charCount[callSid] > 1500) {
                    charCount[callSid] -=
                        conversations[callSid][1].content.length
                    conversations[callSid].splice(1, 1)
                }
                resolve(currentResponse)
            })
            .catch((err) => {
                log("An error occurred in getting response from GPT")
                log(err)
                setTimeout(() => {
                    getResponseFromGPT(callSid, n - 1)
                        .then((ans) => resolve(ans))
                        .catch((err) => reject(err))
                }, 500)
            })
    })
}

function getVoiceFromText(text, audioId, n = 5) {
    return new Promise((resolve, reject) => {
        if (n <= 0)
            return reject(new Error("Couldn't get voice from text:", text))
        const client = new textToSpeech.TextToSpeechClient()

        const request = {
            input: { text },
            voice: {
                languageCode: "en-US"
            },
            audioConfig: {
                audioEncoding: "MP3"
            }
        }

        client
            .synthesizeSpeech(request)
            .then((response) => {
                log(response)
                fs.writeFileSync(
                    __dirname + "/audio/" + audioId + ".mp3",
                    response[0].audioContent
                )
                resolve()
            })
            .catch((err) => {
                log("An error occurred in getting voie from text")
                log(err)
                setTimeout(() => {
                    getVoiceFromText(text, audioId, n - 1)
                        .then(() => resolve())
                        .catch((err) => reject(err))
                }, 500)
            })
    })
}

// cleans up all allocated memory of a call if there was no action in the call for more than 10 minutes
function cleanupAfterNoAction(currId) {
    if (
        !(currId in lastActionTime) ||
        lastActionTime[currId] + 600000 < Date.now()
    ) {
        delete lastActionTime[currId]
        delete conversations[currId]
        delete charCount[currId]
        delete pendingText[currId]
        delete speechStreams[currId]
        delete callSidMap[currId]
        delete streamIdMap[currId]
        delete callIds[currId]
        delete pendingQueries[currId]
        return
    }
    setTimeout(() => cleanupAfterNoAction(actionId, currId), 600000)
}

// Create a route that will handle Twilio webhook requests, sent as an
// HTTP POST to /voice in our application
app.post("/voice/income", async (req, res) => {
    log("New caller:", req.body)
    // let connection
    // try {
    //     connection = await getConnection()
    //     let queryResult = await queryDatabase(
    //         connection,
    //         `select id from phone_numbers where number='${req.body.Caller}'`
    //     )
    //     log(queryResult)
    //     let phoneId
    //     if (queryResult.length === 0) {
    //         log(
    //             "phone number is not it database. adding new phone number to database"
    //         )
    //         queryResult = await queryDatabase(
    //             connection,
    //             `insert into phone_numbers (number, country, state, city, zip) values(?, ?, ?, ?, ?)`,
    //             [
    //                 req.body.Caller,
    //                 req.body.CallerCountry,
    //                 req.body.CallerState,
    //                 req.body.CallerCity,
    //                 req.body.CallerZip
    //             ]
    //         )
    //         phoneId = queryResult.insertId
    //         log(queryResult)
    //     } else phoneId = queryResult[0].id
    //     log("phoneId:", phoneId)
    //     queryResult = await queryDatabase(
    //         connection,
    //         `insert into phone_calls (call_date_time, phone_number_id) values(?, ?)`,
    //         [new Date().toISOString().slice(0, 19).replace("T", " "), phoneId]
    //     )
    //     log("query result:", queryResult)
    //     const callId = queryResult.insertId
    //     callIds[req.body.CallSid] = callId
    //     log("callId:", callId)
    // } catch (error) {
    //     log(error)
    // }
    // if (connection) connection.release()

    // setTimeout(() => {
    conversations[req.body.CallSid] = [
        {
            role: "system",
            content: `You are Gimple, an AI assistant catering to the internet-lacking Hasidic community. Users connect via phone to chat. Ensure responses are concise, align with Hasidic customs, and avoid any potential heresy. Current date: ${new Date().toDateString()}. Created: May 2023. Knowledge cutoff: June 2020.`
        }
    ]
    charCount[req.body.CallSid] =
        conversations[req.body.CallSid][0].content.length

    const twiml = new VoiceResponse()
    conversations[req.body.CallSid].push({
        role: "assistant",
        content: "Hello, this is Gimple. How can I help you?"
    })
    charCount[req.body.CallSid] += conversations[req.body.CallSid][1].length + 2
    const audioId = id++
    getVoiceFromText("Hello, this is Gimple. How can I help you?", audioId)
        .then(() => {
            twiml.play(appUrl + "/voice/audio/" + audioId + ".mp3")
            const start = twiml.start()
            const streamId = id++
            streamIdMap[req.body.CallSid] = streamId
            start.stream({
                url: "wss" + appUrl.slice(5) + "/voice/stream",
                name: "stream" + streamId
            })
            lastActionTime[req.body.CallSid] = Date.now()
            twiml.redirect(appUrl + "/voice/redirect")
            res.type("text/xml")
            res.send(twiml.toString())
        })
        .catch((err) => log("error", err))
    setTimeout(() => cleanupAfterNoAction(req.body.CallerSid), 600000)
})

app.post("/voice/redirect", (req, res) => {
    const callSid = req.body.CallSid
    const twiml = new VoiceResponse()
    // log("last action time:", lastActionTime[req.body.CallSid])
    // log(new Date(lastActionTime[req.body.CallSid]).toLocaleString())
    // log("curr time:", Date.now())
    // log(new Date(Date.now()).toLocaleString())
    const startTime = Date.now()
    const waitForResponse = () => {
        if (Date.now() > startTime + 13000) {
            twiml.redirect(appUrl + "/voice/redirect")
            res.type("text/xml")
            res.send(twiml.toString())
        } else if (lastActionTime[callSid] + 90000 < Date.now()) {
            log("disconnecting call")
            res.type("text/xml")
            res.send(twiml.toString())
        } else if (callSid in pendingQueries) {
            const stop = twiml.stop()
            stop.stream({ name: "stream" + streamIdMap[callSid] })
            twiml.redirect(appUrl + "/voice/redirect")
            res.type("text/xml")
            res.send(twiml.toString())
            delete streamIdMap[callSid]
            const currQuery = pendingQueries[callSid]
            log("currQuery", currQuery)
            conversations[callSid].push({
                role: "user",
                content: currQuery
            })
            charCount[callSid] += pendingQueries[callSid].length
            delete pendingQueries[callSid]
            lastActionTime[callSid] = Date.now()
            getResponseFromGPT(callSid)
                .then(async (response) => {
                    lastActionTime[callSid] = Date.now()
                    // let connection
                    // try {
                    //     connection = await getConnection()
                    //     let queryResult = await queryDatabase(
                    //         connection,
                    //         "insert into queries values(?, ?, ?, ?)",
                    //         [
                    //             new Date().toISOString().slice(0, 19).replace("T", " "),
                    //             currQuery,
                    //             response,
                    //             callIds[req.body.CallSid]
                    //         ]
                    //     )
                    //     log("query result:", queryResult)
                    // } catch (error) {
                    //     log(error)
                    // }
                    // if (connection) connection.release()
                    pendingText[callSid] = response

                    lastActionTime[callSid] = Date.now()
                })
                .catch((err) => log("error:", err))
        } else if (callSid in pendingText) {
            const audioId = id++
            getVoiceFromText(pendingText[callSid], audioId)
                .then(() => {
                    twiml.play(appUrl + "/voice/audio/" + audioId + ".mp3")
                    const start = twiml.start()
                    const streamId = id++
                    streamIdMap[callSid] = streamId
                    start.stream({
                        url: "wss" + appUrl.slice(5) + "/voice/stream",
                        name: "stream" + streamId
                    })
                    lastActionTime[callSid] = Date.now()
                    twiml.redirect(appUrl + "/voice/redirect")
                    res.type("text/xml")
                    res.send(twiml.toString())
                })
                .catch((err) => log("error:", err))
            delete pendingText[callSid]
        } else {
            setTimeout(waitForResponse, 1000)
        }
    }
    setTimeout(waitForResponse, 0)
})

app.get("/voice/audio/:id", (req, res) => {
    const audioId = req.params.id
    setTimeout(() => fs.unlinkSync(__dirname + "/audio/" + audioId), 10000)
    res.sendFile(__dirname + "/audio/" + audioId)
})

app.ws("/voice/stream", (ws, req) => {
    ws.on("message", (message) => {
        const parsed = JSON.parse(message)
        if (parsed.event === "start") {
            const client = new speech.SpeechClient()
            callSidMap[parsed.streamSid] = parsed.start.callSid

            const encoding = "MULAW"
            const sampleRateHertz = 8000
            const languageCode = "en-US"

            const request = {
                config: {
                    encoding: encoding,
                    sampleRateHertz: sampleRateHertz,
                    languageCode: languageCode,
                    enableAutomaticPunctuation: true
                },
                interimResults: false // If you want interim results, set this to true
            }

            // Stream the audio to the Google Cloud Speech API
            const recognizeStream = client
                .streamingRecognize(request)
                .on("error", (err) => {
                    log("An error occurred in speech stream")
                    log(err)
                })
                .on("data", (data) => {
                    log("data recieved:")
                    log(JSON.stringify(data))
                    pendingQueries[callSidMap[parsed.streamSid]] =
                        data.results[0].alternatives[0].transcript
                })

            // Stream an audio file from disk to the Speech API, e.g. "./resources/audio.raw"
            speechStreams[parsed.streamSid] = recognizeStream
        }
        if (parsed.event === "media") {
            speechStreams[parsed.streamSid].write(
                Buffer.from(parsed.media.payload, "base64")
            )
        }
        if (parsed.event === "stop") {
            const streamSid = parsed.streamSid
            speechStreams[streamSid].end()
            delete callSidMap[parsed.streamSid]
            setTimeout(() => delete speechStreams[streamSid], 60000)
            log("disctonnecting stream with sid:", streamSid)
        }
    })
})

app.post("/message/income", (req, res) => {
    const twiml = new MessagingResponse()
    console.log(req.body.Body)
    log(req.body.From)
    if (req.body.From in isPending) {
        // twiml.message("Please wait for response from previous question...")
        res.type("text/xml")
        res.send(twiml.toString())
        return
    }
    isPending[req.body.From] = true
    if (!(req.body.From in conversations)) {
        conversations[req.body.From] = [
            {
                role: "system",
                content: `You are Gimple, an AI assistant catering to the internet-lacking Hasidic community. Users connect via text messaging to chat. Ensure responses are concise, align with Hasidic customs, and avoid any potential heresy. Current date: ${new Date().toDateString()}. Created: May 2023. Knowledge cutoff: June 2020.`
            }
        ]
        charCount[req.body.From] =
            conversations[req.body.From][0].content.length
    } else
        conversations[req.body.From][0] = {
            role: "system",
            content: `You are Gimple, an AI assistant catering to the internet-lacking Hasidic community. Users connect via text messaging to chat. Ensure responses are concise, align with Hasidic customs, and avoid any potential heresy. Current date: ${new Date().toDateString()}. Created: May 2023. Knowledge cutoff: June 2020.`
        }
    conversations[req.body.From].push({
        role: "user",
        content: req.body.Body
    })
    charCount[req.body.From] += req.body.Body.length
    getResponseFromGPT(req.body.From)
        .then((response) => {
            pendingText[req.body.From] = response
        })
        .catch((err) => {
            log("error:", err)
            pendingText[req.body.From] = "Error"
        })
    log("redirecting")
    twiml.redirect(appUrl + "/message/redirect")
    res.type("text/xml")
    res.send(twiml.toString())
})

app.post("/message/redirect", (req, res) => {
    const twiml = new MessagingResponse()
    const startTime = Date.now()
    const waitForResponse = () => {
        if (Date.now() > startTime + 13000) {
            twiml.redirect(appUrl + "/message/redirect")
            res.type("text/xml")
            res.send(twiml.toString())
        } else if (req.body.From in pendingText) {
            // pendingLock[req.body.AccountSid] = true
            if (pendingText[req.body.From] !== "Error")
                twiml.message(pendingText[req.body.From])
            else log("Error occurred in getting response from gpt")
            // delete pendingLock[req.body.AccountSid]
            res.type("text/xml")
            res.send(twiml.toString())
            setTimeout(() => {
                delete pendingText[req.body.From]
                delete isPending[req.body.From]
            }, 1000)
        } else {
            setTimeout(waitForResponse, 1000)
        }
    }
    setTimeout(waitForResponse, 0)
})

app.post("/voice/error", (req, res) => {
    log("An error occurred in voice")
    log(req.body)
})

log("/message/error", (req, res) => {
    log("An error occurred in messages")
    log(req.body)
})

// Create an HTTP server and listen for requests on port 3000
const PORT = 3030
app.listen(PORT, () => {
    log(
        `Now listening on port ${PORT}. ` +
            "Be sure to restart when you make code changes!"
    )
})
