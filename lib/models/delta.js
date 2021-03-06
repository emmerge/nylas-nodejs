(function() {
  var Delta, DeltaStream, EventEmitter, JSONStream, Promise, STREAMING_TIMEOUT_MS, backoff, querystring, request,
    extend = function(child, parent) { for (var key in parent) { if (hasProp.call(parent, key)) child[key] = parent[key]; } function ctor() { this.constructor = child; } ctor.prototype = parent.prototype; child.prototype = new ctor(); child.__super__ = parent.prototype; return child; },
    hasProp = {}.hasOwnProperty;

  backoff = require('backoff');

  EventEmitter = require('events').EventEmitter;

  JSONStream = require('JSONStream');

  Promise = require('bluebird');

  querystring = require('querystring');

  request = require('request');

  STREAMING_TIMEOUT_MS = 5000;

  module.exports = Delta = (function() {
    function Delta(connection) {
      this.connection = connection;
      if (!(this.connection instanceof require('../nylas-connection'))) {
        throw new Error("Connection object not provided");
      }
      this;
    }

    Delta.prototype.generateCursor = function(timestampMs, callback) {
      var reqOpts;
      if (callback == null) {
        callback = null;
      }
      reqOpts = {
        method: 'POST',
        path: "/delta/generate_cursor",
        body: {
          start: Math.floor(timestampMs / 1000)
        }
      };
      return this.connection.request(reqOpts).then(function(response) {
        var cursor;
        cursor = response.cursor;
        if (callback) {
          callback(null, cursor);
        }
        return Promise.resolve(cursor);
      })["catch"](function(err) {
        if (callback) {
          callback(err);
        }
        return Promise.reject(err);
      });
    };

    Delta.prototype.latestCursor = function(callback) {
      var reqOpts;
      reqOpts = {
        method: 'POST',
        path: "/delta/latest_cursor"
      };
      return this.connection.request(reqOpts).then(function(response) {
        var cursor;
        cursor = response.cursor;
        if (callback) {
          callback(null, cursor);
        }
        return Promise.resolve(cursor);
      })["catch"](function(err) {
        if (callback) {
          callback(err);
        }
        return Promise.reject(err);
      });
    };

    Delta.prototype.startStream = function(cursor, parameters) {
      if (parameters == null) {
        parameters = {};
      }
      return this._startStream(request, cursor, parameters);
    };

    Delta.prototype._startStream = function(createRequest, cursor, parameters) {
      var stream;
      if (parameters == null) {
        parameters = {};
      }
      stream = new DeltaStream(createRequest, this.connection, cursor, parameters);
      stream.open();
      return stream;
    };

    return Delta;

  })();


  /*
  A connection to the Nylas delta streaming API.
  
  Emits the following events:
  - `response` when the connection is established, with one argument, a `http.IncomingMessage`
  - `delta` for each delta received
  - `error` when an error occurs in the connection
   */

  DeltaStream = (function(superClass) {
    extend(DeltaStream, superClass);

    DeltaStream.MAX_RESTART_RETRIES = 5;

    function DeltaStream(createRequest1, connection, cursor1, parameters1) {
      this.createRequest = createRequest1;
      this.connection = connection;
      this.cursor = cursor1;
      this.parameters = parameters1 != null ? parameters1 : {};
      if (!(this.connection instanceof require('../nylas-connection'))) {
        throw new Error("Connection object not provided");
      }
      this.restartBackoff = backoff.exponential({
        randomisationFactor: 0.5,
        initialDelay: 250,
        maxDelay: 30000,
        factor: 4
      });
      this.restartBackoff.failAfter(DeltaStream.MAX_RESTART_RETRIES);
      this.restartBackoff.on('backoff', this._restartConnection.bind(this)).on('fail', (function(_this) {
        return function() {
          return _this.emit('error', "Nylas DeltaStream failed to reconnect after " + DeltaStream.MAX_RESTART_RETRIES + " retries.");
        };
      })(this));
      return this;
    }

    DeltaStream.prototype.close = function() {
      clearTimeout(this.timeoutId);
      delete this.timeoutId;
      this.restartBackoff.reset();
      if (this.request) {
        this.request.abort();
      }
      return delete this.request;
    };

    DeltaStream.prototype.open = function() {
      var key, path, queryObj, queryStr, ref, reqOpts, val;
      this.close();
      path = "/delta/streaming";
      queryObj = {
        cursor: this.cursor
      };
      ref = this.parameters;
      for (key in ref) {
        if (!hasProp.call(ref, key)) continue;
        val = ref[key];
        queryObj[key] = val;
      }
      if (queryObj.exclude_types) {
        queryObj.exclude_types = queryObj.exclude_types.join(',');
      }
      if (queryObj.include_types) {
        queryObj.include_types = queryObj.include_types.join(',');
      }
      queryStr = querystring.stringify(queryObj);
      path += '?' + queryStr;
      reqOpts = this.connection.requestOptions({
        method: 'GET',
        path: path
      });
      return this.request = this.createRequest(reqOpts).on('response', (function(_this) {
        return function(response) {
          if (response.statusCode !== 200) {
            response.on('data', function(data) {
              var e, err;
              err = data;
              try {
                err = JSON.parse(err);
              } catch (_error) {
                e = _error;
              }
              return _this._onError(err);
            });
            return;
          }
          _this.emit('response', response);
          _this._onDataReceived();
          return response.on('data', _this._onDataReceived.bind(_this)).pipe(JSONStream.parse()).on('data', function(obj) {
            if (obj.cursor) {
              _this.cursor = obj.cursor;
            }
            return _this._onDeltaReceived(obj);
          });
        };
      })(this)).on('error', this._onError.bind(this));
    };

    DeltaStream.prototype._onDeltaReceived = function(obj) {
      return this.emit('delta', obj);
    };

    DeltaStream.prototype._onDataReceived = function(data) {
      clearTimeout(this.timeoutId);
      this.restartBackoff.reset();
      return this.timeoutId = setTimeout(this.restartBackoff.backoff.bind(this.restartBackoff), STREAMING_TIMEOUT_MS);
    };

    DeltaStream.prototype._onError = function(err) {
      this.restartBackoff.reset();
      return this.emit('error', err);
    };

    DeltaStream.prototype._restartConnection = function(n) {
      this.close();
      return this.open();
    };

    return DeltaStream;

  })(EventEmitter);

  Delta.DeltaStream = DeltaStream;

}).call(this);
