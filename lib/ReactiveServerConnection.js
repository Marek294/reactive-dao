const EventEmitter = require('./EventEmitter.js')
const utils = require('./utils.js')

class ReactiveServerConnection extends EventEmitter {

  constructor(server, id, connection, daoFactory, settings) {
    super()
    this.server = server
    this.id = id
    this.connection = connection
    this.connected = true
    this.settings = settings || {}
    this.daoFactory = daoFactory
    this.dao = null
    this.daoPromise = null
    this.daoGenerationQueue = []
    this.observers = new Map()
    this.observables = new Map()
    this.context = null
    this.connectionMonitor = this.settings.connectionMonitorFactory ? settings.connectionMonitorFactory(this) : null

    connection.on('data', data => {
      var message = JSON.parse(data)
      this.handleMessage(message)
      this.connected = false
    })

    connection.on('close', () => {
      for(let [key, observable] of this.observables.entries()) {
        let observer = this.observers.get(key)
        observable.unobserve(observer)
        this.observables.delete(key)
        this.observers.delete(key)
      }
      if(this.dao) this.dao.dispose()
      this.server.handleConnectionClose(this)
    })
  }

  send(message) {
    this.connection.write(JSON.stringify(message))
  }

  handleServerError(message, error) {
    if(this.settings.logErrors) {
      console.group('reactive-dao')
      console.group('server error')
      console.error('MESSAGE', message)
      console.error('ERROR', error.serverError ? error.serverError : error)
      console.groupEnd()
      console.groupEnd()
    }
    this.emit('serverError', error, message)
  }

  handleClientError(message, error) {
    if(this.settings.logErrors) {
      console.group('reactive-dao')
      console.group('client error')
      console.error('MESSAGE', message)
      console.error('ERROR', error)
      console.groupEnd()
      console.groupEnd()
    }
    this.emit('clientError', error, message)
    this.connection.close()
  }

  handleRequest(message) {
    var path = message.method
    try {
      this.dao.request(path, ...message.args).then(
        result => this.connection.write(JSON.stringify({
          type: "response",
          responseId: message.requestId,
          response: result
        })),
        error => {
          this.handleServerError(message, error)
          this.connection.write(JSON.stringify({
            type: "error",
            responseId: message.requestId,
            error: error.message,
            code: error.code
          }))
        }
      );
    } catch (error) {
      this.handleServerError(message, error)
      this.connection.write(JSON.stringify({
        type: "error",
        responseId: message.requestId,
        error: error.message,
        code: error.code
      }))
    }
  }

  handleObserve(message) {
    var path = message.what
    var spath = JSON.stringify(path)
    var observer = this.observers.get(spath)
    if(observer) {
      this.handleClientError(message, "Second observation of the same observable")
      return;
    }
    try {
      var observable = this.dao.observable(path)
      var observer = (signal, ...args) => {
        this.connection.write(JSON.stringify({
          type: "notify",
          what: message.what,
          signal: signal,
          args: args
        }))
      }
      observable.observe(observer)
      this.observables.set(spath, observable)
      this.observers.set(spath, observer)
    } catch (error) {
      console.error("Observe error", error)
      this.connection.write(JSON.stringify({
        type: "notify",
        what: message.what,
        signal: "error",
        args: [error.message]
      }))
    }
  }

  handleUnobserve(message) {
    var path = message.what
    var spath = JSON.stringify(path)
    var observer = this.observers.get(spath)
    if(!observer) return;
    var observable = this.observables.get(spath)
    if(!observable) return;
    observable.unobserve(observer)
    this.observables.delete(spath)
    this.observers.delete(spath)
  }

  handleGet(message) {
    var path = message.what
    this.dao.get(path).then(
      result => this.connection.write(JSON.stringify({
        type:"response",
        responseId: message.requestId,
        response: result
      })),
      error => this.connection.write(JSON.stringify({
        type:"error",
        responseId: message.requestId,
        error: error.message,
        code: error.code
      }))
    )
  }

  handleAuthorizedMessage(message) {
    try {
      switch (message.type) {
        case 'request':
          this.handleRequest(message)
          break;
        case 'ping':
          this.emit('ping', message)
          message.type = 'pong'
          this.send(message)
          break;
        case 'pong':
          this.emit('pong', message)
          break;
        case 'timeSync':
          let now = Date.now()
          message.serverTimestamp = now
          this.send(message)
          break;
        case 'event':
          var path = message.method
          this.dao.request(path, ...message.args)
          break;
        case 'observe' :
          this.handleObserve(message)
          break;
        case 'unobserve' :
          this.handleUnobserve(message)
          break;
        case 'get' :
          this.handleGet(message)
          return;
      }
    } catch(error) {
      this.handleProtocolError(error, message)
    }
  }

  handleProtocolError(error, message) {
    this.send({
      type: "malformedMessageError",
      error: error.message,
      message
    })
    this.closeConnection()
  }

  handleDaoFactoryError(error) {
    console.error("DAO Factory error", error)
    this.send({
      type: "authenticationError",
      error: error.message
    })
    this.closeConnection()
  }

  handleMessage(message) {
    if (!this.dao && !this.daoPromise) {
      if ((!message) || message.type != 'initializeSession') {
        this.handleClientError(message, "Got packet of type '" + message.type + "' expected type 'initializeSession'")
        return;
      }
      try {
        this.daoPromise = this.daoFactory(message.sessionId, this.connection, this)
      } catch(error) {
        return this.handleDaoFactoryError(error)
      }
      if(!this.daoPromise.then) {
        this.dao = this.daoPromise
        this.daoPromise = null
      } else {
        this.daoPromise.catch(error => this.handleDaoFactoryError(error)).then(dd => {
          this.dao = dd
          this.daoPromise = null
          for(var message of this.daoGenerationQueue) this.handleAuthorizedMessage(message)
        })
      }
    } else if(this.daoPromise && !this.dao) {
      this.daoGenerationQueue.push(message)
    } else {
      this.handleAuthorizedMessage(message)
    }
  }

  closeConnection() {
    this.connection.close()
  }

  sendPing(data = {}) {
    this.send({
      ...data,
      type: "ping"
    })
  }

}

module.exports = ReactiveServerConnection
