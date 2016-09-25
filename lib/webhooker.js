"use strict";

const Promise = require('bluebird');
const request = require('request-promise');
const Formio = require('formio-service');
const retry = require('bluebird-retry');

const Subscription = require('./subscription');

/**
 *
 * @param opts
 * @param done
 * @returns {Webhooker}
 * @constructor
 */
function Webhooker(opts, done) {
  if (!(this instanceof Webhooker)) {
    return new Webhooker(opts, done);
  }

  if (typeof opts === "function") {
    done = opts;
    opts = {};
  }

  const logger = this._logger = opts.ponte.logger.child({service: 'Webhooker'});

  this.subscriptions = {};

  this._opts = opts;
  this._persistence = opts.ponte.persistence;
  this._broker = opts.ponte.broker;
  this._ponte = opts.ponte;

  this._formio = Formio({
    formio: opts.formio.api,
    api: opts.formio.api
  });

  this.buildCallbackServer(opts)
    .then((server) => {
      this.server = server;
      return this.fetchWebhooks(opts);
    })
    .then(webhooks => this.subscribe(webhooks))
    .then(() => {
      logger.info("Webhooker started");
      done(null, this);
    });
}

Webhooker.prototype.close = function (done) {
  this.server && this.server.close(done);
};

Webhooker.prototype.buildCallbackServer = function (opts) {
  const express = require('express');
  const basicAuth = require('basic-auth-connect');
  const bodyParser = require('body-parser');
  const methodOverride = require('method-override');

  const callbackOptions = opts.callback || {};

  const app = express();

  // Add Middleware necessary for REST API's
  app.use(bodyParser.urlencoded({extended: true}));
  app.use(bodyParser.json());
  app.use(methodOverride('X-HTTP-Method-Override'));

  // Add Basic authentication to our API.
  app.use(basicAuth(callbackOptions.user, callbackOptions.password));

  // Handle the requests.
  //  ---- POST ----
  //  { request:
  //    { data: { topic: 'hello', url: 'hello', user: 'hello', secret: 'hello' },
  //      owner: '57e0fe732f94dba5003d6636',
  //       form: '57e0e95bb2fc69743f7f314b' },
  //     params: { formId: '57e0e95bb2fc69743f7f314b' } }
  //
  //   ----- PUT -----
  //   { request:
  //     { data: { topic: 'hello1', url: 'hello', user: 'hello', secret: 'hello' },
  //       _id: '57e39566923c9751b34b13d0',
  //       form: '57e0e95bb2fc69743f7f314b' },
  //       params:
  //       { formId: '57e0e95bb2fc69743f7f314b',
  //         submissionId: '57e39566923c9751b34b13d0' } }
  //
  //   --- DELETE ---
  //   { formId: '57e0e95bb2fc69743f7f314b',
  //     submissionId: '57e39566923c9751b34b13d0' }

  const that = this;
  const logger = this._logger;

  function update(req, res, next) {
    const request = req.body.request;
    const data = request && request.data;
    if (data && data.topic && data.url) {
      data._id = data._id || request._id;
      that.subscribe(data);
    } else {
      logger.error(req.body, 'Unknown request for callback server');
    }
    res.end();
  }

  function remove(req, res, next) {
    if (req.query && req.query.submissionId) {
      that.unsubscribe(req.body.submissionId);
      res.end();
    }

  }

  app.post('/*', update);
  app.put('/*', update);
  app.delete('/*', remove);

  return new Promise((resolve, reject) => {
    const server = app.listen(callbackOptions.port, err => {
      if (err) return reject(err);
      logger.info({port: callbackOptions.port}, 'callback server started');
      resolve(server);
    });
  });

};

Webhooker.prototype.fetchWebhooks = function (opts) {
  let times = 0;
  const retries = opts.formio.retries || {timeout: 30 * 60 * 1000, interval: 1000};
  return retry(() => this._fetchWebhooks(opts).catch(err => {
    if (err.code !== 'ECONNREFUSED') {
      throw new retry.StopError(err);
    }
    this._logger.info(opts.formio, 'try fetching webhooks ' + (++times) + ' times');
    throw err;
  }), retries);
};

Webhooker.prototype._fetchWebhooks = function (opts) {
  const Form = this._formio.Form;
  const formioOptions = opts.formio || {};

  return this._formio.authenticate(formioOptions.user, formioOptions.password).then(function () {
    const form = new Form(formioOptions.api + '/webhook');
    return form.loadSubmissions();
  });
};

Webhooker.prototype.subscribe = function (webhooks) {
  if (!webhooks) return;
  webhooks = Array.isArray(webhooks) ? webhooks : [webhooks];
  return Promise.all(Promise.map(webhooks, webhook => this._subscribe(webhook)));
};

Webhooker.prototype._subscribe = function (webhook) {
  if (!webhook)  return;
  const id = webhook.id || webhook._id;
  const data = webhook.data || webhook;
  return this.unsubscribe(id).then(() => {
    this.subscriptions[id] = new Subscription(this._broker, data.topic, this._buildMessageHandler(id, data));
    return this.subscriptions[id];
  }).then((sub) => {
    this._logger.debug('subscribed ' + sub.topic);
    return sub;
  });
};

Webhooker.prototype._buildMessageHandler = function (id, webhook) {
  const logger = this._logger;
  return function (topic, payload) {
    logger.debug({topic: topic, callback: webhook.url}, 'forward message');

    const headers = {};
    if (webhook.user) {
      headers.authorization = 'Basic ' + new Buffer(webhook.user + ':' + webhook.secret).toString('base64');
    }
    request({
      method: 'POST',
      uri: webhook.url,
      headers: headers,
      body: {topic: topic, payload: payload},
      json: true
    }).then(function () {
      logger.debug({topic: topic, callback: webhook.url}, 'forward message success');
    }).catch(function (err) {
      logger.error({topic: topic, callback: webhook.url}, 'forward message failure');
      throw err;
    });
  };
};

Webhooker.prototype.unsubscribe = function (id) {
  if (this.subscriptions[id]) {
    return this.subscriptions[id].unsubscribe().then(() => {
      this._logger.debug('un-subscribed ' + this.subscriptions[id].topic);
      delete this.subscriptions[id];
    });
  }
  return Promise.resolve();
};

module.exports = Webhooker;
