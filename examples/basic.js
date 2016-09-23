var ponte = require("../lib/ponte");
var PrettyStream = require('bunyan-prettystream');

var prettyStdOut = new PrettyStream();
prettyStdOut.pipe(process.stdout);
var opts = {
  logger: {
    level: 'info',
    streams: [{
      level: 'debug',
      type: 'raw',
      stream: prettyStdOut
    }]
  },
  http: {
    port: 3000 // tcp
  },
  mqtt: {
    port: 10883, // tcp
    http: {
      port: 20883, // websocket
      bundle: true,
      static: './'
    }
  },
  coap: {
    port: 3000 // udp
  },
  webhooker: {
    formio: {
      api: 'http://localhost:3001',
      user: 'admin@test.com',
      password: 'admin'
    },
    callback: {
      port: 3003,
      user: 'test',
      password: 'password123'
    }
  },
  persistence: {
    type: 'level',
    path: './db'
  }
};
var server = ponte(opts);

server.on("updated", function(resource, buffer) {
  console.log("Resource Updated", resource, buffer.toString());
});
