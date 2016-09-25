'use strict';
/*******************************************************************************
 * Copyright (c) 2013-2014 Matteo Collina
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v1.0
 * and Eclipse Distribution License v1.0 which accompany this distribution.
 *
 * The Eclipse Public License is available at
 *    http://www.eclipse.org/legal/epl-v10.html
 * and the Eclipse Distribution License is available at
 *   http://www.eclipse.org/org/documents/edl-v10.php.
 *
 * Contributors:
 *    Matteo Collina - initial API and implementation and/or initial documentation
 *******************************************************************************/

const Promise = require('bluebird');
const http = require("http");
const resourcesRegexp = /^\/r\/(.+)$/;
const callback = require("callback-stream");
const bunyan = require("bunyan");
const st = require("st");
const corsify = require("corsify");

const Subscription = require('./subscription');

/**
 *
 * @param opts
 * @param done
 * @returns {HTTP}
 * @constructor
 */
function HTTP(opts, done) {
  if (!(this instanceof HTTP)) {
    return new HTTP(opts, done);
  }

  if (typeof opts === "function") {
    done = opts;
    opts = {};
  }

  const that = this;
  this._subsctiptions = {};
  this._persistence = opts.ponte.persistence;
  this._ponte = opts.ponte;

  if (typeof opts.authenticate === "function") {
    this.authenticate = opts.authenticate;
  }

  if (typeof opts.authorizeGet === "function") {
    this.authorizeGet = opts.authorizeGet;
  }

  if (typeof opts.authorizePut === "function") {
    this.authorizePut = opts.authorizePut;
  }

  const logger = this._logger = opts.ponte.logger.child({
    service: 'HTTP',
    serializers: {
      req: bunyan.stdSerializers.req,
      res: bunyan.stdSerializers.res
    }
  });
  this.server = http.createServer(this.buildServer(opts));
  this.server.listen(opts.port, opts.host, function(err) {
    done(err, that);
    logger.info({ port: opts.port }, "server started");
  });

  if (this._ponte.mqtt) {
    this._ponte.mqtt.attachHttpServer(this.server);
  }
}

HTTP.prototype.close = function(done) {
  this._unsubscribeAll().then(() => {
    this.server.close(done);
  });
};

HTTP.prototype.buildServer = function(opts) {
  const that = this;
  const logger = this._logger;
  const persistence = this._persistence;
  const ponte = this._ponte;

  const authenticate = this.authenticate;
  const authorizeGet = this.authorizeGet;
  const authorizePut = this.authorizePut;

  function handleAuthError(err, res) {
    logger.info(err);
    res.statusCode = 500;
    res.end();
  }

  function handleNotAuthenticated(res) {
    logger.info('authentication denied');
    res.statusCode = 401;
    res.end();
  }

  function handleNotAuthorized(res) {
    logger.info('not authorized');
    res.statusCode = 403;
    res.end();
  }

  const handlePontePublic = st(opts.publicDirs.ponte, {
    index: false,
    passthrough: true,
    dot: opts.publicDirs.mosca.match(/(^|\/)\./)
  });

  const handleMoscaPublic = st(opts.publicDirs.mosca, {
    index: false,
    passthrough: false,
    dot: opts.publicDirs.mosca.match(/(^|\/)\./)
  });

  function handleGetResource(subject, topic, req, res) {
    if (req.method !== 'GET') {
      return false;
    }

    authorizeGet(subject, topic, function(err, authorized) {
      if (err) {
        handleAuthError(err, res);
        return;
      }

      if (!authorized) {
        handleNotAuthorized(res);
        return;
      }

      that._subscribe(topic, req, res);
      // persistence.lookupRetained(topic, function(err, packets) {
      //   if (packets.length === 0) {
      //     res.statusCode = 404;
      //     res.end('Not found');
      //   } else {
      //     res.end(packets[0].payload);
      //   }
      // });
    });

    return true;
  }

  function handlePutResource(subject, topic, req, res) {
    if (req.method !== 'PUT' && req.method !== 'POST') {
      return false;
    }

    req.pipe(callback(function(err, payload) {
      payload = payload[0];

      if (typeof payload === "undefined") {
        payload = "";
      }

      authorizePut(subject, topic, payload, function(err, authorized) {
        if (err) {
          handleAuthError(err, res);
          return;
        }

        if (!authorized) {
          handleNotAuthorized(res);
          return;
        }

        const packet = { topic: topic, payload: payload, retain: true };
        persistence.storeRetained(packet, function() {
          console.log('******** PUT packet');
          ponte.broker.publish(topic, payload, {}, function() {
            res.setHeader('Location', '/r/' + topic);
            res.statusCode = 204;
            res.end();
            ponte.emit('updated', topic, new Buffer(payload));
          });
        });

      });
    }));

    return true;
  }

  function handleNotFound(res) {
    res.writeHeader(404);
    res.end("Not Found");
  }

  return corsify({
    endOptions: true
  }, function httpServer(req, res) {
    logger.info({ req: req });

    res.on('finish', function() {
      logger.info({ res: res });
    });

    // Only authenticate requests to the resources
    const match = req.url.match(resourcesRegexp);
    if (match) {
      const topic = match[1];

      authenticate(req, function(err, authenticated, subject) {
        if (err) {
          handleAuthError(err, res);
          return;
        }

        if (!authenticated) {
          handleNotAuthenticated(res);
          return;
        }

        const handled =
          handleGetResource(subject, topic, req, res) ||
          handlePutResource(subject, topic, req, res);

        if (!handled) {
          handleNotFound(res);
        }
      });
    } else {
      // Public libraries do not require authentication
      if (opts.serveLibraries) {
        handlePontePublic(req, res, function() {
          handleMoscaPublic(req, res);
        });
      } else {
        handleNotFound(res);
      }
    }
  });
};

HTTP.prototype._subscribe = function(topic, req, res) {
  const broker = this._ponte.broker;
  const subscriptions = this._subsctiptions;

  this._logger.info({topic: topic}, 'subscribe');

  subscriptions[req] = new Subscription(broker, topic, (topic, payload) => {
    unsubscribe();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({topic: topic, payload: payload}));
  });

  req.on('close', unsubscribe);

  function unsubscribe() {
    if (req in subscriptions) {
      subscriptions[req].unsubscribe();
      delete subscriptions[req];
    }
  }
};

HTTP.prototype._unsubscribeAll = function() {
  return Promise.all(Promise.map(Object.keys(this._subsctiptions), (req) => {
    const sub = this._subsctiptions[req];
    delete this._subsctiptions[req];
    return sub.unsubscribe();
  }));
};


/**
 * The function that will be used to authenticate requests.
 * This default implementation authenticates everybody.
 * The returned subject is just a new Object.
 *
 * @param {Object} req The request object
 * @param {Function} cb The callback function. Has the following structure: cb(err, authenticated, subject)
 */
HTTP.prototype.authenticate = function(req, cb) {
  cb(null, true, {});
};

/**
 * The function that will be used to authorize subjects to GET messages from topics.
 * This default implementation authorizes everybody.
 *
 * @param {Object} subject The subject returned by the authenticate function
 * @param {string} topic The topic
 * @param {Function} cb The callback function. Has the following structure: cb(err, authorized)
 */
HTTP.prototype.authorizeGet = function(subject, topic, cb) {
  cb(null, true);
};

/**
 * The function that will be used to authorize subjects to PUT messages to topics.
 * This default implementation authorizes everybody.
 *
 * @param {Object} subject The subject returned by the authenticate function
 * @param {string} topic The topic
 * @param {string} payload The payload
 * @param {Function} cb The callback function. Has the following structure: cb(err, authorized)
 */
HTTP.prototype.authorizePut = function(subject, topic, payload, cb) {
  cb(null, true);
};

module.exports = HTTP;
