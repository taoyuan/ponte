"use strict";

/**
 *
 * @param broker
 * @param topic
 * @param cb
 * @returns {Subscription}
 * @constructor
 */
function Subscription(broker, topic, cb) {
  if (!(this instanceof Subscription)) {
    return new Subscription(broker, topic, cb);
  }

  this.broker = broker;
  this.topic = topic;
  this.cb = cb;
  this.broker.subscribe(this.topic, this.cb);
}

Subscription.prototype.unsubscribe = function () {
  return new Promise((resolve, reject) => {
    this.broker.unsubscribe(this.topic, this.cb, err => {
      if (err) return reject(err);
      resolve();
    });
  });
};

module.exports = Subscription;
