const Q = require('q')
const cheerio = require('cheerio')
const fs = require('fs-extra')
const path = require('path')
const request = require('request')
const moment = require('moment')
const lowDb = require('lowdb')
const lowDbStorage = require('lowdb/lib/storages/file-sync')
const objectMap = require('object.map')
const trim = require('trim')
const sleep = require('sleep-time')
const Slack = require('slack-node')

const slackWebHook = process.env.LABS_SLACK_WEBHOOK_URL_DEVPARANA_BOT_PR || false
const dbFile = path.join(__dirname, 'data/db.json')

if (!fs.existsSync(path.dirname(dbFile)) && !fs.mkdirsSync(path.dirname(dbFile))) {
  throw new Error('Error creating data dir.')
} else if (!slackWebHook) {
  throw new Error('Slack Webhook not found in enviroment variables. Aborting...')
}

const db = lowDb(dbFile, { storage: lowDbStorage })

db.defaults({ jobs: [], settings: {} }).write()

// -------------------------------------------------------------------------------------------------

let slack = new Slack()
let deferred = Q.defer()
let deferredProcessing = Q.defer()
let deferredFinal = Q.defer()
let htmlFileTests = path.join(__dirname, 'jobs.html')
let sandBox = false

slack.setWebhook(slackWebHook)

_log('Searching for new job offers...')

try {
  if (sandBox && fs.existsSync(htmlFileTests)) {
    deferred.resolve(fs.readFileSync(htmlFileTests))
  } else {
    request('http://www.infojobs.com.br/vagas-de-emprego-programador-em-parana.aspx?Categoria=74&gridtype=2', (err, response, body) => {
      if (err) {
        return deferred.reject(err)
      } else if (response.statusCode !== 200) {
        return deferred.reject(`Error completing the resquest. Status Code => ${response.statusCode}`)
      }
      deferred.resolve(trim(body))
    })
  }

  Q.when(deferred.promise, html => {
    if (sandBox && !fs.existsSync(htmlFileTests)) {
      fs.writeFileSync(htmlFileTests, html, 'utf8')
    }

    let $ = cheerio.load(html)
    let jobsOffers = $('ol[itemtype="http://schema.org/JobPosting"]').filter((index, element) => $(element).find('.limited').length === 0)

    if (!jobsOffers.length) {
      throw new Error('No Job vaccancies was found.')
    }

    jobsOffers = jobsOffers.map((index, element) => {
      let $element = $(element)

      let id = $element.attr('id')
      let title = $element.find('[itemprop="title"]').text()
      let date = $element.find('[itemprop="datePosted"]').contents().get(0).nodeValue
      let city = $element.find('[itemprop="jobLocation"]').text()
      let company = $element.find('[itemprop="hiringOrganization"]').text()
      let description = $element.find('[itemprop="description"]').contents().get(0).nodeValue
      let url = $element.find('[itemprop="description"] a').attr('href')
      let dateProcessed = moment().unix()
      let labels = $element.find('.area').attr('title').split(',').map(item => trim(item))
      let botProcessed = false
      let botProcessedDate = null

      date = trim(date).split(' ')
      if (/\//.test(date[0])) {
        date[0] += `/${moment().format('YYYY')}`
      } else if (date[0] === 'Hoje') {
        date[0] = moment().format('DD/MM/YYYY')
      } else if (date[0] === 'Ontem') {
        date[0] = moment().subtract(1, 'days').format('DD/MM/YYYY')
      }
      date[0] = date[0].split('/').reverse().join('-')
      date = `${date.join(' ')}:00`
      date = moment(date).unix().toString()

      return objectMap(
        { id, title, labels, date, dateProcessed, city, company, description, url, botProcessed, botProcessedDate },
        val => val !== null && val.constructor === String ? trim(val) : val
      )
    }).get()

    deferredProcessing.resolve(jobsOffers)
  }, err => {
    throw err
  })

  Q.when(deferredProcessing.promise).then(jobs => {
    let jobsBaseID = db.get('jobs').value().map(item => item.id)

    jobs.filter(item => {
      return jobsBaseID.indexOf(item.id) < 0
    }).forEach(job => {
      db.get('jobs').push(job).write()
    })

    deferredFinal.resolve()
  })

  Q.when(deferredFinal.promise).then(() => {
    let jobs = db.get('jobs').filter({ botProcessed: false }).sortBy('date').reverse().value()

    _log(`Found ${jobs.length} job offers.`)

    if (jobs.length) {
      _log('Processing items to send to slack...')
    } else {
      _log('No new jobs to send to slack...')
    }

    _log('-'.repeat(100))

    try {
      jobs.forEach((item, index) => {
        _log('Processing item ' + (index + 1))

        let date = moment.unix(item.date).format('DD/MM/YYYY')

        _log(item.title, date)
        _log('-'.repeat(100))

        let params = {
          attachments: [{
            title: `${item.title} - ${item.city}`,
            title_link: item.url,
            text: `Vaga: ${item.title}\nData: ${date}\nDetalhes: ${item.labels.join(', ')}`,
            color: '#7CD197'
          }],
          text: 'Vaga de trabalho encontrada. Confira! \n\n' + item.url
        }

        slack.webhook(params, (err, response) => {
          if (err) {
            throw err
          }
          if (response.statusCode === 200) {
            _log('Done posting item ' + (index + 1))
            _log('-'.repeat(100))
            db.get('jobs').find({ id: item.id }).assign({ botProcessed: true, botProcessedDate: moment().unix() }).write()
          } else {
            throw new Error('Error processing item ' + (index + 1) + ': ' + response.statusCode + ': ' + response.statusMessage)
          }
        })
        sleep(1000)
        _log('-'.repeat(100))
      })
    } catch (err) {
      _log('ERROR: ', err)
      _log('-'.repeat(100))
    }
  })
} catch (err) {
  _log('ERROR: ', err)
  _log('-'.repeat(100))
}

function _log () {
  console.log.apply(console, [].concat([`[${moment().format('DD/MM/YYYY HH:mm:ss')}] =>`], Array.from(arguments) || []))
}
