"use strict";

var Promise = require('bluebird');
var request = require('request-promise');
var Formio = require('formio-service');
var retry = require('bluebird-retry');

/**
 *
 * @param webhooker
 * @param id
 * @param webhook
 * @returns {Subscription}
 * @constructor
 */
function Subscription(webhooker, id, webhook) {
  if (!(this instanceof Subscription)) {
    return new Subscription(webhooker, id, webhook);
  }

  var logger = this._logger = webhooker._logger;
  this._broker = webhooker._broker;
  this._id = id;
  this._webhook = webhook;

  this.topic = webhook.topic;
  this.url = webhook.url;

  this._callback = function callback(topic, payload) {
    logger.debug({topic: topic, callback: webhook.url}, 'forward message');

    var headers = {};
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

  this._broker.subscribe(webhook.topic, this._callback);
}

Subscription.prototype.unsubscribe = function () {
  return new Promise((resolve, reject) => {
    this._broker.unsubscribe(this._webhook.topic, this._callback, err => {
      if (err) return reject(err);
      resolve();
    });
  });
};

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

  var logger = this._logger = opts.ponte.logger.child({service: 'Webhooker'});

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
  var express = require('express');
  var basicAuth = require('basic-auth-connect');
  var bodyParser = require('body-parser');
  var methodOverride = require('method-override');

  var callbackOptions = opts.callback || {};

  var app = express();

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

  var that = this;
  var logger = this._logger;

  function update(req, res, next) {
    var request = req.body.request;
    var data = request && request.data;
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
    var server = app.listen(callbackOptions.port, err => {
      if (err) return reject(err);
      logger.info({port: callbackOptions.port}, 'callback server started');
      resolve(server);
    });
  });

};

Webhooker.prototype.fetchWebhooks = function (opts) {
  var times = 0;
  var retries = opts.formio.retries || {timeout: 30 * 60 * 1000, interval: 1000};
  return retry(() => this._fetchWebhooks(opts).catch(err => {
    if (err.code !== 'ECONNREFUSED') {
      throw new retry.StopError(err);
    }
    this._logger.info(opts.formio, 'try fetching webhooks ' + (++times) + ' times');
    throw err;
  }), retries);
};

Webhooker.prototype._fetchWebhooks = function (opts) {
  var Form = this._formio.Form;
  var formioOptions = opts.formio || {};

  return this._formio.authenticate(formioOptions.user, formioOptions.password).then(function () {
    var form = new Form(formioOptions.api + '/webhook');
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
  var id = webhook.id || webhook._id;
  return this.unsubscribe(id).then(() => {
    this.subscriptions[id] = new Subscription(this, id, webhook.data || webhook);
    return this.subscriptions[id];
  }).then((sub) => {
    this._logger.debug('subscribed ' + sub.topic);
    return sub;
  });
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
