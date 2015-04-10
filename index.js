/* SWM module for Express (Node.js) */

var crypto = require('crypto');

var fs   = require('fs');
var path = require('path');

var express = require('express');

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

function isArray(value) {
  return Object.prototype.toString.call(value) === '[object Array]';
}

function hash(message, algorithm) {
  return crypto.Hash(algorithm).update(message).digest();
}

function md5(message) {
  return hash(message, 'md5');
}

function sha256(message) {
  return hash(message, 'sha256');
}

function hex(buffer) {
  return buffer.toString('hex');
}

function base64(buffer) {
  return buffer.toString('base64');
}

function fileHash(filename, algorithm, callback) {
  fs.readFile(filename, function (error, data) {
    callback(error, error ? null : hex(hash(data, algorithm)));
  });
}

var _class = function (config) {
  this.config = config;
};

_class.prototype.router = function () {
  var self = this;

  var router = express.Router();

  var cache = {};

  function contentHash(key, callback) {
    var obj = cache[key];

    if (obj && +new Date() <= obj.timestamp + 60000) {
      callback(obj.error, obj.digest);
      return;
    }

    var filename = path.join(self.config.root, key);

    fileHash(filename, 'md5', function (error, digest) {
      cache[key] = { timestamp: +new Date(), error: error, digest: digest };

      callback(error, digest);
    });
  }

  function selectPaymentOption(networks) {
    var paymentOption = null;

    var index = -1;

    if (isArray(self.config.payment)) {
      if (networks) {
        while (!paymentOption && ++index < networks.length) {
          self.config.payment.some(function (option) {
            if (networks[index] === option.network) {
              return paymentOption = option;
            }
          });
        }
      } else {
        paymentOption = self.config.payment[0] || null;
      }
    } else if (isObject(self.config.payment)) {
      if (networks) {
        while (!paymentOption && ++index < networks.length) {
          if (networks[index] === self.config.payment.network) {
            paymentOption = self.config.payment;
            break;
          }
        }
      } else {
        paymentOption = self.config.payment;
      }
    }

    return paymentOption;
  }

  function generateTicket(digest, key, networks) {
    var paymentOption = selectPaymentOption(networks);

    var obj = {
      'date': new Date().toISOString(),
      'content': {
        'digest': digest,
        'digestAlgorithm': 'md5',
        'uri': self.config.content.baseUri + '/' + digest + '/' + key,
      },
      'validity': self.config.validity,
    };

    if (paymentOption) {
      obj['payment'] = {
        'network': paymentOption.network,
        'address': paymentOption.address,
        'amount':  paymentOption.amount,
      };
    }

    return obj;
  }

  function saveTicket(envelope, ticketObject, callback) {
    fs.writeFile(path.join(self.config.working, 'tickets', envelope.id),
        JSON.stringify(envelope), function (error) {
      if (error) {
        callback(error);
      } else {
        if (!self._ticketCache) {
          self._ticketCache = {};
        }
        self._ticketCache[envelope.id] = ticketObject;
        callback();
      }
    });
  }

  function linkContent(key, id, callback) {
    fs.mkdir(path.join(self.config.working, 'content', id), 0755, function () {
      fs.link(path.join(self.config.root, key),
          path.join(self.config.working, 'content', id, key),
          function (error) {
        if (!error || error.code === 'EEXIST') {
          callback();
        } else {
          callback(error);
        }
      });
    });
  }

  function sign(message, network) {
    if (network) {
      var module = self._paymentsModulesByNetwork[network];
      if (module) {
        return module.sign(message);
      }
    }
    return null;
  }

  function prepareTicket(key, networks, callback) {
    contentHash(key, function (error, digest) {
      if (error) {
        callback();
        return;
      }

      var ticketObject = generateTicket(digest, key, networks);

      var ticket = JSON.stringify(ticketObject);
      var signature = sign(ticket,
          ticketObject.payment && ticketObject.payment.network);

      var object = new Buffer(ticket);

      var envelope = {
        object: base64(object)
      };

      if (signature) {
        envelope.signature = base64(signature);
      }

      envelope.id = hex(sha256(Buffer.concat([ object,
                signature || new Buffer(0) ])));
      envelope.ttl = self.config.ttl;

      linkContent(key, envelope.id, function (error) {
        if (error) {
          callback(error);
        } else {
          saveTicket(envelope, ticketObject, function (error) {
            if (error) {
              callback(error);
            } else {
              callback(null, envelope);
            }
          });
        }
      });
    });
  }

  router.use(function (req, res, next) {
    var networks = req.get('X-SWM-Accept-Network');

    if (networks) {
      networks = networks.split(',').map(function (x) {
        return x.replace(/^ *| *$/g, '');
      });
    }

    prepareTicket(req.path.slice(1), networks, function (error, envelope) {
      if (!envelope) {
        next(error);
        return;
      }

      res.status(402);

      res.set('X-SWM', '0.1');

      res.set('X-SWM-Object', envelope.object);

      if (envelope.signature) {
        res.set('X-SWM-Signature', envelope.signature);
      }

      res.set('X-SWM-ID', envelope.id);
      res.set('X-SWM-TTL', envelope.ttl);

      res.end();
    });
  });

  return router;
};

_class.prototype.initialize = function (paymentsModules) {
  var self = this;

  self._paymentsModules = paymentsModules || [];

  self._paymentsModulesByNetwork = {};
  self._paymentsModules.forEach(function (module) {
    self._paymentsModulesByNetwork[module.network()] = module;
  });
};

_class.prototype.run = function () {
  var self = this;

  function ticket(id) {
    if (!self._ticketCache) {
      self._ticketCache = {};
    }

    if (self._ticketCache.hasOwnProperty(id)) {
      return self._ticketCache[id];
    }

    var data = null;

    try {
      data = fs.readFileSync(path.join(self.config.working, 'tickets', id));
    } catch (error) {
      return self._ticketCache[id] = null;
    }

    return self._ticketCache[id] = JSON.parse(
        new Buffer(JSON.parse(data).object, 'base64')
    );
  }

  function publish(id, callback) {
    if (!callback) {
      callback = function () {};
    }

    var ticketObject = ticket(id);

    fs.rename(path.join(self.config.working, 'content', id),
          path.join(self.config.published, ticketObject.content.digest),
          function (error) {
      if (error && error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') {
        callback(error);
      } else {
        if (self._ticketCache) {
          self._ticketCache[id] = null;
        }

        var filename = path.join(self.config.working, 'tickets', id);

        fs.rename(filename, filename + '.done', callback);
      }
    });
  }

  function paymentValid(paymentInfo) {
    if (paymentInfo.tags.length === 0) {
      return false;
    }

    var ticketObject = ticket(paymentInfo.tags[0]);

    if (!ticketObject) {
      return false;
    }

    if (paymentInfo.value < ticketObject.payment.amount) {
      return false;
    }

    return true;
  }

  function handlePayment(paymentInfo) {
    if (paymentValid(paymentInfo)) {
      publish(paymentInfo.tags[0]);
    }
  }

  function check() {
    self._paymentsModules.forEach(function (module) {
      module.check(function (payments) {
        if (payments) {
          payments.forEach(function (paymentInfo) {
            handlePayment(paymentInfo);
          });
        }

        setTimeout(check, 1000 * Math.max(60, self.config.ttl | 0));
      });
    });
  }

  self._paymentsModules.forEach(function (module) {
    module.on('payment', function (paymentInfo) {
      handlePayment(paymentInfo);
    });
  });

  check();
};

module.exports = function (config) {
  return new _class(config);
};

module.exports.Bitcoin = require('./bitcoin');
module.exports.Ripple  = require('./ripple');

// vim: et ts=2 sw=2
