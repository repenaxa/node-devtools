#!/usr/bin/env node
//
// Copyright (c) 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

var net = require('net');
var optimist = require('optimist');
var readline = require('readline');
var url = require('url');
var util = require('util');
var ws = require('ws');
var injectedScript = require('./devtools/InjectedScriptSource.js');

var EventEmitter = require('events').EventEmitter;
var Promise = require('es6-promise').Promise;
var DebugTarget = require('./debug_target.js').DebugTarget;

var argv = optimist
    .usage([
      'Usage: $0 --port [num]',
      '',
      'Acts as a relay between the Chrome DevTools and V8 debug agents (like',
      'node.js --debug). Supports multiple sessions at the same time; you only',
      'need one running.',
      '',
      'Example:',
      '  $ $0 --port=9800 &',
      '  $ node --debug=5858 -e "setInterval(function(){console.log(\'ping\');},1000)"',
      'Then open, open Chrome and visit:',
      '  chrome-devtools://devtools/bundled/devtools.html?ws=localhost:9800/localhost:5858',
      ''
    ].join('\n'))
    .options('p', {
      describe: 'Port the adapter will listen on for DevTools connections.',
      alias: 'port',
      default: 9800
    })
    .options('l', {
      describe: 'Log network traffic between the DevTools and the target.',
      alias: 'log-network',
      default: false
    })
    .argv;
if (argv.help) {
  optimist.showHelp();
  return;
}

console.log('node-devtools adapter listening on localhost:' + argv['port']);
console.log('Open the Chrome DevTools and connect to your debug target:');
console.log('');
console.log('  chrome-devtools://devtools/bundled/devtools.html?ws=localhost:' + argv['port'] + '/localhost:<port>');
console.log('');

// Setup socket server to listen for DevTools connections.
var devToolsServer = new ws.Server({
  port: argv['port']
});
devToolsServer.on('connection', function(devToolsSocket) {
  // Pause the socket so that we don't lose any messages.
  devToolsSocket.pause();

  // url should be something like /localhost:5222
  var parsedUrl = url.parse(devToolsSocket.upgradeReq.url);
  var endpoint = parsedUrl.path.substring(1);
  var host = endpoint.substring(0, endpoint.indexOf(':'));
  var port = Number(endpoint.substring(host.length + 1));

  // We open the target before we start handling messages, so that we can ensure
  // both can talk to each other right away.
  console.log('DevTools requesting relay to target at ' + endpoint + '...');
  var targetSocket = net.connect({
    host: host,
    port: port
  });
  targetSocket.on('connect', function() {
    // Create and stash connection.
    var debugTarget = new DebugTarget(targetSocket, endpoint, argv);
    var relay = new Relay(devToolsSocket, debugTarget);
    openRelays.push(relay);

    debugTarget.on('connect', function(targetInfo) {
      console.log('Connected to \'' + this.endpoint_ + '\':');
      console.log('  Host: ' + targetInfo.host);
      console.log('    V8: ' + targetInfo.v8);
      console.log('');

      // Inject devtools injected script into backend.
      debugTarget.sendCommand('evaluate', {
        'expression': '__is = (' +
            injectedScript.source() + ')(null, this, 1)',
        'global': true
      });

      // Resume the socket so that messages come through.
      devToolsSocket.resume();
    });
    relay.on('error', function(err) {
      console.error('Relay error:', err);
    });
    relay.on('close', function() {
      console.log('Relay to ' + endpoint + ' closed.');
      console.log('');
    });
  });
  targetSocket.on('error', function(err) {
    console.error('Unable to connect to target at ' + endpoint, err);
    console.log('');
    devToolsSocket.close();
  });
});

/**
 * All open relays.
 * @type {!Array.<!Relay>}
 */
var openRelays = [];

/**
 * A relay between a DevTools session and a target debug agent.
 * @param {!ws.WebSocket} devToolsSocket DevTools web socket.
 * @param {!DebugTarget} debugTarget
 * @constructor
 */
var Relay = function(devToolsSocket, debugTarget) {
  /**
   * WebSocket connection to the DevTools instance.
   * @type {!ws.WebSocket}
   * @private
   */
  this.devTools_ = devToolsSocket;

  /**
   * Debug target instance.
   * @type {!DebugTarget}
   * @private
   */
  this.debugTarget_ = debugTarget;

  /**
   * Whether the connection has been closed.
   * @type {boolean}
   * @private
   */
  this.closed_ = false;

  /**
   * Dispatch table that matches methods from the DevTools.
   * For example, 'Debugger.enable' -> fn that handles the message.
   * Each function receives the params, if present, and the resolve/reject
   * functions for a promise that responds to the message.
   * @type {!Object.<function(Object, Function, Function)>}
   * @private
   */
  this.devToolsDispatch_ = this.buildDevToolsDispatch_();

  /**
   * Dispatch table that matches events from the target.
   * For example, 'break' -> fn that handles the message.
   * Each function receives the body of the event, if present.
   * @type {!Object.<function(Object)>}
   * @private
   */
  this.targetDispatch_ = this.buildTargetDispatch_();

  // DevTools socket.
  this.devTools_.on('message', (function(data, flags) {
    this.processDevToolsMessage_(data);
  }).bind(this));
  this.devTools_.on('error', (function(err) {
    console.log('DevTools::error', err);
    this.emit('error', err);
  }).bind(this));
  this.devTools_.on('close', (function() {
    this.close();
  }).bind(this));

  this.debugTarget_.on('error', (function(err) {
    console.log('Target::error', err);
    this.emit('error', err);
    this.close();
  }).bind(this));
  this.debugTarget_.on('close', (function() {
    this.close();
  }).bind(this));
  this.debugTarget_.on('event', (function(event, body) {
    var dispatchMethod = this.targetDispatch_[event];
    if (!dispatchMethod) {
      console.error('Unknown target event: ' + event);
      return;
    }
    dispatchMethod(body);
  }).bind(this));
};
util.inherits(Relay, EventEmitter);

/**
 * Processes an incoming DevTools message.
 * @param {string} data Incoming data.
 * @private
 */
Relay.prototype.processDevToolsMessage_ = function(data) {
  if (argv['log-network']) {
    console.log('[DT->]', data);
  }

  var packet = JSON.parse(data);
  var method = packet['method'];
  if (method) {
    var reqId = packet['id'];
    var dispatchMethod = this.devToolsDispatch_[method];
    if (!dispatchMethod) {
      console.error('Unhandled DevTools message: ' + method);
      // TODO(pfeldman): proper error response?
      var responseData = JSON.stringify({
        'id': reqId,
        'error': 'Unknown?'
      });
      this.devTools_.send(responseData);
      if (argv['log-network']) {
        console.log('[->DT]', responseData);
      }
      return;
    }
    var params = packet['params'] || {};
    var promise = new Promise(function(resolve, reject) {
      dispatchMethod(params, resolve, reject);
    });
    promise.then((function(response) {
      var responseData = JSON.stringify({
        'id': reqId,
        'result': response
      });
      this.devTools_.send(responseData);
      if (argv['log-network']) {
        console.log('[->DT]', responseData);
      }
    }).bind(this), (function(err) {
      // TODO(pfeldman): proper error response?
      var responseData = JSON.stringify({
        'id': reqId,
        'error': { 'message': err.toString(), 'code': -32001 }
      });
      this.devTools_.send(responseData);
      if (argv['log-network']) {
        console.log('[->DT]', responseData);
      }
    }).bind(this));
  } else {
    // TODO(pfeldman): anything that isn't a method?
    console.error('Unknown DevTools message: ' + packet);
  }
};

/**
 * Sends a command to the DevTools.
 * @param {string} method Method, such as 'Debugger.paused'.
 * @param {Object} params Parameters, if any.
 * @private
 */
Relay.prototype.fireDevToolsEvent_ = function(method, params) {
  var data = JSON.stringify({
    'method': method,
    'params': params
  });
  this.devTools_.send(data);

  if (argv['log-network']) {
    console.log('[->DT]', data);
  }
};

/**
 * Closes the connection to the DevTools and target.
 */
Relay.prototype.close = function() {
  if (this.closed_) {
    return;
  }
  this.closed_ = true;

  // Close target.
  // This will allow the target to resume running.
  this.debugTarget_.close();

  // Close DevTools connection.
  this.devTools_.close();

  // Remove from open connection list.
  openRelays.splice(openRelays.indexOf(this), 1);

  this.emit('close');
};

/**
 * Builds the dispatch table that maps incoming DevTools commands to actions.
 * @return {!Object.<function(Object, Function, Function)>} Lookup table.
 * @private
 */
Relay.prototype.buildDevToolsDispatch_ = function() {
  var lookup = {};

  //----------------------------------------------------------------------------
  // Console.*
  //----------------------------------------------------------------------------

  lookup['Console.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': true });
  }).bind(this);
  lookup['Console.clearMessages'] = (function(params, resolve, reject) {
    resolve({});
  }).bind(this);

  //----------------------------------------------------------------------------
  // CSS.*
  //----------------------------------------------------------------------------

  lookup['CSS.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // Database.*
  //----------------------------------------------------------------------------

  lookup['Database.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // DebugTarget.*
  //----------------------------------------------------------------------------

  lookup['Debugger.enable'] = (function(params, resolve, reject) {
    this.debugTarget_.sendCommand('scripts', {
      'includeSource': false,
    }).then(function(response) {
      for (var i = 0; i < response.length; ++i) {
        this.fireDevToolsEvent_('Debugger.scriptParsed', {
          'scriptId': String(response[i]['id']),
          'url': response[i]['name'] || "",
          'startLine': 0,
          'startColumn': 0,
          'endLine': response[i]['lineCount'],
          'endColumn': 0
        });
      }
      resolve({ 'result': true });
    }.bind(this), reject);
  }).bind(this);


  lookup['Debugger.getScriptSource'] = (function(params, resolve, reject) {
    this.debugTarget_.sendCommand('scripts', {
      'ids': [params['scriptId'] | 0],
      'includeSource': true,
    }).then(function(response) {
      if (response.length) {
        resolve({ 'scriptSource': response[0]['source'] });
      } else {
        resolve({ 'result': true });
      }
    }.bind(this), reject);
  }).bind(this);

  lookup['Debugger.setOverlayMessage'] = (function(params, resolve, reject) {
    if (params['message']) {
      console.log('DebugTarget: ' + params['message']);
    }
    resolve();
  }).bind(this);

  lookup['Debugger.setAsyncCallStackDepth'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);
  lookup['Debugger.setPauseOnExceptions'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
    var type;
    var enabled;
    switch (params['state']) {
      case 'all':
        type = 'all';
        enabled = true;
        break;
      case 'none':
        type = 'all';
        enabled = false;
        break;
      case 'uncaught':
        type = 'uncaught';
        enabled = true;
        break;
      default:
        reject(Error('Unknown setPauseOnExceptions state: ' + params['state']));
        return;
    }
    this.debugTarget_.sendCommand('setexceptionbreak', {
      'type': type,
      'enabled': enabled
    }).then(function(response) { resolve(); }, reject);
  }).bind(this);
  lookup['Debugger.setSkipAllPauses'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  lookup['Debugger.pause'] = (function(params, resolve, reject) {
    // NOTE: this eval will not respond immediately!
    // We'll need to resolve() right away and poke the DevTools to let them know
    // the (probably) succeeded.
    // TODO(pfeldman): I'm sure there's some InjectedScript thing for this.
    this.debugTarget_.sendCommand('evaluate', {
      'expression': 'debugger',
      'global': true
    });
    resolve();
    this.fireDevToolsEvent_('Debugger.paused', {
      'callFrames': [],
      'reason': 'debugCommand',
      'data': {}
    });
  }).bind(this);

  lookup['Debugger.resume'] = (function(params, resolve, reject) {
    this.fireDevToolsEvent_('Debugger.resumed', {});
    this.debugTarget_.sendCommand('continue').then(function(response) {
      resolve();
    }, reject);
  }).bind(this);

  lookup['Debugger.stepInto'] = (function(params, resolve, reject) {
    this.fireDevToolsEvent_('Debugger.resumed', {});
    this.debugTarget_.sendCommand('continue', {
      'stepaction': 'in',
      'stepcount': 1
    }).then(function(response) { resolve(); }, reject);
  }).bind(this);

  lookup['Debugger.stepOut'] = (function(params, resolve, reject) {
    this.fireDevToolsEvent_('Debugger.resumed', {});
    this.debugTarget_.sendCommand('continue', {
      'stepaction': 'out',
      'stepcount': 1
    }).then(function(response) { resolve(); }, reject);
  }).bind(this);

  lookup['Debugger.stepOver'] = (function(params, resolve, reject) {
    this.fireDevToolsEvent_('Debugger.resumed', {});
    this.debugTarget_.sendCommand('continue', {
      'stepaction': 'next',
      'stepcount': 1
    }).then(function(response) { resolve(); }, reject);
  }).bind(this);

  lookup['Debugger.getFunctionDetails'] = (function(params, resolve, reject) {
    reject('Unsupported');
  }).bind(this);

  /**
   * Mapping between DevTools and v8 breakpoint handles.
   * @type {!Object.<string, string>}
   */
  // FIXME(pfeldman): clean up on clearing global object.
  var breakpointIdToV8Id = {};

  lookup['Debugger.setBreakpointByUrl'] = (function(params, resolve, reject) {
    var breakpointId = params['url'] + ':' + params['lineNumber'] + ':' +
        (params['columnNumber'] || 0);
    this.debugTarget_.sendCommand('setbreakpoint', {
      'type': 'script',
      'target': params['url'],
      'line': params['lineNumber'],
      'column': params['columnNumber'],
      'condition': params['condition']
    }).then(function(response) {
      var v8BreakpointId = response['breakpoint'];
      breakpointIdToV8Id[breakpointId] = v8BreakpointId;
      var locations = [];
      for (var i = 0; i < response['actual_locations'].length; ++i) {
        var actualLocation = response['actual_locations'][i];
        locations.push({ 'lineNumber': actualLocation['line'],
                         'columnNumber': actualLocation['column'],
                         'scriptId': String(actualLocation['script_id']) });
      }
      resolve({ 'breakpointId' : breakpointId, 'locations': locations });
    }, reject);
  }).bind(this);

  lookup['Debugger.removeBreakpoint'] = (function(params, resolve, reject) {
    var breakpointId = params['breakpointId'];
    var v8BreakpointId = breakpointIdToV8Id[breakpointId];
    if (!v8BreakpointId) {
      reject('Unknown breakpoint id.');
      return;
    }
    this.debugTarget_.sendCommand('clearbreakpoint', {
      'breakpoint': v8BreakpointId
    }).then(function(response) {
      resolve();
    }, reject);
  }).bind(this);

  lookup['Debugger.evaluateOnCallFrame'] = (function(params, resolve, reject) {
    // First evaluate the expression as is.
    this.debugTarget_.sendCommand('evaluate', {
      'frame': params['callFrameId'],
      'expression': params['expression']
    }).then(function(response) {
      // Then wrap the value using injected script, drop v8 handle.
      var handle = response['handle'];
      var og = params['objectGroup'] || "";
      var rbv = params['returnByValue'] || false;
      var gp = params['generatePreview'] || false;
      var expression = '__is._wrapObject(o, "' + og + '", ' + rbv + ', ' +
          gp + ')';

      // Store result in property in order to avoid trimming.
      var wrapped = 'var result = {};' +
          'result[JSON.stringify(' + expression + ')] = 1;' +
          'result;';
      this.debugTarget_.sendCommand('evaluate', {
        'expression': wrapped,
        'additional_context': [ { 'name': 'o', 'handle': handle } ]
      }).then(function(response) {
        resolve({ result: JSON.parse(response['properties'][0]['name']) })
      }.bind(this), reject);
    }.bind(this), function(error) {
      // Rejected evaluation -> throw message.
      resolve({ 'wasThrows': true,
                'result': { 'type': 'string', 'value' : error}});
    });
  }).bind(this);

  //----------------------------------------------------------------------------
  // DOMStorage.*
  //----------------------------------------------------------------------------

  lookup['DOMStorage.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // HeapProfiler.*
  //----------------------------------------------------------------------------

  lookup['HeapProfiler.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // Inspector.*
  //----------------------------------------------------------------------------

  lookup['Inspector.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // Network.*
  //----------------------------------------------------------------------------

  lookup['Network.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  lookup['Network.setCacheDisabled'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // Page.*
  //----------------------------------------------------------------------------

  lookup['Page.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  lookup['Page.canScreencast'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  lookup['Page.getResourceTree'] = (function(params, resolve, reject) {
    resolve({ 'frameTree': {
        'frame': { 'id': '0', 'url': '' },
        'childFrames': [],
        'resources': [] }
    });
  }).bind(this);

  lookup['Page.setShowViewportSizeOnResize'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // Profiler.*
  //----------------------------------------------------------------------------

  lookup['Profiler.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // Runtime.*
  //----------------------------------------------------------------------------

  /**
   * Calls method on the injected script.
   * @param {string} method Method name on the InjectedScript.
   * @param {!Array} args Array of arguments for the call.
   * @param {function(!Object)} resolve.
   * @param {!Function} reject.
   */
  function dispatchOnInjectedScript(method, args, resolve, reject) {
    var argsstr = JSON.stringify(args);
    var expression = '__is["' + method + '"].apply(__is, ' + argsstr + ')';
    // V8 will trim string values in protocol messages. All but the property
    // names! Abuse it.
    var wrapped = 'var result = {};' +
        'result[JSON.stringify(' + expression + ')] = 1;' +
        'result;';
    this.debugTarget_.sendCommand('evaluate', {
      'expression': wrapped,
      'global': true
    }).then(function(response) {
      resolve(JSON.parse(response['properties'][0]['name']))
    }, reject);
  }

  lookup['Runtime.enable'] = (function(params, resolve, reject) {
    this.fireDevToolsEvent_('Runtime.executionContextCreated', {
      'context': {
        'id': 0,
        'isPageContext': true,
        'origin': 'default',
        'name': 'default',
        'frameId': 'frameId'
      }
    });
    resolve();
  }).bind(this);

  lookup['Runtime.evaluate'] = (function(params, resolve, reject) {
    dispatchOnInjectedScript.call(this,
        'evaluate',
        [ params['expression'],
          params['objectGroup'],
          params['injectCommandLineAPI'],
          params['returnByValue'],
          params['generatePreview'] ],
        resolve,  // We are lucky to return what is given (for now).
        reject);
  }).bind(this);

  lookup['Runtime.callFunctionOn'] = (function(params, resolve, reject) {
    dispatchOnInjectedScript.call(this,
        'callFunctionOn',
        [ params['objectId'],
          params['functionDeclaration'],
          params['arguments'],
          params['doNotPauseOnExceptionsAndMuteConsole'],
          params['returnByValue'],
          params['generatePreview'] ],
        resolve,  // We are lucky to return what is given (for now).
        reject);
  }).bind(this);

  lookup['Runtime.getProperties'] = (function(params, resolve, reject) {
    dispatchOnInjectedScript.call(this,
        'getProperties',
        [ params['objectId'],
          params['ownProperties'],
          params['accessorPropertiesOnly'] ],
        function(result) { resolve({result : result}); },
        reject);
  }).bind(this);

  lookup['Runtime.releaseObject'] = (function(params, resolve, reject) {
    dispatchOnInjectedScript.call(this,
        'releaseObject', [], resolve, reject);
  }).bind(this);

  lookup['Runtime.releaseObjectGroup'] = (function(params, resolve, reject) {
    dispatchOnInjectedScript.call(this,
        'releaseObjectGroup', [], resolve, reject);
  }).bind(this);

  //----------------------------------------------------------------------------
  // Timeline.*
  //----------------------------------------------------------------------------

  lookup['Timeline.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // Worker.*
  //----------------------------------------------------------------------------

  lookup['Worker.canInspectWorkers'] = (function(params, resolve, reject) {
    resolve({ 'result': true });
  }).bind(this);

  lookup['Worker.enable'] = (function(params, resolve, reject) {
    resolve();
  }).bind(this);

  return lookup;
};

/**
 * Builds the dispatch table that maps incoming target events to actions.
 * @return {!Object.<function(Object)>} Lookup table.
 * @private
 */
Relay.prototype.buildTargetDispatch_ = function() {
  var lookup = {};

  lookup['break'] = (function(body) {
    this.debugTarget_.sendCommand('backtrace', {
      inlineRefs: true,
    }).then(function(response) {
      var v8frames = response['frames'];
      var frames = [];

      for (var i = 0; i < v8frames.length; ++i) {
        var v8frame = v8frames[i];
        console.error(JSON.stringify(v8frame));
        var location = {};
        location['scriptId'] = String(v8frame['func']['scriptId']);
        location['lineNumber'] = v8frame['line'];
        location['columnNumber'] = v8frame['column'];

        var frame = {};
        frame['callFrameId'] = String(v8frame['index']);
        frame['functionName'] = v8frame['func']['name'];
        frame['location'] = location;
        frame['scopeChain'] = [];
        frames.push(frame);
      }
      this.fireDevToolsEvent_('Debugger.paused', {
        'callFrames': frames,
        'reason': 'debugCommand',  // FIXME(pfeldman): provide reason
        'data': {}
      });
    }.bind(this));

    // TODO(pfeldman): pull out args and switch - 'breakpoints' has a list
    //     of breakpoints that could be used.
    this.fireDevToolsEvent_('Debugger.paused', {
      'callFrames': [],
      'reason': 'debugCommand',
      'data': {}
    });
  }).bind(this);

  lookup['exception'] = (function(body) {
    // TODO(pfeldman): what is 'data'? exception info? uncaught flag?
    console.log('TODO: incoming target exception event');
    this.fireDevToolsEvent_('Debugger.paused', {
      'callFrames': [],
      'reason': 'exception',
      'data': {}
    });
  }).bind(this);

  lookup['afterCompile'] = (function(body) {
    var script = body['script'];
    this.fireDevToolsEvent_('Debugger.scriptParsed', {
      'scriptId': String(script['id']),
      'url': script['name'] || "",
      'startLine': 0,
      'startColumn': 0,
      'endLine': script['lineCount'],
      'endColumn': 0
    });
  }).bind(this);

  return lookup;
};
